#!/usr/bin/env bash
# Verified SQLite/media backup. The Python CLI also supports offline verify/restore.
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec python3 "$SCRIPT_DIR/backup.py" backup \
  --data-dir "${WUWEI_DATA_DIR:-/var/lib/wuwei}" \
  --destination "${WUWEI_BACKUP_DIR:-/var/backups/wuwei}" \
  --keep-days "${WUWEI_BACKUP_KEEP_DAYS:-14}"
