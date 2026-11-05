param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]*$')]
    [string]$Version
)

$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true
$workspace = Split-Path $PSScriptRoot -Parent
$frontend = Join-Path $workspace "frontend"
$tar = Join-Path $env:TEMP "wuwei-$Version.tar.gz"

Write-Host "== build frontend (base=/wuwei/) =="
$buildTmp = Join-Path (Split-Path $workspace -Parent) 'test\wuwei\.esbuild-tmp'
New-Item -ItemType Directory -Force -Path $buildTmp | Out-Null
$env:VITE_BASE = "/wuwei/"
$env:ESBUILD_TMPDIR = $buildTmp
$env:TMP = $buildTmp
$env:TEMP = $buildTmp
Push-Location $frontend
try {
    npm.cmd run build
} finally {
    Pop-Location
}

Write-Host "== package =="
if (Test-Path -LiteralPath $tar) { throw "Release archive already exists: $tar" }
$packageArgs = @('-czf', $tar, '-C', $workspace,
    '--exclude=backend/.venv', '--exclude=backend/data',
    '--exclude=frontend/node_modules', '--exclude=__pycache__', '--exclude=.pytest_cache',
    'backend/app', 'backend/pyproject.toml', 'frontend/dist', 'scripts', 'deploy', 'README.md', 'docs')
tar @packageArgs

Write-Host "== upload =="
scp $tar "bd-a:/tmp/wuwei-$Version.tar.gz"
scp (Join-Path $workspace "scripts\remote-install.sh") "bd-a:/tmp/wuwei-remote-install.sh"

Write-Host "== remote install =="
ssh bd-a "sudo -n bash /tmp/wuwei-remote-install.sh '$Version' '/tmp/wuwei-$Version.tar.gz'"
