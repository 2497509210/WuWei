param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]*$')]
    [string]$Version,
    [ValidateSet('Start', 'Status', 'Resume')]
    [string]$Action = 'Start',
    [ValidateRange(0, 3600)]
    [int]$WaitSeconds = 120,
    [ValidateRange(0, 200)]
    [int]$LogLines = 0
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$workspace = Split-Path $PSScriptRoot -Parent
$remoteControl = "/opt/wuwei/deployments/$Version/remote-deploy.sh"

function Read-ReleaseState {
    $lines = & ssh bd-a "sudo -n bash '$remoteControl' status '$Version'"
    if ($LASTEXITCODE -ne 0) { throw 'Cannot read remote deployment status; rerun Status when the connection recovers.' }
    return ConvertFrom-StringData ($lines -join "`n")
}

function Show-ReleaseState($State) {
    Write-Host ("Release {0}: {1}, phase={2}, exit={3}" -f $Version, $State.status, $State.phase, $State.exit_code)
    if ($State.log) { Write-Host ("Remote log: {0}" -f $State.log) }
}

if ($Action -eq 'Start') {
    $revision = (& git -C $workspace rev-parse --verify HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $revision -notmatch '^[0-9a-f]{40}([0-9a-f]{24})?$') { throw 'A committed Git revision is required for deployment' }
    $changes = & git -C $workspace status --porcelain --untracked-files=normal
    if ($LASTEXITCODE -ne 0 -or $changes) { throw 'Deployment requires a clean Git working tree; commit or remove pending changes first' }
    $artifactDirectory = Join-Path $workspace "tests/.tmp/releases/$Version"
    $archivePath = Join-Path $artifactDirectory 'archive.tar.gz'
    $identityPath = Join-Path $artifactDirectory 'identity.json'
    New-Item -ItemType Directory -Force -Path $artifactDirectory | Out-Null
    if (Test-Path -LiteralPath $identityPath) {
        $identity = Get-Content -LiteralPath $identityPath -Raw | ConvertFrom-Json
        if ($identity.revision -ne $revision -or -not (Test-Path -LiteralPath $archivePath) -or
            (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $identity.sha256) {
            throw 'The retained local package has a different identity. Use Resume for the existing remote job, or a new version for changed code.'
        }
        $archiveSha = $identity.sha256
        Write-Host '== reuse the verified release package =='
    } else {
        Write-Host '== build frontend (base=/wuwei/) =='
        $buildTmp = Join-Path $workspace 'tests/.tmp/esbuild'
        New-Item -ItemType Directory -Force -Path $buildTmp | Out-Null
        $env:VITE_BASE = '/wuwei/'
        $env:ESBUILD_TMPDIR = $buildTmp
        $env:TMP = $buildTmp
        $env:TEMP = $buildTmp
        Push-Location (Join-Path $workspace 'frontend')
        try {
            npm.cmd ci
            npm.cmd run build
        } finally {
            Pop-Location
        }
        $builtRevision = (& git -C $workspace rev-parse --verify HEAD).Trim()
        $changes = & git -C $workspace status --porcelain --untracked-files=normal
        if ($LASTEXITCODE -ne 0 -or $changes -or $builtRevision -ne $revision) { throw 'The Git working tree changed while building; build and deploy a clean committed revision' }
        $revisionPath = Join-Path $artifactDirectory 'REVISION'
        [System.IO.File]::WriteAllText($revisionPath, $revision + "`n", [System.Text.UTF8Encoding]::new($false))
        $temporaryArchive = Join-Path $artifactDirectory (([guid]::NewGuid().ToString('N')) + '.tar.gz.tmp')
        $packageArgs = @('-czf', $temporaryArchive, '-C', $workspace,
            '--exclude=backend/.venv', '--exclude=backend/data',
            '--exclude=frontend/node_modules', '--exclude=__pycache__', '--exclude=.pytest_cache',
            'backend/app', 'backend/pyproject.toml', 'backend/uv.lock', 'backend/requirements.lock', 'backend/requirements-dev.lock',
            'frontend/dist', 'frontend/package.json', 'frontend/package-lock.json', 'scripts', 'deploy', 'README.md', 'docs',
            '-C', $artifactDirectory, 'REVISION')
        tar @packageArgs
        # Both paths are fixed children of the release artifact directory.
        Move-Item -LiteralPath $temporaryArchive -Destination $archivePath -Force
        $archiveSha = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
        @{ revision = $revision; sha256 = $archiveSha } | ConvertTo-Json | Set-Content -LiteralPath $identityPath -Encoding utf8
    }
    Write-Host '== upload and start a detached deployment =='
    $uploadDirectory = (& ssh bd-a 'mktemp -d /tmp/wuwei-upload-XXXXXXXX').Trim()
    if ($LASTEXITCODE -ne 0 -or $uploadDirectory -notmatch '^/tmp/wuwei-upload-[A-Za-z0-9]+$') { throw 'Could not create the remote upload directory' }
    scp $archivePath "bd-a:$uploadDirectory/archive.tar.gz"
    scp (Join-Path $workspace 'scripts/remote-deploy.sh') "bd-a:$uploadDirectory/remote-deploy.sh"
    & ssh bd-a "sudo -n bash '$uploadDirectory/remote-deploy.sh' start '$Version' '$uploadDirectory/archive.tar.gz' '$archiveSha' '$revision'"
} elseif ($Action -eq 'Resume') {
    & ssh bd-a "sudo -n bash '$remoteControl' resume '$Version'"
}

$state = Read-ReleaseState
Show-ReleaseState $state
if ($Action -ne 'Status') {
    $timer = [System.Diagnostics.Stopwatch]::StartNew()
    while ($state.status -eq 'running' -and $timer.Elapsed.TotalSeconds -lt $WaitSeconds) {
        Start-Sleep -Seconds ([Math]::Min(5, [Math]::Max(1, $WaitSeconds - [int]$timer.Elapsed.TotalSeconds)))
        $state = Read-ReleaseState
        Show-ReleaseState $state
    }
}
if ($LogLines -gt 0) {
    & ssh bd-a "sudo -n bash '$remoteControl' logs '$Version' '$LogLines'"
}
if ($state.status -in @('failed', 'interrupted')) {
    throw "Deployment $($state.status); inspect with -Action Status -LogLines 60, then use -Action Resume."
}
if ($state.status -eq 'running') {
    Write-Host 'The server continues independently. Use -Action Status to inspect it; closing this terminal does not cancel deployment.'
}
