"""Local account recovery and derived thumbnail maintenance."""
from __future__ import annotations

import argparse
import getpass
from pathlib import Path
import sqlite3
import sys
import warnings

from .security import hash_password
from .session import revoke_all_sessions
from .services.cache_cleanup import clean_thumbnails


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    reset = commands.add_parser("reset-password", help="Set a new password and revoke every login for one active user")
    reset.add_argument("--data-dir", type=Path, required=True)
    reset.add_argument("--username", required=True)
    clean = commands.add_parser("clean-thumbnails", help="Preview old unreferenced thumbnails; --apply removes only listed managed cache files")
    clean.add_argument("--data-dir", type=Path, required=True)
    clean.add_argument("--apply", action="store_true")
    clean.add_argument("--min-age-hours", type=int, default=24)
    args = parser.parse_args(argv)
    if args.command == "clean-thumbnails":
        return clean_thumbnails(args.data_dir, args.apply, args.min_age_hours)
    database = args.data_dir / "wuwei.db"
    connection = None
    try:
        if not database.is_file():
            raise ValueError("Existing wuwei.db not found; check --data-dir")
        with warnings.catch_warnings():
            # getpass must never fall back to a terminal that echoes passwords.
            warnings.simplefilter("error", getpass.GetPassWarning)
            password = getpass.getpass("New password: ")
            repeated = getpass.getpass("Confirm new password: ")
        if password != repeated:
            raise ValueError("Passwords do not match")
        if not 8 <= len(password) <= 200:
            raise ValueError("Password must contain 8 to 200 characters")
        connection = sqlite3.connect(database.resolve().as_uri() + "?mode=rw", uri=True, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("BEGIN IMMEDIATE")
        user = connection.execute("SELECT id,disabled_at FROM users WHERE username=? COLLATE NOCASE", (args.username.strip(),)).fetchone()
        if not user or user["disabled_at"]:
            raise ValueError("Active user not found; disabled members cannot be restored with this command")
        connection.execute("UPDATE users SET password_hash=? WHERE id=?", (hash_password(password), user["id"]))
        revoke_all_sessions(connection, user["id"])
        connection.commit()
        print("Password updated. All previous sessions and remembered devices have been revoked.")
        return 0
    except (ValueError, OSError, sqlite3.Error, getpass.GetPassWarning, EOFError, KeyboardInterrupt) as exc:
        print(f"Account recovery failed: {exc}", file=sys.stderr)
        return 1
    finally:
        if connection:
            connection.close()


if __name__ == "__main__":
    raise SystemExit(main())
