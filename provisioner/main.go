package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"time"
)

const maxBodyBytes = 32 * 1024

var (
	usernamePattern = regexp.MustCompile(`^omni_u_[a-z0-9]{8,40}$`)
	topicPattern    = regexp.MustCompile(`^omni-user-[a-z0-9]{16,64}$`)
	tokenPattern    = regexp.MustCompile(`tk_[A-Za-z0-9_-]+`)
)

type provisionRequest struct {
	Operation  string `json:"operation"`
	Username   string `json:"username"`
	Topic      string `json:"topic,omitempty"`
	Password   string `json:"password,omitempty"`
	DeviceName string `json:"deviceName,omitempty"`
	Token      string `json:"token,omitempty"`
	Expires    string `json:"expires,omitempty"`
	RequestID  string `json:"requestId,omitempty"`
}

type provisionResponse struct {
	Token     string `json:"token,omitempty"`
	ExpiresAt string `json:"expiresAt,omitempty"`
	Error     string `json:"error,omitempty"`
}

type commandRunner interface {
	Run(env []string, args ...string) ([]byte, error)
}

type ntfyRunner struct {
	bin    string
	config string
	auth   string
}

func (r ntfyRunner) Run(env []string, args ...string) ([]byte, error) {
	if len(args) == 0 {
		return nil, errors.New("ntfy command is required")
	}
	commandArgs := []string{args[0], "--config", r.config, "--auth-file", r.auth}
	commandArgs = append(commandArgs, args[1:]...)
	command := exec.Command(r.bin, commandArgs...)
	command.Env = append(os.Environ(), env...)
	output, err := command.CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("ntfy command failed: %w: %s", err, sanitizeOutput(string(output)))
	}
	return output, nil
}

type server struct {
	sharedKey   string
	runner      commandRunner
	nonces      map[string]time.Time
	mu          sync.Mutex
	operationMu sync.Mutex
	now         func() time.Time
}

func main() {
	sharedKey, err := loadSecret("OMNIDECK_PROVISIONER_KEY", "OMNIDECK_PROVISIONER_KEY_FILE")
	if err != nil {
		log.Fatal(err)
	}
	if len(sharedKey) < 32 {
		log.Fatal("OMNIDECK_PROVISIONER_KEY must contain at least 32 characters")
	}
	listen := envOrDefault("LISTEN_ADDR", "127.0.0.1:2671")
	instance := &server{
		sharedKey: sharedKey,
		runner: ntfyRunner{
			bin:    envOrDefault("NTFY_BIN", "/usr/local/bin/ntfy"),
			config: envOrDefault("NTFY_CONFIG", "/opt/ntfy/server.yml"),
			auth:   envOrDefault("NTFY_AUTH_FILE", "/opt/ntfy/data/auth.db"),
		},
		nonces: make(map[string]time.Time),
		now:    time.Now,
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "version": "0.2.0"})
	})
	mux.HandleFunc("POST /v1/provision", instance.handleProvision)

	httpServer := &http.Server{
		Addr:              listen,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	log.Printf("OmniDeck ntfy provisioner listening on %s", listen)
	if err := httpServer.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

func (s *server) handleProvision(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBodyBytes))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, provisionResponse{Error: "request body is too large"})
		return
	}
	if err := s.authenticate(r, body); err != nil {
		writeJSON(w, http.StatusUnauthorized, provisionResponse{Error: err.Error()})
		return
	}
	var request provisionRequest
	if err := json.Unmarshal(body, &request); err != nil {
		writeJSON(w, http.StatusBadRequest, provisionResponse{Error: "invalid JSON request"})
		return
	}
	if err := validateRequest(request); err != nil {
		writeJSON(w, http.StatusBadRequest, provisionResponse{Error: err.Error()})
		return
	}
	s.operationMu.Lock()
	defer s.operationMu.Unlock()
	result, err := s.execute(request)
	if err != nil {
		log.Printf("operation=%s username=%s failed: %v", request.Operation, request.Username, err)
		writeJSON(w, http.StatusBadGateway, provisionResponse{Error: err.Error()})
		return
	}
	log.Printf("operation=%s username=%s completed", request.Operation, request.Username)
	writeJSON(w, http.StatusOK, result)
}

func (s *server) authenticate(r *http.Request, body []byte) error {
	timestampValue := r.Header.Get("X-Omni-Timestamp")
	nonce := r.Header.Get("X-Omni-Nonce")
	signature := r.Header.Get("X-Omni-Signature")
	if timestampValue == "" || len(nonce) < 16 || signature == "" {
		return errors.New("missing authentication headers")
	}
	timestamp, err := time.Parse(time.RFC3339, timestampValue)
	if err != nil {
		unixSeconds, parseErr := parseUnix(timestampValue)
		if parseErr != nil {
			return errors.New("invalid timestamp")
		}
		timestamp = time.Unix(unixSeconds, 0)
	}
	now := s.now()
	if timestamp.Before(now.Add(-5*time.Minute)) || timestamp.After(now.Add(5*time.Minute)) {
		return errors.New("request timestamp is outside the allowed window")
	}
	expected := hmac.New(sha256.New, []byte(s.sharedKey))
	expected.Write([]byte(timestampValue + "\n" + nonce + "\n"))
	expected.Write(body)
	actual, err := hex.DecodeString(signature)
	if err != nil || !hmac.Equal(actual, expected.Sum(nil)) {
		return errors.New("invalid request signature")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for value, expiresAt := range s.nonces {
		if expiresAt.Before(now) {
			delete(s.nonces, value)
		}
	}
	if _, exists := s.nonces[nonce]; exists {
		return errors.New("request nonce has already been used")
	}
	s.nonces[nonce] = now.Add(10 * time.Minute)
	return nil
}

func (s *server) execute(request provisionRequest) (provisionResponse, error) {
	expires := request.Expires
	if expires == "" {
		expires = "8760h"
	}
	switch request.Operation {
	case "provision":
		exists, err := s.userExists(request.Username)
		if err != nil {
			return provisionResponse{}, err
		}
		if exists {
			if request.RequestID != "" {
				result, found, err := s.findRequestToken(request.Username, expires, request.RequestID)
				if err != nil {
					return provisionResponse{}, err
				}
				if found {
					return result, nil
				}
			}
			if _, err := s.runner.Run(nil, "user", "remove", request.Username); err != nil {
				return provisionResponse{}, fmt.Errorf("stale user removal failed: %w", err)
			}
		}
		if _, err := s.runner.Run([]string{"NTFY_PASSWORD=" + request.Password}, "user", "add", request.Username); err != nil {
			return provisionResponse{}, fmt.Errorf("user creation failed: %w", err)
		}
		cleanup := true
		defer func() {
			if cleanup {
				_, _ = s.runner.Run(nil, "user", "remove", request.Username)
			}
		}()
		if _, err := s.runner.Run(nil, "access", request.Username, request.Topic, "read-only"); err != nil {
			return provisionResponse{}, fmt.Errorf("subscriber ACL failed: %w", err)
		}
		result, err := s.createToken(request.Username, expires, request.RequestID)
		if err != nil {
			return provisionResponse{}, err
		}
		cleanup = false
		return result, nil
	case "add-device":
		return s.createToken(request.Username, expires, request.RequestID)
	case "revoke-device":
		output, err := s.runner.Run(nil, "token", "list", request.Username)
		if err != nil {
			return provisionResponse{}, err
		}
		if !strings.Contains(string(output), request.Token) {
			return provisionResponse{}, nil
		}
		_, err = s.runner.Run(nil, "token", "remove", request.Username, request.Token)
		return provisionResponse{}, err
	case "disable-account":
		exists, err := s.userExists(request.Username)
		if err != nil || !exists {
			return provisionResponse{}, err
		}
		_, err = s.runner.Run(nil, "user", "remove", request.Username)
		return provisionResponse{}, err
	default:
		return provisionResponse{}, errors.New("unsupported operation")
	}
}

func (s *server) userExists(username string) (bool, error) {
	output, err := s.runner.Run(nil, "user", "list")
	if err != nil {
		return false, fmt.Errorf("user listing failed: %w", err)
	}
	return strings.Contains(string(output), "user "+username+" ("), nil
}

func (s *server) createToken(username, expires, requestID string) (provisionResponse, error) {
	label := "omnideck-device"
	if requestID != "" {
		label = "omnideck-" + requestID
		if result, found, err := s.findRequestToken(username, expires, requestID); err != nil {
			return provisionResponse{}, err
		} else if found {
			return result, nil
		}
	}
	output, err := s.runner.Run(nil, "token", "add", "--expires="+expires, "--label="+label, username)
	if err != nil {
		return provisionResponse{}, fmt.Errorf("token creation failed: %w", err)
	}
	token := tokenPattern.FindString(string(output))
	if token == "" {
		return provisionResponse{}, errors.New("ntfy token output did not contain a token")
	}
	duration, err := time.ParseDuration(expires)
	if err != nil {
		return provisionResponse{}, errors.New("invalid token expiry")
	}
	return provisionResponse{Token: token, ExpiresAt: s.now().Add(duration).UTC().Format(time.RFC3339)}, nil
}

func (s *server) findRequestToken(username, expires, requestID string) (provisionResponse, bool, error) {
	output, err := s.runner.Run(nil, "token", "list", username)
	if err != nil {
		return provisionResponse{}, false, fmt.Errorf("token listing failed: %w", err)
	}
	label := "omnideck-" + requestID
	for _, line := range strings.Split(string(output), "\n") {
		if strings.Contains(line, "("+label+")") {
			if token := tokenPattern.FindString(line); token != "" {
				duration, _ := time.ParseDuration(expires)
				return provisionResponse{Token: token, ExpiresAt: s.now().Add(duration).UTC().Format(time.RFC3339)}, true, nil
			}
		}
	}
	return provisionResponse{}, false, nil
}

func validateRequest(request provisionRequest) error {
	if !usernamePattern.MatchString(request.Username) {
		return errors.New("invalid managed username")
	}
	switch request.Operation {
	case "provision":
		if !topicPattern.MatchString(request.Topic) {
			return errors.New("invalid managed topic")
		}
		if len(request.Password) < 24 || len(request.Password) > 200 {
			return errors.New("invalid generated password")
		}
	case "add-device", "disable-account":
	case "revoke-device":
		if !tokenPattern.MatchString(request.Token) || tokenPattern.FindString(request.Token) != request.Token {
			return errors.New("invalid ntfy token")
		}
	default:
		return errors.New("unsupported operation")
	}
	if request.Expires != "" {
		duration, err := time.ParseDuration(request.Expires)
		if err != nil || duration < time.Hour || duration > 366*24*time.Hour {
			return errors.New("token expiry must be between one hour and 366 days")
		}
	}
	if request.RequestID != "" {
		validRequestID := regexp.MustCompile(`^[A-Za-z0-9-]{8,80}$`)
		if !validRequestID.MatchString(request.RequestID) {
			return errors.New("invalid request ID")
		}
	}
	return nil
}

func loadSecret(valueName, fileName string) (string, error) {
	if value := strings.TrimSpace(os.Getenv(valueName)); value != "" {
		return value, nil
	}
	path := strings.TrimSpace(os.Getenv(fileName))
	if path == "" {
		return "", fmt.Errorf("%s or %s is required", valueName, fileName)
	}
	value, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read secret file: %w", err)
	}
	return strings.TrimSpace(string(value)), nil
}

func envOrDefault(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func parseUnix(value string) (int64, error) {
	var result int64
	_, err := fmt.Sscan(value, &result)
	return result, err
}

func sanitizeOutput(value string) string {
	return tokenPattern.ReplaceAllString(strings.TrimSpace(value), "[redacted-token]")
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
