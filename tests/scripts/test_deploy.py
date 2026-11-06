"""Run the actual release installer against a disposable local command sandbox.

External systemd/user/network/package operations are faked at executable boundaries;
the installer still extracts its archive, creates a distinct environment, chooses
units, performs preflight/backup sequencing and rolls back its current release.
"""
from pathlib import Path
import os
import shutil
import subprocess
import tarfile
import tempfile
import unittest
import hashlib
import time


PROJECT = Path(__file__).resolve().parents[2]
BASH = shutil.which("bash")
if not BASH:
    git = shutil.which("git")
    candidate = Path(git).parent.parent / "bin" / "bash.exe" if git else None
    if candidate and candidate.is_file():
        BASH = str(candidate)


def shell_path(path):
    value = str(path).replace("\\", "/")
    return "/" + value[0].lower() + value[2:] if len(value) > 2 and value[1] == ":" else value


@unittest.skipUnless(BASH, "Bash is required for the installer integration sandbox")
class DeploymentTests(unittest.TestCase):
    def setUp(self):
        temporary_root = PROJECT / "tests" / ".tmp"
        temporary_root.mkdir(exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(prefix="wuwei-release-", dir=temporary_root)
        self.root = Path(self.temporary.name)
        self.bin = self.root / "commands"
        self.bin.mkdir()
        self.prefix = self.root / "application"
        self.previous = self.prefix / "releases" / "previous"
        (self.previous / ".venv" / "bin").mkdir(parents=True)
        (self.previous / "deploy").mkdir()
        self.previous_service = "[Service]\nExecStart=old-release-environment\n"
        (self.previous / "deploy" / "wuwei.service").write_text(self.previous_service, encoding="utf-8")
        self.current = self.prefix / "current"
        self.current.write_text(shell_path(self.previous), encoding="utf-8")
        self.units = self.root / "units"
        self.units.mkdir()
        (self.units / "wuwei.service").write_text(self.previous_service, encoding="utf-8")
        self.data = self.root / "data"
        self.data.mkdir()
        (self.data / "wuwei.db").write_bytes(b"synthetic backup fixture")
        self.log = self.root / "commands.log"
        self.log.write_text("", encoding="utf-8")
        self.env = {**os.environ,
            "PATH": shell_path(self.bin) + ":" + os.environ.get("PATH", ""),
            "WUWEI_PREFIX": shell_path(self.prefix), "WUWEI_DATA_DIR": shell_path(self.data),
            "WUWEI_BACKUP_DIR": shell_path(self.root / "backups"), "WUWEI_SYSTEMD_DIR": shell_path(self.units),
            "WUWEI_ADMIN_BIN": shell_path(self.root / "admin" / "wuwei-admin"),
            "SANDBOX_ROOT": shell_path(self.root), "SANDBOX_LOG": shell_path(self.log),
            "MSYS2_ARG_CONV_EXCL": "*",
        }
        self.script("id", "exit 0")
        self.script("chown", "exit 0")
        if os.name == "nt":
            # Git Bash has no flock; real lock/process tests run on Linux CI.
            self.script("flock", "exit 0")
        self.script("sleep", "exit 0")
        self.script("curl", "printf '%s\\n' '{\"ok\":true}'")
        self.script("readlink", 'cat "${@: -1}"')
        self.script("ln", 'printf "%s" "$2" > "$3"')
        self.script("install", '''
target="${@: -1}"
case "$target" in "$SANDBOX_ROOT"/*) ;; *) echo "outside sandbox: $target" >&2; exit 90;; esac
if [ "${FAIL_ROLLBACK_UNIT:-}" = "1" ] && [[ "${@: -2:1}" == *previous-service ]]; then exit 88; fi
if [ "$1" = "-d" ]; then /usr/bin/mkdir -p "$target"; else /usr/bin/mkdir -p "$(dirname "$target")"; /usr/bin/cp "${@: -2:1}" "$target"; fi
if [ "${KILL_AFTER_CANDIDATE_UNIT:-}" = "1" ] && [[ "${@: -2:1}" == */releases/candidate/deploy/wuwei.service ]]; then kill -KILL "$PPID"; fi
''')
        self.script("systemctl", '''
printf 'systemctl %s\\n' "$*" >> "$SANDBOX_LOG"
if [ "$1" = "restart" ] && [ "$2" = "wuwei" ]; then
  selected="$(cat "$WUWEI_PREFIX/current")"
  if [ "$selected" = "$WUWEI_PREFIX/releases/candidate" ] && [ "${FAIL_RESTART:-}" = "1" ]; then exit 1; fi
  if [ "$selected" != "$WUWEI_PREFIX/releases/candidate" ]; then printf 'old-environment-restored\\n' >> "$SANDBOX_LOG"; fi
fi
''')
        self.script("runuser", '''
printf 'runuser %s\\n' "$*" >> "$SANDBOX_LOG"
exit 0
''')
        self.script("python3", '''
if [ "$1" != "-m" ] || [ "$2" != "venv" ]; then echo 'unexpected Python invocation' >&2; exit 91; fi
target="$3"
case "$target" in "$SANDBOX_ROOT"/*/.venv) ;; *) echo 'environment is not release-local' >&2; exit 92;; esac
mkdir -p "$target/bin"
cat > "$target/bin/python" <<'PY'
#!/usr/bin/env bash
printf 'venv %s\\n' "$*" >> "$SANDBOX_LOG"
if [ "${FAIL_PIP:-}" = "1" ] && [[ "$*" == *'pip install'* ]]; then exit 1; fi
if [ "${WAIT_FOR_PIP:-}" = "1" ] && [[ "$*" == *'pip install'* ]]; then
  touch "$SANDBOX_ROOT/pip-entered"
  while [ ! -e "$SANDBOX_ROOT/pip-continue" ]; do /usr/bin/sleep 0.05; done
fi
if [[ "$*" == *'pip install'* ]]; then
  [[ "$*" == *'--require-hashes'* ]] || exit 93
  [[ "$*" == *'--only-binary=:all:'* ]] || exit 94
fi
exit 0
PY
chmod +x "$target/bin/python"
printf 'created-venv %s\\n' "$target" >> "$SANDBOX_LOG"
''')
        package = self.root / "package"
        self.package = package
        (package / "backend" / "app").mkdir(parents=True)
        (package / "scripts").mkdir()
        (package / "deploy").mkdir()
        (package / "REVISION").write_text("a" * 40 + "\n", encoding="ascii")
        (package / "backend" / "app" / "main.py").write_text("app = None\n", encoding="utf-8")
        (package / "backend" / "requirements.lock").write_text("synthetic==1 --hash=sha256:" + "a" * 64 + "\n", encoding="utf-8")
        (package / "backend" / "uv.lock").write_text("version = 1\n", encoding="utf-8")
        (package / "scripts" / "preflight.sh").write_text('''#!/usr/bin/env bash
printf 'preflight %s %s\\n' "$WUWEI_ROOT" "${1:-}" >> "$SANDBOX_LOG"
if [ "${FAIL_STATIC:-}" = "1" ] && [ "${1:-}" = "--static" ]; then exit 1; fi
if [ "${FAIL_LIVE:-}" = "1" ] && [ "${1:-}" = "--live" ]; then exit 1; fi
''', encoding="utf-8")
        (package / "scripts" / "smoke.sh").write_text('#!/usr/bin/env bash\n[ "${FAIL_SMOKE:-}" != "1" ]\n', encoding="utf-8")
        (package / "scripts" / "backup.py").write_text("# fixture\n", encoding="utf-8")
        (package / "scripts" / "wuwei-admin").write_text("# fixture admin\n", encoding="utf-8")
        shutil.copy2(PROJECT / "scripts" / "remote-install.sh", package / "scripts" / "remote-install.sh")
        for unit in ["wuwei.service", "wuwei-tailnet.service", "wuwei-funnel.service", "wuwei-backup.service", "wuwei-backup.timer"]:
            (package / "deploy" / unit).write_text("[Service]\nEnvironment=WUWEI_VERSION=fixture\nExecStart=current/.venv/bin/python\n", encoding="utf-8")
        self.archive = self.root / "release.tar.gz"
        with tarfile.open(self.archive, "w:gz") as archive:
            for child in package.iterdir():
                archive.add(child, arcname=child.name)

    def tearDown(self):
        self.temporary.cleanup()

    def script(self, name, body):
        path = self.bin / name
        path.write_text("#!/usr/bin/env bash\nset -euo pipefail\n" + body + "\n", encoding="utf-8", newline="\n")
        path.chmod(0o755)

    def run_installer(self, **overrides):
        # Bash reconstructs PATH itself so Windows PATH semicolons cannot hide the
        # sandbox command boundary. No command can create the real /opt tree.
        script = 'export PATH="$SANDBOX_ROOT/commands:/usr/bin:/bin"; exec bash "$1" candidate "$2"'
        return subprocess.run([BASH, "-c", script, "test", shell_path(PROJECT / "scripts" / "remote-install.sh"), shell_path(self.archive)],
                              env={**self.env, **overrides}, text=True, capture_output=True, timeout=20)

    def test_success_installs_frozen_dependencies_into_a_release_environment(self):
        result = self.run_installer()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.current.read_text(encoding="utf-8"), shell_path(self.prefix / "releases" / "candidate"))
        self.assertTrue((self.prefix / "releases" / "candidate" / ".venv" / "bin" / "python").is_file())
        self.assertFalse((self.prefix / "venv").exists())
        self.assertTrue((self.root / "admin" / "wuwei-admin").is_file())
        self.assertEqual((self.prefix / "releases" / "candidate" / "REVISION").read_text().strip(), "a" * 40)
        log = self.log.read_text(encoding="utf-8")
        self.assertIn("--require-hashes", log)
        self.assertLess(log.index("--static"), log.index("systemctl restart wuwei\n"))

    def test_dependency_failure_leaves_the_old_release_and_unit_untouched(self):
        result = self.run_installer(FAIL_PIP="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.current.read_text(encoding="utf-8"), shell_path(self.previous))
        self.assertEqual((self.units / "wuwei.service").read_text(encoding="utf-8"), self.previous_service)

    def test_same_package_resumes_after_dependency_failure(self):
        self.assertNotEqual(self.run_installer(FAIL_PIP="1").returncode, 0)
        result = self.run_installer()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.current.read_text(), shell_path(self.prefix / "releases" / "candidate"))

    def test_failed_activation_can_be_retried_after_rollback(self):
        self.assertNotEqual(self.run_installer(FAIL_LIVE="1").returncode, 0)
        result = self.run_installer()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.current.read_text(), shell_path(self.prefix / "releases" / "candidate"))

    def test_failed_unit_restore_is_reported_as_rollback_failed(self):
        result = self.run_installer(FAIL_LIVE="1", FAIL_ROLLBACK_UNIT="1")
        self.assertNotEqual(result.returncode, 0)
        status = (self.prefix / "deployments" / "candidate" / "status").read_text()
        self.assertIn("phase=rollback-failed", status)
        self.assertNotIn("old-environment-restored", self.log.read_text())

    def test_resume_keeps_the_original_unit_after_interruption_before_current_switch(self):
        result = self.run_installer(KILL_AFTER_CANDIDATE_UNIT="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.current.read_text(), shell_path(self.previous))
        self.assertNotEqual((self.units / "wuwei.service").read_text(), self.previous_service)
        result = self.run_installer(FAIL_LIVE="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.current.read_text(), shell_path(self.previous))
        self.assertEqual((self.units / "wuwei.service").read_text(), self.previous_service)

    def test_resume_keeps_the_original_unit_after_rollback_unit_restore_failure(self):
        self.assertNotEqual(self.run_installer(FAIL_LIVE="1", FAIL_ROLLBACK_UNIT="1").returncode, 0)
        result = self.run_installer(FAIL_LIVE="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.units / "wuwei.service").read_text(), self.previous_service)

    def test_resume_rejects_a_changed_active_release_without_replacing_its_baseline(self):
        self.assertNotEqual(self.run_installer(FAIL_LIVE="1").returncode, 0)
        newer = self.prefix / "releases" / "newer"
        newer.mkdir()
        self.current.write_text(shell_path(newer))
        newer_service = "[Service]\nExecStart=newer-release-environment\n"
        (self.units / "wuwei.service").write_text(newer_service)
        before = self.log.read_text()
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("baseline", result.stderr.lower())
        self.assertEqual(self.current.read_text(), shell_path(newer))
        self.assertEqual((self.units / "wuwei.service").read_text(), newer_service)
        self.assertEqual(self.log.read_text(), before)

    def test_published_version_is_an_idempotent_no_op(self):
        self.assertEqual(self.run_installer().returncode, 0)
        before = self.log.read_text()
        result = self.run_installer()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.log.read_text(), before)

    def test_same_version_rejects_a_different_package_even_with_the_same_revision(self):
        self.assertNotEqual(self.run_installer(FAIL_PIP="1").returncode, 0)
        candidate = self.prefix / "releases" / "candidate"
        before = (candidate / "backend" / "app" / "main.py").read_bytes()
        (self.package / "backend" / "app" / "main.py").write_text("app = 'changed'\n")
        with tarfile.open(self.archive, "w:gz") as archive:
            for child in self.package.iterdir():
                archive.add(child, arcname=child.name)
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("identity", result.stderr.lower())
        self.assertEqual((candidate / "backend" / "app" / "main.py").read_bytes(), before)
        self.assertEqual(self.current.read_text(), shell_path(self.previous))

    def test_incomplete_extraction_is_repaired_before_installing_dependencies(self):
        self.assertNotEqual(self.run_installer(FAIL_PIP="1").returncode, 0)
        (self.prefix / "deployments" / "candidate" / "extracted").unlink()
        (self.prefix / "releases" / "candidate" / "backend" / "app" / "main.py").write_text("partial contents")
        result = self.run_installer()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual((self.prefix / "releases" / "candidate" / "backend" / "app" / "main.py").read_text(), "app = None\n")

    def test_active_but_unfinished_release_is_not_rewritten(self):
        self.assertNotEqual(self.run_installer(FAIL_PIP="1").returncode, 0)
        candidate = self.prefix / "releases" / "candidate"
        self.current.write_text(shell_path(candidate))
        before = self.log.read_text()
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("active but unfinished", result.stderr)
        self.assertEqual(self.log.read_text(), before)

    def test_resume_checks_the_retained_package_hash_again(self):
        self.assertNotEqual(self.run_installer(FAIL_PIP="1").returncode, 0)
        retained = self.prefix / "deployments" / "candidate" / "archive.tar.gz"
        retained.write_bytes(self.archive.read_bytes() + b"changed")
        result = self.controller("resume")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("identity", result.stderr.lower())
        self.assertEqual(self.current.read_text(), shell_path(self.previous))

    def test_logs_query_returns_only_the_requested_tail(self):
        job = self.prefix / "deployments" / "candidate"
        job.mkdir(parents=True)
        (job / "deploy.log").write_text("first\nsecond\nthird\n")
        result = self.controller("logs", "2")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "second\nthird\n")

    @unittest.skipIf(os.name == "nt", "Real flock is verified on Linux")
    def test_status_detects_an_exited_worker_instead_of_waiting_forever(self):
        job = self.prefix / "deployments" / "candidate"
        job.mkdir(parents=True)
        (job / "status").write_text("status=running\nphase=dependencies\nexit_code=\n")
        result = self.controller("status")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("status=interrupted", result.stdout)
        self.assertIn("phase=dependencies", result.stdout)

    @unittest.skipIf(os.name == "nt", "Real flock is verified on Linux")
    def test_global_lock_prevents_another_activation_then_allows_retry(self):
        hold = 'exec 7>"$WUWEI_PREFIX/deploy.lock"; flock 7; touch "$SANDBOX_ROOT/locked"; while [ ! -e "$SANDBOX_ROOT/unlock" ]; do sleep .05; done'
        locker = subprocess.Popen([BASH, "-c", hold], env=self.env)
        try:
            deadline = time.monotonic() + 5
            while not (self.root / "locked").exists() and time.monotonic() < deadline:
                time.sleep(.05)
            self.assertTrue((self.root / "locked").exists())
            result = self.run_installer()
            self.assertEqual(result.returncode, 75, result.stdout + result.stderr)
            self.assertEqual(self.current.read_text(), shell_path(self.previous))
            self.assertFalse((self.prefix / "releases" / "candidate").exists())
        finally:
            (self.root / "unlock").touch()
            locker.wait(timeout=5)
        self.assertEqual(self.run_installer().returncode, 0)

    def controller(self, action, *arguments, **overrides):
        script = 'export PATH="$SANDBOX_ROOT/commands:/usr/bin:/bin"; exec bash "$1" "${@:2}"'
        return subprocess.run([BASH, "-c", script, "test", shell_path(PROJECT / "scripts" / "remote-deploy.sh"), action, "candidate", *arguments],
                              env={**self.env, **overrides}, text=True, capture_output=True, timeout=10)

    def wait_for_status(self, expected):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            result = self.controller("status")
            if f"status={expected}" in result.stdout:
                return result
            time.sleep(.05)
        self.fail(f"Expected {expected}, got {result.stdout}\n{result.stderr}")

    @unittest.skipIf(os.name == "nt", "Detached POSIX processes are verified on Linux")
    def test_controller_resumes_failed_job_from_the_retained_package(self):
        digest = hashlib.sha256(self.archive.read_bytes()).hexdigest()
        result = self.controller("start", shell_path(self.archive), digest, "a" * 40, FAIL_PIP="1")
        self.assertEqual(result.returncode, 0, result.stderr)
        status = self.wait_for_status("failed")
        self.assertIn("phase=dependencies", status.stdout)
        self.archive.unlink()
        result = self.controller("resume")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.wait_for_status("succeeded")
        self.assertEqual(self.current.read_text(), shell_path(self.prefix / "releases" / "candidate"))

    @unittest.skipIf(os.name == "nt", "Real flock and detached POSIX processes are verified on Linux")
    def test_detached_worker_survives_launcher_exit_and_rejects_duplicate_start(self):
        self.assertTrue((PROJECT / "scripts" / "remote-deploy.sh").is_file(), "Detached deployment controller is missing")
        digest = hashlib.sha256(self.archive.read_bytes()).hexdigest()
        arguments = (shell_path(self.archive), digest, "a" * 40)
        try:
            started = self.controller("start", *arguments, WAIT_FOR_PIP="1")
            self.assertEqual(started.returncode, 0, started.stdout + started.stderr)
            deadline = time.monotonic() + 5
            while not (self.root / "pip-entered").exists() and time.monotonic() < deadline:
                time.sleep(.05)
            self.assertTrue((self.root / "pip-entered").exists())
            status = self.controller("status")
            self.assertIn("status=running", status.stdout)
            self.assertIn("phase=dependencies", status.stdout)
            repeated = self.controller("start", *arguments)
            self.assertEqual(repeated.returncode, 0, repeated.stdout + repeated.stderr)
            self.assertEqual(self.log.read_text().count("created-venv "), 1)
        finally:
            (self.root / "pip-continue").touch()
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            status = self.controller("status")
            if "status=succeeded" in status.stdout:
                break
            time.sleep(.05)
        self.assertIn("status=succeeded", status.stdout, status.stderr)
        self.assertIn("exit_code=0", status.stdout)
        self.assertEqual(self.current.read_text(), shell_path(self.prefix / "releases" / "candidate"))

    def test_static_preflight_failure_never_switches_the_service(self):
        result = self.run_installer(FAIL_STATIC="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.current.read_text(encoding="utf-8"), shell_path(self.previous))
        self.assertNotIn("systemctl restart wuwei\n", self.log.read_text(encoding="utf-8"))

    def test_restart_live_or_smoke_failure_restores_the_old_unit_and_environment(self):
        for variable in ["FAIL_RESTART", "FAIL_LIVE", "FAIL_SMOKE"]:
            with self.subTest(failure=variable):
                # Each failed release keeps its directory for inspection; make a
                # fresh sandbox for the next independent deployment attempt.
                if variable != "FAIL_RESTART":
                    self.tearDown(); self.setUp()
                result = self.run_installer(**{variable: "1"})
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertEqual(self.current.read_text(encoding="utf-8"), shell_path(self.previous))
                self.assertEqual((self.units / "wuwei.service").read_text(encoding="utf-8"), self.previous_service)
                self.assertIn("old-environment-restored", self.log.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
