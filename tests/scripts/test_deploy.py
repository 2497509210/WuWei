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
        self.script("sleep", "exit 0")
        self.script("curl", "printf '%s\\n' '{\"ok\":true}'")
        self.script("readlink", 'cat "${@: -1}"')
        self.script("ln", 'printf "%s" "$2" > "$3"')
        self.script("install", '''
target="${@: -1}"
case "$target" in "$SANDBOX_ROOT"/*) ;; *) echo "outside sandbox: $target" >&2; exit 90;; esac
if [ "$1" = "-d" ]; then /usr/bin/mkdir -p "$target"; else /usr/bin/mkdir -p "$(dirname "$target")"; /usr/bin/cp "${@: -2:1}" "$target"; fi
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
