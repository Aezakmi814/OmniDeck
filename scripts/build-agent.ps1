param(
    [ValidateSet("windows", "linux")]
    [string]$TargetOS = "windows",
    [ValidateSet("amd64", "arm64")]
    [string]$TargetArch = "amd64"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$outputDirectory = Join-Path $root "agent\bin"
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
$extension = if ($TargetOS -eq "windows") { ".exe" } else { "" }
$output = Join-Path $outputDirectory "sysfnos-agent-$TargetOS-$TargetArch$extension"

docker buildx build `
    --file (Join-Path $root "agent\Dockerfile") `
    --build-arg "TARGETOS=$TargetOS" `
    --build-arg "TARGETARCH=$TargetArch" `
    --output "type=local,dest=$outputDirectory\artifact" `
    (Join-Path $root "agent")

Move-Item -Force (Join-Path $outputDirectory "artifact\sysfnos-agent") $output
Remove-Item -Recurse -Force (Join-Path $outputDirectory "artifact")
$output
