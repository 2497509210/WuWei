"""Exercise the PowerShell release entry point without networking or building."""
import json
import hashlib
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[2]
POWERSHELL = shutil.which("pwsh")


@unittest.skipUnless(POWERSHELL, "PowerShell 7 is required for deploy client tests")
class DeployClientTests(unittest.TestCase):
    def run_client(self, action):
        scratch = PROJECT / "tests" / ".tmp"
        scratch.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=scratch) as temporary:
            root = Path(temporary)
            wrapper = root / "test.ps1"
            log = root / "commands.jsonl"
            # Commands are external boundaries. Status/resume must never rebuild
            # or require the user's current working tree to match the release.
            script = r'''
$ErrorActionPreference = 'Stop'
function global:git { throw 'Status and Resume must not inspect the current checkout' }
function global:npm.cmd { throw 'Status and Resume must not build' }
function global:scp { throw 'Status and Resume must use the retained server package' }
function global:ssh {
    param([Parameter(ValueFromRemainingArguments=$true)][string[]]$NativeArgs)
    Add-Content -LiteralPath $env:DEPLOY_TEST_LOG -Value (ConvertTo-Json -InputObject $NativeArgs -Compress)
    $global:LASTEXITCODE = 0
    Write-Output "version=fixture`nstatus=succeeded`nphase=complete`nexit_code=0"
}
& $env:DEPLOY_TEST_SCRIPT -Version fixture -Action $env:DEPLOY_TEST_ACTION -WaitSeconds 0
'''
            wrapper.write_text(script, encoding="utf-8")
            result = subprocess.run([POWERSHELL, "-NoLogo", "-NoProfile", "-File", str(wrapper)],
                                    env={**os.environ, "DEPLOY_TEST_LOG": str(log),
                                         "DEPLOY_TEST_SCRIPT": str(PROJECT / "scripts" / "deploy.ps1"),
                                         "DEPLOY_TEST_ACTION": action}, text=True, encoding="utf-8", capture_output=True, timeout=15)
            calls = [json.loads(line) for line in log.read_text(encoding="utf-8-sig").splitlines()] if log.exists() else []
            return result, calls

    def test_status_queries_the_remote_job_without_rebuilding_or_reading_git(self):
        result, calls = self.run_client("Status")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue(any("status 'fixture'" in call[-1] for call in calls))
        self.assertIn("succeeded", result.stdout)

    def test_resume_uses_the_retained_package_without_the_original_checkout(self):
        result, calls = self.run_client("Resume")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue(any("resume 'fixture'" in call[-1] for call in calls))

    def run_cached_start(self, dirty=False, corrupted=False):
        scratch = PROJECT / "tests" / ".tmp"
        scratch.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=scratch) as temporary:
            root = Path(temporary)
            (root / "scripts").mkdir()
            shutil.copy2(PROJECT / "scripts" / "deploy.ps1", root / "scripts" / "deploy.ps1")
            (root / "scripts" / "remote-deploy.sh").write_text("# fixture\n")
            artifact = root / "tests" / ".tmp" / "releases" / "fixture"
            artifact.mkdir(parents=True)
            content = b"retained immutable archive"
            (artifact / "archive.tar.gz").write_bytes(content if not corrupted else b"tampered")
            (artifact / "identity.json").write_text(json.dumps({"revision": "a" * 40, "sha256": hashlib.sha256(content).hexdigest()}))
            wrapper = root / "test.ps1"
            log = root / "commands.jsonl"
            wrapper.write_text(r'''
$ErrorActionPreference = 'Stop'
function global:git {
    param([Parameter(ValueFromRemainingArguments=$true)][string[]]$NativeArgs)
    $global:LASTEXITCODE = 0
    if ($NativeArgs -contains 'rev-parse') { Write-Output ('a' * 40) }
    elseif ($env:DEPLOY_TEST_DIRTY -eq '1') { Write-Output ' M changed.py' }
}
function global:npm.cmd { throw 'A verified cached package must not be rebuilt' }
function global:scp {
    param([Parameter(ValueFromRemainingArguments=$true)][string[]]$NativeArgs)
    $global:LASTEXITCODE = 0
    Add-Content -LiteralPath $env:DEPLOY_TEST_LOG -Value (ConvertTo-Json -InputObject $NativeArgs -Compress)
}
function global:ssh {
    param([Parameter(ValueFromRemainingArguments=$true)][string[]]$NativeArgs)
    $global:LASTEXITCODE = 0
    Add-Content -LiteralPath $env:DEPLOY_TEST_LOG -Value (ConvertTo-Json -InputObject $NativeArgs -Compress)
    if ($NativeArgs[-1] -like 'mktemp*') { Write-Output '/tmp/wuwei-upload-fixture' }
    else { Write-Output "version=fixture`nstatus=succeeded`nphase=complete`nexit_code=0" }
}
& $env:DEPLOY_TEST_SCRIPT -Version fixture -WaitSeconds 0
''', encoding="utf-8")
            result = subprocess.run([POWERSHELL, "-NoLogo", "-NoProfile", "-File", str(wrapper)],
                                    env={**os.environ, "DEPLOY_TEST_LOG": str(log), "DEPLOY_TEST_DIRTY": "1" if dirty else "0",
                                         "DEPLOY_TEST_SCRIPT": str(root / "scripts" / "deploy.ps1")},
                                    text=True, encoding="utf-8", capture_output=True, timeout=15)
            calls = [json.loads(line) for line in log.read_text(encoding="utf-8-sig").splitlines()] if log.exists() else []
            return result, calls

    def test_start_reuses_the_identical_cached_package_after_an_upload_interruption(self):
        result, calls = self.run_cached_start()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue(any(call[0].endswith("archive.tar.gz") for call in calls))
        self.assertTrue(any("start 'fixture'" in call[-1] for call in calls))

    def test_start_still_rejects_dirty_source_and_tampered_cached_packages(self):
        for options in [{"dirty": True}, {"corrupted": True}]:
            with self.subTest(**options):
                result, calls = self.run_cached_start(**options)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
