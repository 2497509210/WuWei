#!/usr/bin/env bash
# 物位部署预检：静态检查 + （--live 时）线上检查
set -euo pipefail

ROOT="${WUWEI_ROOT:-/opt/wuwei/current}"
VENV="${WUWEI_VENV:-$ROOT/.venv}"
PUBLIC_BASE="${WUWEI_PUBLIC_BASE:-https://bd-a.tail3c54de.ts.net:8443/wuwei}"
TAILNET_BASE="${WUWEI_TAILNET_BASE:-https://bd-a.tail3c54de.ts.net/wuwei}"
LOCAL_BASE="${WUWEI_LOCAL_BASE:-http://127.0.0.1:8790}"
LIVE="${1:-}"

fail=0
ok() { printf '  OK   %s\n' "$1"; }
bad() { printf '  FAIL %s\n' "$1"; fail=1; }

echo "== 物位 preflight =="
echo "root=$ROOT"

[ -f "$ROOT/backend/app/main.py" ] && ok "backend/app/main.py" || bad "backend/app/main.py 缺失"
[ -s "$ROOT/backend/uv.lock" ] && [ -s "$ROOT/backend/requirements.lock" ] && ok "后端依赖锁" || bad "后端依赖锁缺失"
[ -f "$ROOT/frontend/dist/index.html" ] && ok "frontend/dist/index.html" || bad "前端 dist 缺失"
if grep -q '/wuwei/assets/' "$ROOT/frontend/dist/index.html"; then
  ok "前端 base=/wuwei/"
else
  bad "前端没有用 /wuwei/ base 构建"
fi

if [ -x "$VENV/bin/python" ]; then
  ok "venv python"
  if (cd "$ROOT" && PYTHONPATH="$ROOT/backend" "$VENV/bin/python" -c "import app.main" 2>/dev/null); then
    ok "app.main 可导入"
  else
    bad "app.main 导入失败"
  fi
else
  bad "venv 缺失：$VENV/bin/python"
fi

if [ "$LIVE" = "--static" ]; then
  [ "$fail" -eq 0 ] || { echo "preflight: FAILED"; exit 1; }
  echo "preflight: PASSED (static)"
  exit 0
fi

if systemctl cat wuwei.service >/dev/null 2>&1; then
  ok "systemd unit 已安装"
else
  bad "systemd unit 未安装"
fi

if command -v tailscale >/dev/null 2>&1; then
  if tailscale serve status --json | python3 -c 'import json,sys; c=json.load(sys.stdin); h=c.get("Web",{}).get("bd-a.tail3c54de.ts.net:443",{}).get("Handlers",{}); assert h.get("/wuwei",{}).get("Proxy")=="http://127.0.0.1:8790"; assert not c.get("AllowFunnel",{}).get("bd-a.tail3c54de.ts.net:443",False)' 2>/dev/null; then
    ok "Tailnet 443 /wuwei 私有入口"
  else
    bad "Tailnet 443 /wuwei 配置缺失或端口非私有"
  fi
  if tailscale serve status --json 2>/dev/null | grep -q '"8443"' && \
     tailscale serve status --json 2>/dev/null | grep -q '"AllowFunnel"'; then
    ok "Funnel 8443 配置存在"
  else
    bad "Funnel 8443 未配置"
  fi
else
  bad "tailscale 命令缺失"
fi

if [ "$LIVE" = "--live" ]; then
  if systemctl is-active --quiet wuwei; then ok "wuwei.service active"; else bad "wuwei.service 未运行"; fi
  if curl -fsS --max-time 8 "$LOCAL_BASE/api/health" | grep -q '"ok":true'; then
    ok "本地 health"
  else
    bad "本地 health 失败"
  fi
  if curl -fsS --max-time 12 "$PUBLIC_BASE/api/health" | grep -q '"ok":true'; then
    ok "公网 health"
  else
    bad "公网 health 失败（$PUBLIC_BASE）"
  fi
  if curl -fsS --max-time 12 "$TAILNET_BASE/api/health" | grep -q '"ok":true'; then
    ok "Tailnet health"
  else
    bad "Tailnet health 失败（$TAILNET_BASE）"
  fi
  if curl -fsS --max-time 12 "$PUBLIC_BASE/" | grep -q 'id="root"'; then
    ok "公网首页"
  else
    bad "公网首页失败"
  fi
fi

if [ "$fail" -ne 0 ]; then
  echo "preflight: FAILED"
  exit 1
fi
echo "preflight: PASSED"
