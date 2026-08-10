param(
    [string]$SshHost = "fnos",
    [string]$RemoteDirectory = "/vol1/docker/omnideck",
    [string]$NtfyBaseUrl = "",
    [string]$NtfyProvisionerUrl = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$runtimeDirectory = Join-Path $root "runtime"
$archive = Join-Path $runtimeDirectory "omnideck-deploy.tar.gz"
$publisherSecret = Join-Path $root "deploy\secrets\ntfy_omnideck_publisher_token.txt"
$provisionerSecret = Join-Path $root "deploy\secrets\ntfy_omnideck_provisioner_key.txt"

function Get-DotEnvValue([string]$Name) {
    foreach ($line in [System.IO.File]::ReadAllLines((Join-Path $root ".env"))) {
        if ($line.StartsWith("$Name=")) {
            return $line.Substring($Name.Length + 1).Trim().Trim('"').Trim("'")
        }
    }
    return ""
}

function Assert-DeploymentUrl([string]$Name, [string]$Value, [bool]$RequireHttps) {
    $uri = $null
    $valid = [Uri]::TryCreate($Value, [UriKind]::Absolute, [ref]$uri)
    $allowedScheme = $valid -and ($uri.Scheme -eq "https" -or (-not $RequireHttps -and $uri.Scheme -eq "http"))
    if (-not $allowedScheme -or $uri.UserInfo -or $Value -match '[\s''";&|<>]') {
        $scheme = if ($RequireHttps) { "HTTPS" } else { "HTTP(S)" }
        throw "$Name must be an absolute $scheme URL without credentials."
    }
}

if (-not (Test-Path -LiteralPath (Join-Path $root ".env"))) {
    throw "Missing .env. Run scripts/prepare-deploy.ps1 first."
}
if (-not (Test-Path -LiteralPath (Join-Path $root "deploy\secrets\metrics_token"))) {
    throw "Missing deploy/secrets/metrics_token. Run scripts/prepare-deploy.ps1 first."
}
$hasPublisherSecret = Test-Path -LiteralPath $publisherSecret
$hasProvisionerSecret = Test-Path -LiteralPath $provisionerSecret
if ($hasPublisherSecret -xor $hasProvisionerSecret) {
    throw "Both ntfy publisher and Provisioner secret files are required."
}
$ntfyEnabled = $hasPublisherSecret -and $hasProvisionerSecret
if ($ntfyEnabled) {
    if (-not $NtfyBaseUrl) { $NtfyBaseUrl = Get-DotEnvValue "NTFY_BASE_URL" }
    if (-not $NtfyProvisionerUrl) { $NtfyProvisionerUrl = Get-DotEnvValue "NTFY_PROVISIONER_URL" }
    Assert-DeploymentUrl "NTFY_BASE_URL" $NtfyBaseUrl $true
    Assert-DeploymentUrl "NTFY_PROVISIONER_URL" $NtfyProvisionerUrl $false
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
    --exclude=deploy/secrets `
    -C $root .
if ($LASTEXITCODE -ne 0) { throw "Failed to create deployment archive." }

$remoteStage = "/tmp/omnideck-$([guid]::NewGuid().ToString('N'))"
$stageCreated = $false
try {
    ssh $SshHost "umask 077; mkdir -- '$remoteStage'; chmod 700 '$remoteStage'"
    if ($LASTEXITCODE -ne 0) { throw "Failed to create the remote staging directory." }
    $stageCreated = $true

    scp $archive "${SshHost}:$remoteStage/deploy.tar.gz"
    if ($LASTEXITCODE -ne 0) { throw "Failed to upload deployment archive." }
    scp (Join-Path $root "deploy\secrets\metrics_token") "${SshHost}:$remoteStage/metrics-token"
    if ($LASTEXITCODE -ne 0) { throw "Failed to upload the metrics secret." }

    $ntfyOverride = ""
    $ntfyPrepare = ""
    $deploymentMode = "base"
    if ($ntfyEnabled) {
        $ntfyOverride = " -f compose.ntfy.yaml"
        $deploymentMode = "ntfy"
        scp $publisherSecret "${SshHost}:$remoteStage/ntfy-publisher-token"
        if ($LASTEXITCODE -ne 0) { throw "Failed to upload the ntfy publisher secret." }
        scp $provisionerSecret "${SshHost}:$remoteStage/ntfy-provisioner-key"
        if ($LASTEXITCODE -ne 0) { throw "Failed to upload the ntfy provisioner secret." }
        $ntfyPrepare = " && sudo sh '$RemoteDirectory/deploy/fnos/configure-notifications.sh' '$RemoteDirectory' '$remoteStage' '$NtfyBaseUrl' '$NtfyProvisionerUrl'"
    }

    $backupRoot = "$RemoteDirectory-backups"
    $prepare = "sudo mkdir -p '$RemoteDirectory/deploy/secrets' && sudo tar -xzf '$remoteStage/deploy.tar.gz' -C '$RemoteDirectory' && sudo find '$RemoteDirectory/deploy' -type f -name '*.sh' -exec sed -i 's/\r//' {} + && sudo install -m 644 '$remoteStage/metrics-token' '$RemoteDirectory/deploy/secrets/metrics_token' && sudo chmod 600 '$RemoteDirectory/.env'$ntfyPrepare && cd '$RemoteDirectory' && sudo docker compose -f compose.yaml$ntfyOverride build app"
    $start = "cd '$RemoteDirectory' && sudo docker compose -f compose.yaml$ntfyOverride up -d"
    $command = @'
set -eu; test $(stat -c '%U:%a' '__REMOTE_STAGE__') = $(id -un):700; sudo mkdir -p '__REMOTE_DIRECTORY__'; app=''; if test -f '__REMOTE_DIRECTORY__/compose.yaml'; then app=$(sudo docker compose -f '__REMOTE_DIRECTORY__/compose.yaml' --project-directory '__REMOTE_DIRECTORY__' ps -q --all app); fi; if test -z "$app"; then (__PREPARE__) && (__START__); exit $?; fi; stamp=$(date +%Y%m%d-%H%M%S); backup='__BACKUP_ROOT__/v0.3-'$stamp; rollback=omnideck/app:rollback-$stamp; sudo install -d -m 700 "$backup"; image=$(sudo docker inspect --format '{{.Image}}' "$app"); sudo docker image tag "$image" "$rollback"; config_labels=$(sudo docker inspect --format '{{json .Config.Labels}}' "$app"); case "$config_labels" in *compose.ntfy.yaml*) sudo touch "$backup/compose-mode-ntfy" ;; esac; sudo tar --exclude=node_modules --exclude=runtime --exclude=output --exclude=.git -czf "$backup/source.tar.gz" -C '__REMOTE_DIRECTORY__' .; if ! (__PREPARE__); then sudo tar -xzf "$backup/source.tar.gz" -C '__REMOTE_DIRECTORY__'; exit 1; fi; sudo sh '__REMOTE_DIRECTORY__/deploy/fnos/switch-production.sh' '__REMOTE_DIRECTORY__' "$backup" "$rollback" '__DEPLOYMENT_MODE__'
'@
    $command = $command.Replace("__REMOTE_STAGE__", $remoteStage).Replace("__BACKUP_ROOT__", $backupRoot).Replace("__REMOTE_DIRECTORY__", $RemoteDirectory).Replace("__PREPARE__", $prepare).Replace("__START__", $start).Replace("__DEPLOYMENT_MODE__", $deploymentMode)
    ssh $SshHost $command
    if ($LASTEXITCODE -ne 0) { throw "FNOS deployment failed." }
} finally {
    if ($stageCreated) {
        ssh $SshHost "rm -rf -- '$remoteStage'" | Out-Null
    }
    if (Test-Path -LiteralPath $archive) { Remove-Item -Force $archive }
}

"OmniDeck deployed to ${SshHost}:$RemoteDirectory"
