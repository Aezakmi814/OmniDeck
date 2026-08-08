param(
    [string]$SshHost = "fnos",
    [string]$RemoteDirectory = "/vol1/docker/omnideck"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$runtimeDirectory = Join-Path $root "runtime"
$archive = Join-Path $runtimeDirectory "omnideck-deploy.tar.gz"

if (-not (Test-Path -LiteralPath (Join-Path $root ".env"))) {
    throw "Missing .env. Run scripts/prepare-deploy.ps1 first."
}
if (-not (Test-Path -LiteralPath (Join-Path $root "deploy\secrets\metrics_token"))) {
    throw "Missing deploy/secrets/metrics_token. Run scripts/prepare-deploy.ps1 first."
}

New-Item -ItemType Directory -Force -Path $runtimeDirectory | Out-Null
if (Test-Path -LiteralPath $archive) { Remove-Item -Force $archive }

tar.exe -czf $archive `
    --exclude=node_modules `
    --exclude=dist `
    --exclude=.git `
    --exclude=runtime `
    --exclude=output `
    --exclude=.playwright-cli `
    --exclude=agent/bin `
    --exclude=deploy/secrets/initial_admin_password.txt `
    -C $root .
if ($LASTEXITCODE -ne 0) { throw "Failed to create deployment archive." }

scp $archive "${SshHost}:/tmp/omnideck-deploy.tar.gz"
if ($LASTEXITCODE -ne 0) { throw "Failed to upload deployment archive." }

$command = "sudo mkdir -p '$RemoteDirectory' && sudo tar -xzf /tmp/omnideck-deploy.tar.gz -C '$RemoteDirectory' && sudo rm -f /tmp/omnideck-deploy.tar.gz && sudo chmod 600 '$RemoteDirectory/.env' && sudo chmod 644 '$RemoteDirectory/deploy/secrets/metrics_token' && cd '$RemoteDirectory' && sudo docker compose up -d --build"
ssh $SshHost $command
if ($LASTEXITCODE -ne 0) { throw "FNOS deployment failed." }

"OmniDeck deployed to ${SshHost}:$RemoteDirectory"
