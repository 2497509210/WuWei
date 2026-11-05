#!/usr/bin/env bash
# 在 bd-a 上以 root 运行：解包、建 venv、预检、切换、重启、冒烟、失败回滚
set -euo pipefail

VERSION="${1:?usage: remote-install.sh <version> <tar.gz>}"
TARBALL="${2:?usage: remote-install.sh <version> <tar.gz>}"
[[ "$VERSION" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || { echo "Invalid release version" >&2; exit 1; }
RELEASE="/opt/wuwei/releases/$VERSION"
CURRENT="/opt/wuwei/current"
VENV="/opt/wuwei/venv"
SERVICE="/etc/systemd/system/wuwei.service"
PREVIOUS_SERVICE="/opt/wuwei/releases/.$VERSION.previous-service"

if ! id wuwei >/dev/null 2>&1; then
  useradd --system --create-home --home-dir /var/lib/wuwei --shell /usr/sbin/nologin wuwei
fi
install -d -o root -g root -m 0755 /opt/wuwei/releases
install -d -o wuwei -g wuwei -m 0700 /var/lib/wuwei
install -d -o wuwei -g wuwei -m 0700 /var/backups/wuwei

[ ! -e "$RELEASE" ] || { echo "Release already exists: $RELEASE" >&2; exit 1; }
install -d -o root -g root -m 0755 "$RELEASE"
tar -xzf "$TARBALL" -C "$RELEASE"
chown -R root:root "$RELEASE"
chmod -R a+rX "$RELEASE"

if [ ! -x "$VENV/bin/python" ]; then
  python3 -m venv "$VENV"
fi
"$VENV/bin/pip" install -q --disable-pip-version-check \
  -i https://pypi.tuna.tsinghua.edu.cn/simple \
  "fastapi>=0.115" "uvicorn[standard]>=0.30" "argon2-cffi>=23.1" "pillow>=10.0" "python-multipart>=0.0.9"

if [ -f "$SERVICE" ]; then cp -p "$SERVICE" "$PREVIOUS_SERVICE"; fi
install -m 0644 "$RELEASE/deploy/wuwei.service" "$SERVICE"
sed -i "s/^Environment=WUWEI_VERSION=.*/Environment=WUWEI_VERSION=$VERSION/" "$SERVICE"
install -m 0644 "$RELEASE/deploy/wuwei-funnel.service" /etc/systemd/system/wuwei-funnel.service
install -m 0644 "$RELEASE/deploy/wuwei-tailnet.service" /etc/systemd/system/wuwei-tailnet.service
install -m 0644 "$RELEASE/deploy/wuwei-backup.service" /etc/systemd/system/wuwei-backup.service
install -m 0644 "$RELEASE/deploy/wuwei-backup.timer" /etc/systemd/system/wuwei-backup.timer
systemctl daemon-reload
systemctl enable wuwei-tailnet
systemctl restart wuwei-tailnet

# Funnel：前台进程由 systemd 托管，只暴露 8443 的 /wuwei
systemctl enable wuwei-funnel >/dev/null 2>&1 || true
systemctl restart wuwei-funnel
sleep 2

# 静态预检（未切换前，检查新 release）
WUWEI_ROOT="$RELEASE" WUWEI_VENV="$VENV" bash "$RELEASE/scripts/preflight.sh"

PREVIOUS="$(readlink -f "$CURRENT" 2>/dev/null || true)"
if [ -f /var/lib/wuwei/wuwei.db ]; then
  # Retain a separate, verified pre-migration snapshot for this release.
  runuser -u wuwei -- python3 "$RELEASE/scripts/backup.py" backup \
    --data-dir /var/lib/wuwei --destination "/var/backups/wuwei/predeploy-$VERSION"
fi

rollback() {
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

ln -sfn "$RELEASE" "$CURRENT"
systemctl enable wuwei >/dev/null 2>&1 || true
if ! systemctl restart wuwei; then
  echo "service restart failed, rolling back..." >&2
  rollback
  exit 1
fi

for _ in $(seq 1 30); do
  if curl -fsS --max-time 2 http://127.0.0.1:8790/api/health >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! WUWEI_ROOT="$CURRENT" WUWEI_VENV="$VENV" bash "$RELEASE/scripts/preflight.sh" --live; then
  echo "live preflight failed, rolling back..."
  rollback
  exit 1
fi

if ! WUWEI_PUBLIC_BASE="https://bd-a.tail3c54de.ts.net:8443/wuwei" bash "$RELEASE/scripts/smoke.sh"; then
  echo "smoke failed, rolling back..."
  rollback
  exit 1
fi

systemctl enable --now wuwei-backup.timer
systemctl start wuwei-backup.service
install -m 0755 "$RELEASE/scripts/wuwei-admin" /usr/local/bin/wuwei-admin

echo
echo "DEPLOY OK: $VERSION"
echo "setup token: /var/lib/wuwei/setup-token"
