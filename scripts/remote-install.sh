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
PREVIOUS_SERVICE="$PREFIX/releases/.$VERSION.previous-service"
PREVIOUS="$(readlink -f "$CURRENT" 2>/dev/null || true)"
SWITCHED=0

for directory in "$PREFIX" "$DATA_DIR" "$BACKUP_DIR" "$SYSTEMD_DIR"; do
  [[ "$directory" = /* && "$directory" != / ]] || { echo "Expected an absolute non-root directory: $directory" >&2; exit 1; }
done
[ -f "$TARBALL" ] || { echo "Release archive not found" >&2; exit 1; }
if ! id wuwei >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "$DATA_DIR" --shell /usr/sbin/nologin wuwei
fi
install -d -o root -g root -m 0755 "$PREFIX/releases"
install -d -o wuwei -g wuwei -m 0700 "$DATA_DIR"
install -d -o wuwei -g wuwei -m 0700 "$BACKUP_DIR"
[ ! -e "$RELEASE" ] || { echo "Release already exists: $RELEASE" >&2; exit 1; }
install -d -o root -g root -m 0755 "$RELEASE"
tar -xzf "$TARBALL" -C "$RELEASE"
chown -R root:root "$RELEASE"
chmod -R a+rX "$RELEASE"
[ -f "$RELEASE/REVISION" ] && grep -Eq '^[0-9a-f]{40}([0-9a-f]{24})?$' "$RELEASE/REVISION" || { echo "Committed Git revision missing or invalid" >&2; exit 1; }
[ -s "$RELEASE/backend/requirements.lock" ] && [ -s "$RELEASE/backend/uv.lock" ] || { echo "Dependency locks missing" >&2; exit 1; }

# Each release retains its own dependency graph; never mutate a shared venv.
"$PYTHON" -m venv "$VENV"
"$VENV/bin/python" -m pip install --disable-pip-version-check --require-hashes --only-binary=:all: \
  --index-url https://pypi.org/simple -r "$RELEASE/backend/requirements.lock"
"$VENV/bin/python" -m pip check
WUWEI_ROOT="$RELEASE" WUWEI_VENV="$VENV" bash "$RELEASE/scripts/preflight.sh" --static

# Keep the existing verified pre-deployment backup behavior.
if [ -f "$DATA_DIR/wuwei.db" ]; then
  runuser -u wuwei -- "$PYTHON" "$RELEASE/scripts/backup.py" backup \
    --data-dir "$DATA_DIR" --destination "$BACKUP_DIR/predeploy-$VERSION"
fi
if [ -f "$SERVICE" ]; then cp -p "$SERVICE" "$PREVIOUS_SERVICE"; fi

rollback() {
  echo "release failed, restoring the previous code and environment" >&2
  if [ -n "$PREVIOUS" ] && [ -d "$PREVIOUS" ]; then
    ln -sfn "$PREVIOUS" "$CURRENT"
    if [ -f "$PREVIOUS_SERVICE" ]; then
      install -m 0644 "$PREVIOUS_SERVICE" "$SERVICE"
    else
      install -m 0644 "$PREVIOUS/deploy/wuwei.service" "$SERVICE"
    fi
    systemctl daemon-reload
    systemctl restart wuwei
  else
    systemctl stop wuwei || true
  fi
}
failed_release() {
  status=$?
  trap - EXIT
  if [ "$status" -ne 0 ] && [ "$SWITCHED" -eq 1 ]; then rollback || true; fi
  exit "$status"
}
trap failed_release EXIT
# Arm rollback before replacing the old service unit; an early service failure
# must not leave the previous release pointed at the candidate's environment.
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
trap - EXIT
printf '\nDEPLOY OK: %s\n' "$VERSION"
printf 'Git revision: %s\n' "$(cat "$RELEASE/REVISION")"
printf 'setup token: %s/setup-token\n' "$DATA_DIR"
