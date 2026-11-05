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
$revision = (& git -C $workspace rev-parse --verify HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $revision -notmatch '^[0-9a-f]{40}([0-9a-f]{24})?$') { throw 'A committed Git revision is required for deployment' }
$changes = & git -C $workspace status --porcelain --untracked-files=normal
if ($LASTEXITCODE -ne 0 -or $changes) { throw 'Deployment requires a clean Git working tree; commit or remove pending changes first' }

Write-Host "== build frontend (base=/wuwei/) =="
$buildTmp = Join-Path $workspace 'tests\.tmp\esbuild'
New-Item -ItemType Directory -Force -Path $buildTmp | Out-Null
$env:VITE_BASE = "/wuwei/"
$env:ESBUILD_TMPDIR = $buildTmp
$env:TMP = $buildTmp
$env:TEMP = $buildTmp
Push-Location $frontend
try {
    npm.cmd ci
    npm.cmd run build
} finally {
    Pop-Location
}
$builtRevision = (& git -C $workspace rev-parse --verify HEAD).Trim()
$changes = & git -C $workspace status --porcelain --untracked-files=normal
if ($LASTEXITCODE -ne 0 -or $changes -or $builtRevision -ne $revision) { throw 'The Git working tree changed while building; build and deploy a clean committed revision' }
$revisionPath = Join-Path $buildTmp 'REVISION'
[System.IO.File]::WriteAllText($revisionPath, $revision + "`n", [System.Text.UTF8Encoding]::new($false))

Write-Host "== package =="
if (Test-Path -LiteralPath $tar) { throw "Release archive already exists: $tar" }
$packageArgs = @('-czf', $tar, '-C', $workspace,
    '--exclude=backend/.venv', '--exclude=backend/data',
    '--exclude=frontend/node_modules', '--exclude=__pycache__', '--exclude=.pytest_cache',
    'backend/app', 'backend/pyproject.toml', 'backend/uv.lock', 'backend/requirements.lock', 'backend/requirements-dev.lock',
    'frontend/dist', 'frontend/package.json', 'frontend/package-lock.json', 'scripts', 'deploy', 'README.md', 'docs',
    '-C', $buildTmp, 'REVISION')
tar @packageArgs

Write-Host "== upload =="
scp $tar "bd-a:/tmp/wuwei-$Version.tar.gz"
scp (Join-Path $workspace "scripts\remote-install.sh") "bd-a:/tmp/wuwei-remote-install.sh"

Write-Host "== remote install =="
ssh bd-a "sudo -n bash /tmp/wuwei-remote-install.sh '$Version' '/tmp/wuwei-$Version.tar.gz'"
