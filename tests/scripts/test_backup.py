"""Offline backup contracts: run the real CLI against disposable SQLite data."""
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest


CLI = Path(__file__).resolve().parents[2] / "scripts" / "backup.py"


class BackupTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.data = self.root / "source"
        self.data.mkdir()
        (self.data / "media").mkdir()
        (self.data / "media" / "photo.txt").write_text("original photo", encoding="utf-8")
        with closing(sqlite3.connect(self.data / "wuwei.db")) as db, db:
            db.execute("CREATE TABLE things (id INTEGER PRIMARY KEY, name TEXT NOT NULL)")
            db.execute("INSERT INTO things VALUES (1, '护照')")
        self.destination = self.root / "backups"

    def tearDown(self):
        self.temporary.cleanup()

    def cli(self, *arguments):
        return subprocess.run([sys.executable, str(CLI), *map(str, arguments)], capture_output=True,
                              text=True, encoding="utf-8", errors="replace")

    def backup(self):
        result = self.cli("backup", "--data-dir", self.data, "--destination", self.destination)
        self.assertEqual(result.returncode, 0, result.stderr)
        return Path(json.loads(result.stdout)["backup"])

    # Omitting the SQLite snapshot or media copy loses real user data on restoration.
    def test_verified_backup_restores_database_and_media_into_a_new_directory(self):
        backup = self.backup()
        with closing(sqlite3.connect(self.data / "wuwei.db")) as db, db:
            db.execute("UPDATE things SET name = 'changed'")
        (self.data / "media" / "photo.txt").write_text("changed", encoding="utf-8")
        self.assertEqual(self.cli("verify", backup).returncode, 0)
        target = self.root / "restored"
        result = self.cli("restore", backup, "--target", target)
        self.assertEqual(result.returncode, 0, result.stderr)
        with closing(sqlite3.connect(target / "wuwei.db")) as db:
            self.assertEqual(db.execute("SELECT name FROM things").fetchone(), ("护照",))
        self.assertEqual((target / "media" / "photo.txt").read_text(encoding="utf-8"), "original photo")

    # SQLite's default connect would silently create a missing source and report a useless backup.
    def test_missing_database_fails_without_creating_a_database(self):
        (self.data / "wuwei.db").unlink()
        result = self.cli("backup", "--data-dir", self.data, "--destination", self.destination)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.data / "wuwei.db").exists())
        self.assertFalse(self.destination.exists() and any(self.destination.iterdir()))

    # Committed WAL rows must be present even while another database connection stays open.
    def test_online_backup_includes_committed_wal_rows(self):
        with closing(sqlite3.connect(self.data / "wuwei.db")) as live:
            live.execute("PRAGMA journal_mode=WAL")
            live.execute("INSERT INTO things VALUES (2, '相机')")
            live.commit()
            backup = self.backup()
            result = self.cli("verify", backup)
            self.assertEqual(result.returncode, 0, result.stderr)
            with closing(sqlite3.connect(backup / "wuwei.db")) as restored:
                self.assertEqual(restored.execute("SELECT name FROM things ORDER BY id").fetchall(), [("护照",), ("相机",)])

    # An uploaded file named manifest.json is still user media and must be checksummed.
    def test_media_named_manifest_is_not_excluded_from_verification(self):
        (self.data / "media" / "manifest.json").write_text("original", encoding="utf-8")
        backup = self.backup()
        (backup / "media" / "manifest.json").write_text("tampered", encoding="utf-8")
        self.assertNotEqual(self.cli("verify", backup).returncode, 0)

    # DB snapshots can retain an old photo path while a concurrent upload removes that media file.
    def test_database_referencing_a_missing_photo_is_not_published_as_a_valid_backup(self):
        with closing(sqlite3.connect(self.data / "wuwei.db")) as db, db:
            db.execute("CREATE TABLE items (id TEXT PRIMARY KEY, photo_path TEXT)")
            db.execute("INSERT INTO items VALUES ('passport', 'missing.jpg')")
        result = self.cli("backup", "--data-dir", self.data, "--destination", self.destination)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.destination.exists() and any(self.destination.iterdir()))

    # A checksum failure must prevent both a successful verify and a partially trusted restore.
    def test_tampered_media_is_rejected_before_restore_creates_target(self):
        backup = self.backup()
        (backup / "media" / "photo.txt").write_text("corrupt", encoding="utf-8")
        self.assertNotEqual(self.cli("verify", backup).returncode, 0)
        target = self.root / "restored"
        self.assertNotEqual(self.cli("restore", backup, "--target", target).returncode, 0)
        self.assertFalse(target.exists())

    # Overwriting even an empty existing target makes accidental production restoration possible.
    def test_restore_refuses_existing_target_and_preserves_its_database(self):
        backup = self.backup()
        target = self.root / "restored"
        target.mkdir()
        (target / "wuwei.db").write_bytes(b"do not overwrite")
        self.assertNotEqual(self.cli("restore", backup, "--target", target).returncode, 0)
        self.assertEqual((target / "wuwei.db").read_bytes(), b"do not overwrite")

    # A backup of a logically inconsistent SQLite database should never pass validation.
    def test_foreign_key_violation_prevents_publication(self):
        with closing(sqlite3.connect(self.data / "wuwei.db")) as db, db:
            db.execute("CREATE TABLE parent (id INTEGER PRIMARY KEY)")
            db.execute("CREATE TABLE child (parent_id INTEGER REFERENCES parent(id))")
            db.execute("INSERT INTO child VALUES (99)")
        result = self.cli("backup", "--data-dir", self.data, "--destination", self.destination)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.destination.exists() and any(self.destination.iterdir()))

    # A malicious manifest must never cause restore to write outside the selected new target.
    def test_manifest_path_traversal_is_rejected(self):
        backup = self.backup()
        manifest = json.loads((backup / "manifest.json").read_text(encoding="utf-8"))
        manifest["files"]["../outside.txt"] = {"size": 0, "sha256": "0" * 64}
        (backup / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        target = self.root / "restored"
        self.assertNotEqual(self.cli("restore", backup, "--target", target).returncode, 0)
        self.assertFalse(target.exists())
        self.assertFalse((self.root / "outside.txt").exists())

    # Retention must remove only expired bundles produced by this tool, never arbitrary neighbor files.
    def test_retention_removes_expired_backups_but_keeps_unrelated_files(self):
        backup = self.backup()
        manifest = json.loads((backup / "manifest.json").read_text(encoding="utf-8"))
        manifest["created_at"] = "2000-01-01T00:00:00+00:00"
        (backup / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        unrelated = self.destination / "unrelated.txt"
        unrelated.write_text("keep", encoding="utf-8")
        fresh = self.backup()
        self.assertFalse(backup.exists())
        self.assertTrue(fresh.exists())
        self.assertEqual(unrelated.read_text(encoding="utf-8"), "keep")


if __name__ == "__main__":
    unittest.main()

