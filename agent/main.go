package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/disk"
	"github.com/shirou/gopsutil/v4/host"
	"github.com/shirou/gopsutil/v4/load"
	"github.com/shirou/gopsutil/v4/mem"
	gnet "github.com/shirou/gopsutil/v4/net"
)

const version = "0.1.0"

type Config struct {
	Server          string   `json:"server"`
	Token           string   `json:"token"`
	IntervalSeconds int      `json:"intervalSeconds"`
	Services        []string `json:"services"`
}

type DiskMetric struct {
	Mount      string `json:"mount"`
	TotalBytes uint64 `json:"totalBytes"`
	UsedBytes  uint64 `json:"usedBytes"`
}

type NetworkMetric struct {
	Name    string `json:"name"`
	RxBytes uint64 `json:"rxBytes"`
	TxBytes uint64 `json:"txBytes"`
}

type ServiceMetric struct {
	Name  string `json:"name"`
	State string `json:"state"`
}

type Report struct {
	Timestamp        string          `json:"timestamp"`
	Hostname         string          `json:"hostname"`
	Platform         string          `json:"platform"`
	Version          string          `json:"version"`
	UptimeSeconds    uint64          `json:"uptimeSeconds"`
	CPUPercent       float64         `json:"cpuPercent"`
	MemoryTotalBytes uint64          `json:"memoryTotalBytes"`
	MemoryUsedBytes  uint64          `json:"memoryUsedBytes"`
	Load1            *float64        `json:"load1,omitempty"`
	Disks            []DiskMetric    `json:"disks"`
	Networks         []NetworkMetric `json:"networks"`
	Services         []ServiceMetric `json:"services,omitempty"`
}

type ProbeTask struct {
	Type            string            `json:"type"`
	MonitorID       string            `json:"monitorId"`
	Name            string            `json:"name"`
	IntervalSeconds int               `json:"intervalSeconds"`
	TimeoutSeconds  int               `json:"timeoutSeconds"`
	URL             string            `json:"url,omitempty"`
	Method          string            `json:"method,omitempty"`
	ExpectedStatus  int               `json:"expectedStatus,omitempty"`
	Headers         map[string]string `json:"headers,omitempty"`
	BaseURL         string            `json:"baseUrl,omitempty"`
	ChatPath        string            `json:"chatPath,omitempty"`
	Model           string            `json:"model,omitempty"`
	APIKey          string            `json:"apiKey,omitempty"`
	Prompt          string            `json:"prompt,omitempty"`
}

type ProbeResult struct {
	Type          string   `json:"type"`
	MonitorID     string   `json:"monitorId"`
	CheckedAt     string   `json:"checkedAt"`
	Success       bool     `json:"success"`
	StatusCode    *int     `json:"statusCode"`
	TTFBMs        *float64 `json:"ttfbMs"`
	TotalMs       *float64 `json:"totalMs"`
	ResponseValid bool     `json:"responseValid"`
	Balance       *float64 `json:"balance"`
	Error         *string  `json:"error"`
}

func main() {
	log.SetFlags(log.Ldate | log.Ltime | log.LUTC)
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}

	switch os.Args[1] {
	case "run":
		if err := runCommand(os.Args[2:]); err != nil {
			log.Fatal(err)
		}
	case "install":
		if err := installCommand(os.Args[2:]); err != nil {
			log.Fatal(err)
		}
	case "version", "--version", "-v":
		fmt.Println(version)
	default:
		usage()
		os.Exit(2)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "Usage: sysfnos-agent <run|install|version> [options]")
}

func defaultConfigPath() string {
	if runtime.GOOS == "windows" {
		return filepath.Join(os.Getenv("ProgramData"), "SysFNOS", "agent.json")
	}
	return "/etc/sysfnos-agent/agent.json"
}

func readConfig(path string) (Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Config{}, err
	}
	var config Config
	if err := json.Unmarshal(data, &config); err != nil {
		return Config{}, err
	}
	config.Server = strings.TrimRight(config.Server, "/")
	if config.Server == "" || config.Token == "" {
		return Config{}, errors.New("server and token are required")
	}
	if config.IntervalSeconds < 15 {
		config.IntervalSeconds = 30
	}
	return config, nil
}

func runCommand(args []string) error {
	flags := flag.NewFlagSet("run", flag.ContinueOnError)
	configPath := flags.String("config", defaultConfigPath(), "path to agent config")
	once := flags.Bool("once", false, "report once and exit")
	if err := flags.Parse(args); err != nil {
		return err
	}
	config, err := readConfig(*configPath)
	if err != nil {
		return fmt.Errorf("read config: %w", err)
	}

	client := &http.Client{}
	lastRuns := map[string]time.Time{}
	for {
		if err := reportOnce(client, config); err != nil {
			log.Printf("report failed: %v", err)
		} else {
			log.Printf("report accepted by %s", config.Server)
		}
		if err := runAssignedProbes(client, config, lastRuns); err != nil {
			log.Printf("probe sync failed: %v", err)
		}
		if *once {
			return nil
		}
		time.Sleep(time.Duration(config.IntervalSeconds) * time.Second)
	}
}

func collect(config Config) (Report, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	hostname, _ := os.Hostname()
	hostInfo, err := host.InfoWithContext(ctx)
	if err != nil {
		return Report{}, err
	}
	memory, err := mem.VirtualMemoryWithContext(ctx)
	if err != nil {
		return Report{}, err
	}
	cpuValues, err := cpu.PercentWithContext(ctx, time.Second, false)
	if err != nil {
		return Report{}, err
	}
	cpuPercent := 0.0
	if len(cpuValues) > 0 {
		cpuPercent = cpuValues[0]
	}

	report := Report{
		Timestamp:        time.Now().UTC().Format(time.RFC3339),
		Hostname:         hostname,
		Platform:         runtime.GOOS,
		Version:          version,
		UptimeSeconds:    hostInfo.Uptime,
		CPUPercent:       cpuPercent,
		MemoryTotalBytes: memory.Total,
		MemoryUsedBytes:  memory.Used,
		Disks:            []DiskMetric{},
		Networks:         []NetworkMetric{},
		Services:         []ServiceMetric{},
	}
	if average, loadErr := load.AvgWithContext(ctx); loadErr == nil {
		report.Load1 = &average.Load1
	}

	if partitions, partErr := disk.PartitionsWithContext(ctx, false); partErr == nil {
		seen := map[string]bool{}
		for _, partition := range partitions {
			if seen[partition.Mountpoint] {
				continue
			}
			usage, usageErr := disk.UsageWithContext(ctx, partition.Mountpoint)
			if usageErr != nil || usage.Total == 0 {
				continue
			}
			seen[partition.Mountpoint] = true
			report.Disks = append(report.Disks, DiskMetric{Mount: partition.Mountpoint, TotalBytes: usage.Total, UsedBytes: usage.Used})
		}
	}
	if counters, netErr := gnet.IOCountersWithContext(ctx, true); netErr == nil {
		for _, counter := range counters {
			report.Networks = append(report.Networks, NetworkMetric{Name: counter.Name, RxBytes: counter.BytesRecv, TxBytes: counter.BytesSent})
		}
	}
	for _, name := range config.Services {
		report.Services = append(report.Services, ServiceMetric{Name: name, State: serviceState(name)})
	}
	return report, nil
}

func serviceState(name string) string {
	var command *exec.Cmd
	if runtime.GOOS == "windows" {
		command = exec.Command("sc.exe", "query", name)
	} else {
		command = exec.Command("systemctl", "is-active", name)
	}
	output, err := command.CombinedOutput()
	text := strings.ToLower(string(output))
	if err == nil && (strings.Contains(text, "running") || strings.Contains(text, "active")) {
		return "running"
	}
	if strings.Contains(text, "stopped") || strings.Contains(text, "inactive") {
		return "stopped"
	}
	return "unknown"
}

func reportOnce(client *http.Client, config Config) error {
	report, err := collect(config)
	if err != nil {
		return err
	}
	payload, err := json.Marshal(report)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, config.Server+"/api/agent/report", bytes.NewReader(payload))
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+config.Token)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("User-Agent", "sysfnos-agent/"+version)
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusAccepted {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 1024))
		return fmt.Errorf("server returned %s: %s", response.Status, strings.TrimSpace(string(body)))
	}
	return nil
}

func runAssignedProbes(client *http.Client, config Config, lastRuns map[string]time.Time) error {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, config.Server+"/api/agent/tasks", nil)
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+config.Token)
	request.Header.Set("User-Agent", "sysfnos-agent/"+version)
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 1024))
		return fmt.Errorf("task server returned %s: %s", response.Status, strings.TrimSpace(string(body)))
	}
	var payload struct {
		Tasks []ProbeTask `json:"tasks"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 2*1024*1024)).Decode(&payload); err != nil {
		return err
	}

	for _, task := range payload.Tasks {
		key := task.Type + ":" + task.MonitorID
		interval := time.Duration(task.IntervalSeconds) * time.Second
		if interval < time.Minute {
			interval = time.Minute
		}
		if last, ok := lastRuns[key]; ok && time.Since(last) < interval {
			continue
		}
		lastRuns[key] = time.Now()
		var result ProbeResult
		if task.Type == "endpoint" {
			result = probeEndpoint(client, task)
		} else {
			result = probeAI(client, task)
		}
		if err := submitProbeResult(client, config, result); err != nil {
			log.Printf("submit probe %s failed: %v", task.Name, err)
		} else {
			log.Printf("probe %s completed success=%t", task.Name, result.Success)
		}
	}
	return nil
}

func probeEndpoint(client *http.Client, task ProbeTask) ProbeResult {
	result := ProbeResult{Type: "endpoint", MonitorID: task.MonitorID, CheckedAt: time.Now().UTC().Format(time.RFC3339)}
	started := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(task.TimeoutSeconds)*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, task.Method, task.URL, nil)
	if err != nil {
		setProbeError(&result, err, started)
		return result
	}
	for key, value := range task.Headers {
		request.Header.Set(key, value)
	}
	response, err := client.Do(request)
	if err != nil {
		setProbeError(&result, err, started)
		return result
	}
	ttfb := float64(time.Since(started).Microseconds()) / 1000
	result.TTFBMs = &ttfb
	result.StatusCode = &response.StatusCode
	_, readErr := io.Copy(io.Discard, io.LimitReader(response.Body, 2*1024*1024))
	response.Body.Close()
	total := float64(time.Since(started).Microseconds()) / 1000
	result.TotalMs = &total
	result.Success = readErr == nil && response.StatusCode == task.ExpectedStatus
	if readErr != nil {
		message := readErr.Error()
		result.Error = &message
	} else if !result.Success {
		message := fmt.Sprintf("expected HTTP %d, received %d", task.ExpectedStatus, response.StatusCode)
		result.Error = &message
	}
	return result
}

func probeAI(client *http.Client, task ProbeTask) ProbeResult {
	result := ProbeResult{Type: "ai", MonitorID: task.MonitorID, CheckedAt: time.Now().UTC().Format(time.RFC3339)}
	started := time.Now()
	body, _ := json.Marshal(map[string]any{
		"model":       task.Model,
		"messages":    []map[string]string{{"role": "user", "content": task.Prompt}},
		"max_tokens":  8,
		"temperature": 0,
		"stream":      true,
	})
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(task.TimeoutSeconds)*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(task.BaseURL, "/")+task.ChatPath, bytes.NewReader(body))
	if err != nil {
		setProbeError(&result, err, started)
		return result
	}
	request.Header.Set("Authorization", "Bearer "+task.APIKey)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "text/event-stream")
	response, err := client.Do(request)
	if err != nil {
		setProbeError(&result, err, started)
		return result
	}
	result.StatusCode = &response.StatusCode
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		data, _ := io.ReadAll(io.LimitReader(response.Body, 400))
		response.Body.Close()
		setProbeError(&result, fmt.Errorf("HTTP %d: %s", response.StatusCode, strings.TrimSpace(string(data))), started)
		return result
	}
	buffer := make([]byte, 16*1024)
	payload := make([]byte, 0, 32*1024)
	for {
		count, readErr := response.Body.Read(buffer)
		if count > 0 {
			if result.TTFBMs == nil {
				ttfb := float64(time.Since(started).Microseconds()) / 1000
				result.TTFBMs = &ttfb
			}
			payload = append(payload, buffer[:count]...)
			if len(payload) > 256*1024 {
				readErr = errors.New("streaming probe exceeded response limit")
			}
		}
		if readErr != nil {
			if !errors.Is(readErr, io.EOF) {
				message := readErr.Error()
				result.Error = &message
			}
			break
		}
	}
	response.Body.Close()
	total := float64(time.Since(started).Microseconds()) / 1000
	result.TotalMs = &total
	text := string(payload)
	result.ResponseValid = strings.Contains(text, "data:") && (strings.Contains(text, "[DONE]") || strings.Contains(text, "choices"))
	result.Success = result.Error == nil && result.ResponseValid
	if !result.ResponseValid && result.Error == nil {
		message := "response did not contain a valid SSE completion"
		result.Error = &message
	}
	return result
}

func setProbeError(result *ProbeResult, err error, started time.Time) {
	message := err.Error()
	if len(message) > 1000 {
		message = message[:1000]
	}
	result.Error = &message
	total := float64(time.Since(started).Microseconds()) / 1000
	result.TotalMs = &total
}

func submitProbeResult(client *http.Client, config Config, result ProbeResult) error {
	payload, err := json.Marshal(result)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, config.Server+"/api/agent/result", bytes.NewReader(payload))
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+config.Token)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("User-Agent", "sysfnos-agent/"+version)
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusAccepted {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 1024))
		return fmt.Errorf("result server returned %s: %s", response.Status, strings.TrimSpace(string(body)))
	}
	return nil
}

func installCommand(args []string) error {
	flags := flag.NewFlagSet("install", flag.ContinueOnError)
	server := flags.String("server", "", "SysFNOS server URL")
	token := flags.String("token", "", "one-time node enrollment token")
	interval := flags.Int("interval", 30, "report interval in seconds")
	services := flags.String("services", "", "comma-separated service names")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *server == "" || *token == "" {
		return errors.New("--server and --token are required")
	}
	config := Config{Server: strings.TrimRight(*server, "/"), Token: *token, IntervalSeconds: *interval}
	for _, service := range strings.Split(*services, ",") {
		if trimmed := strings.TrimSpace(service); trimmed != "" {
			config.Services = append(config.Services, trimmed)
		}
	}
	if runtime.GOOS == "windows" {
		return installWindows(config)
	}
	return installLinux(config)
}

func writeConfig(path string, config Config) error {
	payload, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, payload, 0600)
}

func copyExecutable(target string) error {
	source, err := os.Executable()
	if err != nil {
		return err
	}
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	output, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0755)
	if err != nil {
		return err
	}
	if _, err = io.Copy(output, input); err != nil {
		output.Close()
		return err
	}
	return output.Close()
}

func installWindows(config Config) error {
	directory := filepath.Join(os.Getenv("ProgramData"), "SysFNOS")
	if err := os.MkdirAll(directory, 0700); err != nil {
		return fmt.Errorf("create install directory (run as Administrator): %w", err)
	}
	executable := filepath.Join(directory, "sysfnos-agent.exe")
	configPath := filepath.Join(directory, "agent.json")
	if err := copyExecutable(executable); err != nil {
		return err
	}
	if err := writeConfig(configPath, config); err != nil {
		return err
	}
	_ = exec.Command("icacls.exe", directory, "/inheritance:r", "/grant:r", "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F").Run()
	taskCommand := fmt.Sprintf("\"%s\" run --config \"%s\"", executable, configPath)
	if output, err := exec.Command("schtasks.exe", "/Create", "/TN", "SysFNOS Agent", "/SC", "ONSTART", "/RU", "SYSTEM", "/RL", "HIGHEST", "/TR", taskCommand, "/F").CombinedOutput(); err != nil {
		return fmt.Errorf("create scheduled task: %w: %s", err, strings.TrimSpace(string(output)))
	}
	if output, err := exec.Command("schtasks.exe", "/Run", "/TN", "SysFNOS Agent").CombinedOutput(); err != nil {
		return fmt.Errorf("start scheduled task: %w: %s", err, strings.TrimSpace(string(output)))
	}
	fmt.Println("SysFNOS Agent installed and started")
	return nil
}

func installLinux(config Config) error {
	if os.Geteuid() != 0 {
		return errors.New("installation requires root; run with sudo")
	}
	directory := "/etc/sysfnos-agent"
	if err := os.MkdirAll(directory, 0700); err != nil {
		return err
	}
	executable := "/usr/local/bin/sysfnos-agent"
	configPath := filepath.Join(directory, "agent.json")
	if err := copyExecutable(executable); err != nil {
		return err
	}
	if err := writeConfig(configPath, config); err != nil {
		return err
	}
	unit := `[Unit]
Description=SysFNOS monitoring agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/sysfnos-agent run --config /etc/sysfnos-agent/agent.json
Restart=always
RestartSec=10
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
`
	if err := os.WriteFile("/etc/systemd/system/sysfnos-agent.service", []byte(unit), 0644); err != nil {
		return err
	}
	if output, err := exec.Command("systemctl", "daemon-reload").CombinedOutput(); err != nil {
		return fmt.Errorf("systemd reload: %w: %s", err, strings.TrimSpace(string(output)))
	}
	if output, err := exec.Command("systemctl", "enable", "--now", "sysfnos-agent.service").CombinedOutput(); err != nil {
		return fmt.Errorf("start service: %w: %s", err, strings.TrimSpace(string(output)))
	}
	fmt.Println("SysFNOS Agent installed and started")
	return nil
}
