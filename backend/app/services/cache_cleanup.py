"""Preview or remove old, unreferenced derived thumbnails, never original media."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import time


def clean_thumbnails(data_dir: Path, apply: bool = False, min_age_hours: int = 24) -> int:
    connection = None
    try:
        if min_age_hours < 1:
            raise ValueError("Minimum age must be at least one hour")
        database = data_dir / "wuwei.db"
        if not database.is_file():
            raise ValueError("Existing wuwei.db not found; check --data-dir")
        cache = data_dir / "cache"
        if cache.is_symlink() or (cache.exists() and not cache.is_dir()):
            raise ValueError("Cache must be a real directory inside --data-dir")
        mode = "rw" if apply else "ro"
        connection = sqlite3.connect(database.resolve().as_uri() + f"?mode={mode}", uri=True, timeout=5)
        connection.execute("BEGIN IMMEDIATE" if apply else "BEGIN")
        references = {hashlib.sha256(Path(row[0]).name.encode("utf-8")).hexdigest() + ".jpg"
                      for row in connection.execute("SELECT photo_path FROM items WHERE photo_path IS NOT NULL")}
        cutoff = time.time() - min_age_hours * 3600
        candidates = []
        deleted = 0
        reclaimed = 0
        if cache.exists():
            with os.scandir(cache) as entries:
                for entry in entries:
                    if not re.fullmatch(r"[0-9a-f]{64}\.jpg", entry.name) or entry.name in references or not entry.is_file(follow_symlinks=False):
                        continue
                    stat = os.stat(entry.path, follow_symlinks=False)
                    if stat.st_mtime > cutoff:
                        continue
                    candidates.append(entry.name)
                    if apply:
                        # No recursion and no symlink following. Recheck the file
                        # identity to avoid deleting a newly replaced cache entry.
                        current = Path(entry.path).lstat()
                        if (current.st_ino, current.st_size, current.st_mtime_ns) != (stat.st_ino, stat.st_size, stat.st_mtime_ns):
                            continue
                        Path(entry.path).unlink()
                        deleted += 1
                        reclaimed += stat.st_size
        print(json.dumps({"mode": "apply" if apply else "preview", "min_age_hours": min_age_hours,
                          "candidates": sorted(candidates), "deleted": deleted, "reclaimed_bytes": reclaimed}))
        return 0
    except (ValueError, OSError, sqlite3.Error) as exc:
        print(f"Thumbnail cleanup failed: {exc}", file=sys.stderr)
        return 1
    finally:
        if connection:
            connection.close()
