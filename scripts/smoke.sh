#!/usr/bin/env bash
# 物位冒烟：只做只读检查，不修改数据
set -euo pipefail

PUBLIC_BASE="${WUWEI_PUBLIC_BASE:-https://bd-a.tail3c54de.ts.net:8443/wuwei}"
fail=0
ok() { printf '  OK   %s\n' "$1"; }
bad() { printf '  FAIL %s\n' "$1"; fail=1; }

echo "== 物位 smoke =="

health="$(curl -fsS --max-time 12 "$PUBLIC_BASE/api/health" || true)"
echo "$health" | grep -q '"ok":true' && ok "health" || bad "health: $health"

status="$(curl -fsS --max-time 12 "$PUBLIC_BASE/api/setup/status" || true)"
echo "$status" | grep -q 'needed' && ok "setup/status" || bad "setup/status: $status"

code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 12 "$PUBLIC_BASE/api/me")"
[ "$code" = "401" ] && ok "未登录 /api/me -> 401" || bad "未登录 /api/me -> $code"

code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 12 "$PUBLIC_BASE/")"
[ "$code" = "200" ] && ok "首页 200" || bad "首页 $code"

headers="$(curl -sSI --max-time 12 "$PUBLIC_BASE/api/health" || true)"
echo "$headers" | grep -qi 'x-content-type-options: nosniff' && ok "安全头 nosniff" || bad "缺少 nosniff"
echo "$headers" | grep -qi 'x-frame-options' && ok "安全头 frame" || bad "缺少 frame 头"

if [ "$fail" -ne 0 ]; then
  echo "smoke: FAILED"
  exit 1
fi
echo "smoke: PASSED"
