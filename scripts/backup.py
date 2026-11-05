#!/usr/bin/env python3
"""Create, verify, and restore portable Wuwei backups using only Python's stdlib."""
from __future__ import annotations

import argparse
from contextlib import closing
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path, PurePosixPath
import shutil
import sqlite3
import sys
import tempfile
import uuid


FORMAT = "wuwei-backup-v1"


def database_check(path: Path) -> None:
    if not path.is_file() or path.is_symlink():
        raise ValueError(f"Database is missing or is not a regular file: {path}")
    with closing(sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)) as db:
        if db.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
            raise ValueError("SQLite integrity check failed")
        if db.execute("PRAGMA foreign_key_check").fetchone() is not None:
            raise ValueError("SQLite foreign key check failed")


def fingerprint(path: Path) -> dict:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return {"size": path.stat().st_size, "sha256": digest.hexdigest()}


def inventory(root: Path) -> dict:
    files = {}
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise ValueError(f"Symlinks are not allowed in backups: {path}")
        if path.is_file() and path != root / "manifest.json":
            files[path.relative_to(root).as_posix()] = fingerprint(path)
    return files


def verify(bundle: Path) -> dict:
    if bundle.is_symlink() or not bundle.is_dir():
        raise ValueError("Backup must be a regular directory")
    manifest_path = bundle / "manifest.json"
    if manifest_path.is_symlink():
        raise ValueError("Manifest must not be a symlink")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("format") != FORMAT or not isinstance(manifest.get("files"), dict):
        raise ValueError("Unrecognized backup manifest")
    for name in manifest["files"]:
        path = PurePosixPath(name)
        if (path.is_absolute() or ".." in path.parts or "\\" in name or ":" in name
                or name != path.as_posix() or not path.parts
                or not (name == "wuwei.db" or path.parts[0] == "media")):
            raise ValueError(f"Unsafe backup path: {name}")
    if "wuwei.db" not in manifest["files"]:
        raise ValueError("Backup has no database")
    if inventory(bundle) != manifest["files"]:
        raise ValueError("Backup files do not match manifest checksums")
    database_check(bundle / "wuwei.db")
    # Snapshotting SQLite and copying media are separate operations. A concurrent
    # photo replacement can remove an old file; fail rather than publish lost media.
    with closing(sqlite3.connect((bundle / "wuwei.db").resolve().as_uri() + "?mode=ro", uri=True)) as db:
        columns = {row[1] for row in db.execute("PRAGMA table_info(items)")}
        if "photo_path" in columns:
            for (name,) in db.execute("SELECT photo_path FROM items WHERE photo_path IS NOT NULL AND photo_path != ''"):
                photo = bundle / "media" / name
                if not photo.resolve().is_relative_to((bundle / "media").resolve()) or not photo.is_file():
                    raise ValueError(f"Database references missing or unsafe photo: {name}; retry backup")
    return manifest


def prune(destination: Path, keep_days: int) -> None:
    cutoff = datetime.now(timezone.utc) - timedelta(days=keep_days)
    for bundle in destination.glob("wuwei-*"):
        if bundle.is_symlink() or not bundle.is_dir():
            continue
        try:
            manifest = verify(bundle)
            created = datetime.fromisoformat(manifest["created_at"])
            expired = created.tzinfo is not None and created < cutoff
        except (ValueError, KeyError, OSError, sqlite3.Error):
            continue
        if expired:
            # Only verified direct-child bundles created by this tool are eligible.
            if bundle.resolve().parent != destination.resolve():
                raise ValueError("Retention target escaped destination")
            shutil.rmtree(bundle)


def backup(data_dir: Path, destination: Path, keep_days: int = 14) -> Path:
    if keep_days < 1:
        raise ValueError("Retention must be at least one day")
    data_dir = data_dir.resolve()
    destination = destination.resolve()
    source = data_dir / "wuwei.db"
    database_check(source)
    # Never recursively copy a backup destination nested inside the media directory.
    if destination == data_dir or (data_dir / "media") == destination or (data_dir / "media") in destination.parents:
        raise ValueError("Backup destination must be outside the data/media directories")
    media = data_dir / "media"
    if media.is_symlink():
        raise ValueError("Media directory must not be a symlink")
    if media.exists():
        for entry in media.rglob("*"):
            if entry.is_symlink():
                raise ValueError(f"Media symlinks are not supported: {entry}")
    destination.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = Path(tempfile.mkdtemp(prefix=".wuwei-", dir=destination))
    published = False
    try:
        database = temporary / "wuwei.db"
        with closing(sqlite3.connect(source.as_uri() + "?mode=ro", uri=True)) as src:
            with closing(sqlite3.connect(database)) as dst:
                src.backup(dst)
                # A self-contained snapshot needs no WAL sidecars on later read-only validation.
                dst.execute("PRAGMA journal_mode=DELETE")
        database.chmod(0o600)
        if media.exists():
            shutil.copytree(media, temporary / "media")
        manifest = {"format": FORMAT, "created_at": datetime.now(timezone.utc).isoformat(),
                    "files": inventory(temporary)}
        (temporary / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        verify(temporary)
        name = datetime.now(timezone.utc).strftime("wuwei-%Y%m%dT%H%M%S") + "-" + uuid.uuid4().hex[:8]
        target = destination / name
        temporary.rename(target)
        published = True
        prune(destination, keep_days)
        return target
    finally:
        if not published and temporary.exists():
            shutil.rmtree(temporary)


def restore(bundle: Path, target: Path) -> Path:
    bundle = bundle.absolute()
    target = target.absolute()
    if target.exists() or target.is_symlink():
        raise ValueError("Restore target must be a new directory; existing targets are never overwritten")
    verify(bundle)
    if bundle.resolve() == target.resolve() or bundle.resolve() in target.resolve().parents:
        raise ValueError("Restore target must be outside the backup")
    # mkdir(exist_ok=False) is the final no-overwrite check, including races.
    target.mkdir(parents=True, exist_ok=False, mode=0o700)
    try:
        shutil.copy2(bundle / "wuwei.db", target / "wuwei.db")
        if (bundle / "media").exists():
            shutil.copytree(bundle / "media", target / "media")
        database_check(target / "wuwei.db")
        if inventory(target) != verify(bundle)["files"]:
            raise ValueError("Restored files failed checksum verification")
        return target
    except BaseException:
        shutil.rmtree(target)
        raise


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    create = commands.add_parser("backup", help="Create and verify a SQLite/media snapshot")
    create.add_argument("--data-dir", type=Path, required=True)
    create.add_argument("--destination", type=Path, required=True)
    create.add_argument("--keep-days", type=int, default=14)
    check = commands.add_parser("verify", help="Verify checksums and SQLite integrity without restoring")
    check.add_argument("backup", type=Path)
    recover = commands.add_parser("restore", help="Restore into a NEW directory; never overwrite a database")
    recover.add_argument("backup", type=Path)
    recover.add_argument("--target", type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.command == "backup":
            print(json.dumps({"backup": str(backup(args.data_dir, args.destination, args.keep_days))}))
        elif args.command == "verify":
            verify(args.backup)
            print(json.dumps({"verified": str(args.backup)}))
        else:
            print(json.dumps({"restored": str(restore(args.backup, args.target))}))
        return 0
    except (OSError, ValueError, sqlite3.Error) as error:
        print(f"Backup failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
