#!/usr/bin/env bash
# Build an immutable release environment, validate it, then switch the service.
set -euo pipefail

VERSION="${1:?usage: remote-install.sh <version> <tar.gz>}"
TARBALL="${2:?usage: remote-install.sh <version> <tar.gz>}"
[[ "$VERSION" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || { echo "Invalid release version" >&2; exit 1; }
PREFIX="${WUWEI_PREFIX:-/opt/wuwei}"
DATA_DIR="${WUWEI_DATA_DIR:-/var/lib/wuwei}"
BACKUP_DIR="${WUWEI_BACKUP_DIR:-/var/backups/wuwei}"
SYSTEMD_DIR="${WUWEI_SYSTEMD_DIR:-/etc/systemd/system}"
ADMIN_BIN="${WUWEI_ADMIN_BIN:-/usr/local/bin/wuwei-admin}"
PYTHON="${WUWEI_PYTHON:-python3}"
RELEASE="$PREFIX/releases/$VERSION"
CURRENT="$PREFIX/current"
VENV="$RELEASE/.venv"
SERVICE="$SYSTEMD_DIR/wuwei.service"
PREVIOUS=""
SWITCHED=0
JOB="$PREFIX/deployments/$VERSION"
BASELINE="$JOB/baseline"
PREVIOUS_SERVICE="$BASELINE/previous-service"
PHASE=preparing

state() {
  printf 'status=%s\nphase=%s\nexit_code=%s\n' "$1" "$PHASE" "${2:-}" > "$JOB/status.tmp.$$"
  mv -f "$JOB/status.tmp.$$" "$JOB/status"
}
phase() { PHASE="$1"; state running; printf 'PHASE: %s\n' "$PHASE"; }

for directory in "$PREFIX" "$DATA_DIR" "$BACKUP_DIR" "$SYSTEMD_DIR"; do
  [[ "$directory" = /* && "$directory" != / ]] || { echo "Expected an absolute non-root directory: $directory" >&2; exit 1; }
done
[ -f "$TARBALL" ] || { echo "Release archive not found" >&2; exit 1; }
install -d -o root -g root -m 0755 "$PREFIX"
exec 7>"$PREFIX/deploy.lock"
flock -n 7 || { echo "Another deployment is running; retry after it finishes" >&2; exit 75; }
PREVIOUS="$(readlink -f "$CURRENT" 2>/dev/null || true)"
install -d -o root -g root -m 0700 "$JOB"
ARCHIVE_SHA="$(sha256sum "$TARBALL" | cut -d ' ' -f 1)"
REVISION="$(tar -xOf "$TARBALL" REVISION)"
[[ "$REVISION" =~ ^[0-9a-f]{40}([0-9a-f]{24})?$ ]] || { echo "Committed Git revision missing or invalid" >&2; exit 1; }
if [ -f "$JOB/archive.sha256" ]; then
  [ "$(cat "$JOB/archive.sha256")" = "$ARCHIVE_SHA" ] && [ "$(cat "$JOB/revision")" = "$REVISION" ] || { echo "Release identity differs from the registered package" >&2; exit 1; }
else
  [ ! -e "$RELEASE" ] || { echo "Existing release has no resumable identity; use a new version" >&2; exit 1; }
  printf '%s\n' "$REVISION" > "$JOB/revision"
  printf '%s\n' "$ARCHIVE_SHA" > "$JOB/archive.sha256"
fi
if [ -f "$JOB/completed" ]; then
  [ -f "$RELEASE/REVISION" ] && [ "$(cat "$RELEASE/REVISION")" = "$REVISION" ] || { echo "Completed release revision differs" >&2; exit 1; }
  PHASE=complete; state succeeded 0
  printf 'DEPLOY ALREADY COMPLETED: %s\n' "$VERSION"
  exit 0
fi
if [ "$PREVIOUS" = "$RELEASE" ]; then
  echo "Candidate is active but unfinished; inspect service and recover before retrying" >&2
  exit 1
fi
finish() {
  result=$?
  trap - EXIT
  if [ "$result" -ne 0 ]; then
    if [ "$SWITCHED" -eq 1 ]; then
      if rollback; then PHASE=rolled-back; else PHASE=rollback-failed; fi
    fi
    state failed "$result"
  fi
  exit "$result"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if [ -d "$BASELINE" ]; then
  PHASE=baseline-check
  [ -f "$BASELINE/previous-target" ] && [ "$(cat "$BASELINE/previous-target")" = "$PREVIOUS" ] || {
    echo "Active release differs from this job's rollback baseline; use a new version after inspection" >&2
    exit 1
  }
fi
if ! id wuwei >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "$DATA_DIR" --shell /usr/sbin/nologin wuwei
fi
install -d -o root -g root -m 0755 "$PREFIX/releases"
install -d -o wuwei -g wuwei -m 0700 "$DATA_DIR"
install -d -o wuwei -g wuwei -m 0700 "$BACKUP_DIR"
phase extracting
# Re-extract only an inactive, identity-bound candidate after interrupted extraction.
# Active or completed releases are never overwritten.
if [ ! -f "$JOB/extracted" ]; then
  install -d -o root -g root -m 0755 "$RELEASE"
  tar -xzf "$TARBALL" -C "$RELEASE"
  chown -R root:root "$RELEASE"
  chmod -R a+rX "$RELEASE"
  touch "$JOB/extracted"
fi
[ -f "$RELEASE/REVISION" ] && grep -Eq '^[0-9a-f]{40}([0-9a-f]{24})?$' "$RELEASE/REVISION" || { echo "Committed Git revision missing or invalid" >&2; exit 1; }
[ -s "$RELEASE/backend/requirements.lock" ] && [ -s "$RELEASE/backend/uv.lock" ] || { echo "Dependency locks missing" >&2; exit 1; }

# Each release retains its own dependency graph; never mutate a shared venv.
phase dependencies
"$PYTHON" -m venv "$VENV"
"$VENV/bin/python" -m pip install --disable-pip-version-check --require-hashes --only-binary=:all: \
  --index-url https://pypi.org/simple -r "$RELEASE/backend/requirements.lock"
"$VENV/bin/python" -m pip check
phase static-check
WUWEI_ROOT="$RELEASE" WUWEI_VENV="$VENV" bash "$RELEASE/scripts/preflight.sh" --static

# Keep the existing verified pre-deployment backup behavior.
phase snapshot
if [ -f "$DATA_DIR/wuwei.db" ]; then
  runuser -u wuwei -- "$PYTHON" "$RELEASE/scripts/backup.py" backup \
    --data-dir "$DATA_DIR" --destination "$BACKUP_DIR/predeploy-$VERSION"
fi
if [ ! -d "$BASELINE" ]; then
  # Publish the entire first activation baseline atomically. A retry must never
  # capture a candidate unit left behind before current switched or by rollback.
  baseline_tmp="$(mktemp -d "$JOB/baseline.XXXXXXXX")"
  printf '%s\n' "$PREVIOUS" > "$baseline_tmp/previous-target"
  if [ -f "$SERVICE" ]; then cp -p "$SERVICE" "$baseline_tmp/previous-service"; fi
  mv "$baseline_tmp" "$BASELINE"
fi

rollback() {
  echo "release failed, restoring the previous code and environment" >&2
  if [ -n "$PREVIOUS" ] && [ -d "$PREVIOUS" ]; then
    ln -sfn "$PREVIOUS" "$CURRENT" || return
    if [ -f "$PREVIOUS_SERVICE" ]; then
      install -m 0644 "$PREVIOUS_SERVICE" "$SERVICE" || return
    else
      install -m 0644 "$PREVIOUS/deploy/wuwei.service" "$SERVICE" || return
    fi
    systemctl daemon-reload || return
    systemctl restart wuwei || return
  else
    systemctl stop wuwei || true
  fi
}
# Arm rollback before replacing the old service unit; an early service failure
# must not leave the previous release pointed at the candidate's environment.
phase activating
SWITCHED=1
install -m 0644 "$RELEASE/deploy/wuwei.service" "$SERVICE"
sed -i "s/^Environment=WUWEI_VERSION=.*/Environment=WUWEI_VERSION=$VERSION/" "$SERVICE"
for unit in wuwei-funnel.service wuwei-tailnet.service wuwei-backup.service wuwei-backup.timer; do
  install -m 0644 "$RELEASE/deploy/$unit" "$SYSTEMD_DIR/$unit"
done
ln -sfn "$RELEASE" "$CURRENT"
systemctl daemon-reload
systemctl enable wuwei-tailnet
systemctl restart wuwei-tailnet
systemctl enable wuwei-funnel
systemctl restart wuwei-funnel
systemctl enable wuwei
systemctl restart wuwei

phase live-check
for _ in $(seq 1 30); do
  if curl -fsS --max-time 2 http://127.0.0.1:8790/api/health >/dev/null 2>&1; then break; fi
  sleep 1
done
WUWEI_ROOT="$CURRENT" WUWEI_VENV="$VENV" bash "$RELEASE/scripts/preflight.sh" --live
WUWEI_PUBLIC_BASE="https://bd-a.tail3c54de.ts.net:8443/wuwei" bash "$RELEASE/scripts/smoke.sh"
systemctl enable --now wuwei-backup.timer
systemctl start wuwei-backup.service
install -m 0755 "$RELEASE/scripts/wuwei-admin" "$ADMIN_BIN"
SWITCHED=0
touch "$JOB/completed"
PHASE=complete
state succeeded 0
trap - EXIT
printf '\nDEPLOY OK: %s\n' "$VERSION"
printf 'Git revision: %s\n' "$(cat "$RELEASE/REVISION")"
printf 'setup token: %s/setup-token\n' "$DATA_DIR"
