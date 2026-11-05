"""Read-only release verification; never print record contents or credentials."""
import argparse
from contextlib import closing
import hashlib
import json
from pathlib import Path
import sqlite3


def open_readonly(path):
    return sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)


def summary(path):
    with closing(open_readonly(path)) as db:
        return {
            "counts": {table: db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                       for table in ("households", "users", "floors", "rooms", "containers", "compartments", "items")},
            "integrity": db.execute("PRAGMA integrity_check").fetchone()[0],
            "foreign_key_errors": len(db.execute("PRAGMA foreign_key_check").fetchall()),
            "migrations": [row[0] for row in db.execute("SELECT version FROM schema_migrations ORDER BY version")],
        }


def verify(release, baseline, data, current, migration, revision):
    release_path = current.resolve()
    before, after = summary(baseline / "wuwei.db"), summary(data)
    assert after["integrity"] == "ok" and after["foreign_key_errors"] == 0
    assert migration in after["migrations"], "Expected migration missing"
    with closing(open_readonly(baseline / "wuwei.db")) as old_db, closing(open_readonly(data)) as new_db:
        columns = "username,password_hash,role,disabled_at"
        for row in old_db.execute("SELECT id," + columns + " FROM users"):
            assert new_db.execute("SELECT " + columns + " FROM users WHERE id=?", (row[0],)).fetchone() == row[1:], "Existing account changed during deployment"
        assert new_db.execute("SELECT COUNT(*) FROM sessions WHERE group_id IS NULL").fetchone()[0] == 0, "Sessions missing device groups"
    assert all(after["counts"][key] >= count for key, count in before["counts"].items()), "Unexpected decrease in records"
    assert release_path.name == release, "Current release does not match"
    actual_revision = (release_path / "REVISION").read_text(encoding="utf-8").strip()
    assert actual_revision == revision, "Git revision does not match"
    assets = {str(path.relative_to(release_path)).replace("\\", "/"): hashlib.sha256(path.read_bytes()).hexdigest()
              for root in ("backend/app", "frontend/dist") for path in (release_path / root).rglob("*")
              if path.is_file() and "__pycache__" not in path.parts}
    return {"release": str(release_path), "revision": actual_revision, "before": before, "after": after, "sha256": assets}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("release")
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--migration", required=True)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--data", type=Path, default=Path("/var/lib/wuwei/wuwei.db"))
    parser.add_argument("--current", type=Path, default=Path("/opt/wuwei/current"))
    options = parser.parse_args()
    print(json.dumps(verify(options.release, options.baseline, options.data, options.current,
                            options.migration, options.revision), indent=2))
