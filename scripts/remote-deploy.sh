#!/usr/bin/env bash
# A short SSH request starts a durable, logged background deployment.
set -euo pipefail
ACTION="${1:?usage: remote-deploy.sh start|resume|status <version> [archive sha256 revision]}"
VERSION="${2:?release version required}"
[[ "$VERSION" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || { echo "Invalid release version" >&2; exit 1; }
PREFIX="${WUWEI_PREFIX:-/opt/wuwei}"
[[ "$PREFIX" = /* && "$PREFIX" != / ]] || { echo "Expected an absolute non-root prefix" >&2; exit 1; }
JOB="$PREFIX/deployments/$VERSION"

show_status() {
  printf 'version=%s\n' "$VERSION"
  if [ ! -f "$JOB/status" ]; then printf 'status=not-started\nphase=none\nexit_code=\n'; return; fi
  if [ -f "$JOB/completed" ]; then
    printf 'status=succeeded\nphase=complete\nexit_code=0\n'
  else
    snapshot="$(cat "$JOB/status")"
    exec 6>"$JOB/worker.lock"
    if [[ "$snapshot" == status=running* ]] && flock -n 6; then
      # No process holds the job lock: an interrupted worker cannot stay "running".
      # Reread under the lock: it may have completed since the first snapshot.
      if [ -f "$JOB/completed" ]; then
        printf 'status=succeeded\nphase=complete\nexit_code=0\n'
      else
        cat "$JOB/status" | sed 's/^status=running$/status=interrupted/'
      fi
    else
      printf '%s\n' "$snapshot"
    fi
    exec 6>&-
  fi
  [ ! -f "$JOB/revision" ] || printf 'revision=%s\n' "$(cat "$JOB/revision")"
  printf 'log=%s/deploy.log\n' "$JOB"
}
if [ "$ACTION" = status ]; then show_status; exit 0; fi
if [ "$ACTION" = logs ]; then
  LINES="${3:-60}"
  [[ "$LINES" =~ ^[1-9][0-9]{0,2}$ ]] && [ "$LINES" -le 200 ] || { echo "Log lines must be 1..200" >&2; exit 1; }
  tail -n "$LINES" "$JOB/deploy.log"
  exit 0
fi
if [ "$ACTION" = _run ]; then
  # fd 8 is inherited from the launcher and keeps the per-release flock held.
  result=0
  bash "$JOB/remote-install.sh" "$VERSION" "$JOB/archive.tar.gz" || result=$?
  if [ "$result" -ne 0 ] && ! grep -q '^status=failed$' "$JOB/status"; then
    printf 'status=failed\nphase=launch\nexit_code=%s\n' "$result" > "$JOB/status.tmp.$$"
    mv -f "$JOB/status.tmp.$$" "$JOB/status"
  fi
  exit "$result"
fi
[[ "$ACTION" = start || "$ACTION" = resume ]] || { echo "Unknown action" >&2; exit 1; }
if [ "$ACTION" = resume ] && [ ! -f "$JOB/archive.tar.gz" ]; then echo "No retained package to resume" >&2; exit 1; fi
install -d -o root -g root -m 0700 "$JOB"
exec 9>"$JOB/launch.lock"
flock -x 9
if [ "$ACTION" = start ]; then
  ARCHIVE="${3:?archive required}"; SHA="${4:?sha256 required}"; REVISION="${5:?revision required}"
  [[ "$SHA" =~ ^[0-9a-f]{64}$ && "$REVISION" =~ ^[0-9a-f]{40}([0-9a-f]{24})?$ ]] || { echo "Invalid package identity" >&2; exit 1; }
  [ "$(sha256sum "$ARCHIVE" | cut -d ' ' -f 1)" = "$SHA" ] && [ "$(tar -xOf "$ARCHIVE" REVISION)" = "$REVISION" ] || { echo "Uploaded package identity mismatch" >&2; exit 1; }
  if [ -f "$JOB/archive.sha256" ]; then
    [ "$(cat "$JOB/archive.sha256")" = "$SHA" ] && [ "$(cat "$JOB/revision")" = "$REVISION" ] || { echo "Release identity differs from the registered package" >&2; exit 1; }
  else
    [ ! -e "$PREFIX/releases/$VERSION" ] || { echo "Existing release has no resumable identity" >&2; exit 1; }
    printf '%s\n' "$REVISION" > "$JOB/revision"
    printf '%s\n' "$SHA" > "$JOB/archive.sha256"
  fi
else
  ARCHIVE="$JOB/archive.tar.gz"
  SHA="$(cat "$JOB/archive.sha256")"; REVISION="$(cat "$JOB/revision")"
  [ "$(sha256sum "$ARCHIVE" | cut -d ' ' -f 1)" = "$SHA" ] && [ "$(tar -xOf "$ARCHIVE" REVISION)" = "$REVISION" ] || { echo "Retained package identity mismatch" >&2; exit 1; }
fi
exec 8>"$JOB/worker.lock"
if ! flock -n 8; then show_status; exit 0; fi
if [ -f "$JOB/completed" ]; then show_status; exit 0; fi
if [ "$ACTION" = start ] && [ "$ARCHIVE" != "$JOB/archive.tar.gz" ]; then
  cp "$ARCHIVE" "$JOB/archive.tar.gz.tmp"
  mv -f "$JOB/archive.tar.gz.tmp" "$JOB/archive.tar.gz"
fi
if [ ! -f "$JOB/remote-install.sh" ]; then
  tar -xOf "$JOB/archive.tar.gz" scripts/remote-install.sh > "$JOB/remote-install.sh.tmp"
  mv -f "$JOB/remote-install.sh.tmp" "$JOB/remote-install.sh"
fi
if [ ! -f "$JOB/remote-deploy.sh" ]; then
  cp "$0" "$JOB/remote-deploy.sh.tmp"
  mv -f "$JOB/remote-deploy.sh.tmp" "$JOB/remote-deploy.sh"
fi
printf 'status=running\nphase=queued\nexit_code=\n' > "$JOB/status.tmp.$$"
mv -f "$JOB/status.tmp.$$" "$JOB/status"
nohup bash "$JOB/remote-deploy.sh" _run "$VERSION" 9>&- </dev/null >>"$JOB/deploy.log" 2>&1 &
show_status
