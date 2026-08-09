package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type fakeRunner struct {
	calls     [][]string
	userList  string
	tokenList string
}

func (f *fakeRunner) Run(_ []string, args ...string) ([]byte, error) {
	f.calls = append(f.calls, args)
	if len(args) >= 2 && args[0] == "user" && args[1] == "list" {
		if f.userList != "" {
			return []byte(f.userList), nil
		}
		return []byte("user admin (role: admin)"), nil
	}
	if len(args) >= 2 && args[0] == "token" && args[1] == "list" {
		return []byte(f.tokenList), nil
	}
	if len(args) >= 2 && args[0] == "token" && args[1] == "add" {
		return []byte("token: tk_abcdefghijklmnopqrstuvwxyz123456"), nil
	}
	return []byte("ok"), nil
}

func TestProvisionRetryReturnsRequestTokenWithoutReplacingUser(t *testing.T) {
	const token = "tk_abcdefghijklmnopqrstuvwxyz123456"
	runner := &fakeRunner{
		userList:  "user omni_u_abcdefgh (role: user)",
		tokenList: "token " + token + " (omnideck-request-123)",
	}
	s := &server{runner: runner, now: func() time.Time { return time.Unix(1000, 0) }}
	result, err := s.execute(provisionRequest{
		Operation: "provision", Username: "omni_u_abcdefgh", Topic: "omni-user-abcdefghijklmnop",
		Password: strings.Repeat("x", 24), Expires: "8760h", RequestID: "request-123",
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Token != token {
		t.Fatalf("unexpected token %q", result.Token)
	}
	if len(runner.calls) != 2 || strings.Join(runner.calls[1], " ") != "token list omni_u_abcdefgh" {
		t.Fatalf("retry replaced the existing user: %v", runner.calls)
	}
}

func TestProvisionUsesOfficialCommands(t *testing.T) {
	runner := &fakeRunner{}
	s := &server{runner: runner, now: func() time.Time { return time.Unix(1000, 0) }}
	result, err := s.execute(provisionRequest{Operation: "provision", Username: "omni_u_abcdefgh", Topic: "omni-user-abcdefghijklmnop", Password: strings.Repeat("x", 24), Expires: "8760h"})
	if err != nil {
		t.Fatal(err)
	}
	if result.Token != "tk_abcdefghijklmnopqrstuvwxyz123456" {
		t.Fatalf("unexpected token %q", result.Token)
	}
	if len(runner.calls) != 4 {
		t.Fatalf("expected 4 CLI calls, got %d", len(runner.calls))
	}
	if strings.Join(runner.calls[0], " ") != "user list" {
		t.Fatalf("unexpected first command: %v", runner.calls[0])
	}
	if strings.Join(runner.calls[2], " ") != "access omni_u_abcdefgh omni-user-abcdefghijklmnop read-only" {
		t.Fatalf("unexpected subscriber ACL: %v", runner.calls[2])
	}
}

func TestAuthenticationRejectsReplay(t *testing.T) {
	now := time.Unix(2000, 0)
	s := &server{sharedKey: strings.Repeat("k", 32), nonces: map[string]time.Time{}, now: func() time.Time { return now }}
	body, _ := json.Marshal(provisionRequest{Operation: "add-device", Username: "omni_u_abcdefgh"})
	timestamp := "2000"
	nonce := "abcdefghijklmnop"
	mac := hmac.New(sha256.New, []byte(s.sharedKey))
	mac.Write([]byte(timestamp + "\n" + nonce + "\n"))
	mac.Write(body)
	request := httptest.NewRequest("POST", "/v1/provision", strings.NewReader(string(body)))
	request.Header.Set("X-Omni-Timestamp", timestamp)
	request.Header.Set("X-Omni-Nonce", nonce)
	request.Header.Set("X-Omni-Signature", hex.EncodeToString(mac.Sum(nil)))
	if err := s.authenticate(request, body); err != nil {
		t.Fatal(err)
	}
	if err := s.authenticate(request, body); err == nil || !strings.Contains(err.Error(), "already") {
		t.Fatalf("expected replay error, got %v", err)
	}
}

func TestValidationRejectsUnmanagedNames(t *testing.T) {
	err := validateRequest(provisionRequest{Operation: "disable-account", Username: "admin"})
	if err == nil {
		t.Fatal("expected validation error")
	}
}
