param(
    [string]$AppUrl = "https://sys.example.com",
    [string]$NpmRegistry = "https://registry.npmjs.org/",
    [string]$GoProxy = "https://proxy.golang.org,direct",
    [switch]$Force
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $root ".env"
$secretDirectory = Join-Path $root "deploy\secrets"
$passwordPath = Join-Path $secretDirectory "initial_admin_password.txt"
$metricsPath = Join-Path $secretDirectory "metrics_token"

if ((Test-Path -LiteralPath $envPath) -and -not $Force) {
    throw ".env already exists. Use -Force only when intentionally replacing deployment secrets."
}

New-Item -ItemType Directory -Force -Path $secretDirectory | Out-Null

function New-RandomHex([int]$Bytes) {
    $buffer = [byte[]]::new($Bytes)
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $generator.GetBytes($buffer) } finally { $generator.Dispose() }
    return [BitConverter]::ToString($buffer).Replace("-", "").ToLowerInvariant()
}

function New-RandomToken([int]$Bytes) {
    $buffer = [byte[]]::new($Bytes)
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $generator.GetBytes($buffer) } finally { $generator.Dispose() }
    return [Convert]::ToBase64String($buffer).TrimEnd("=").Replace("+", "-").Replace("/", "_")
}

$encryptionKey = New-RandomHex 32
$metricsToken = New-RandomToken 36
$initialPassword = "Sfn-$(New-RandomToken 18)"
$lines = @(
    "APP_URL=$AppUrl",
    "NODE_ENV=production",
    "NPM_REGISTRY=$NpmRegistry",
    "GOPROXY=$GoProxy",
    "APP_ENCRYPTION_KEY=$encryptionKey",
    "ADMIN_INITIAL_USERNAME=root",
    "ADMIN_INITIAL_PASSWORD=$initialPassword",
    "METRICS_TOKEN=$metricsToken",
    "SMTP_HOST=",
    "SMTP_PORT=587",
    "SMTP_SECURE=false",
    "SMTP_USERNAME=",
    "SMTP_PASSWORD=",
    "SMTP_FROM=",
    "ALERT_RECIPIENTS="
)

[IO.File]::WriteAllLines($envPath, $lines, [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText($metricsPath, $metricsToken, [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText($passwordPath, $initialPassword, [Text.UTF8Encoding]::new($false))

"Deployment environment created. The one-time admin password is stored at: $passwordPath"
