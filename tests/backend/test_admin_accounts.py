import importlib
import sqlite3

import pytest

from app.db import MIGRATIONS_DIR, init_db
from app.security import verify_password
from test_accounts import login_browser
from test_items import db


def test_v3_tokens_migrate_into_one_honestly_labeled_legacy_group(tmp_path):
    data = tmp_path / "v3"
    data.mkdir()
    connection = sqlite3.connect(data / "wuwei.db")
    try:
        connection.execute("CREATE TABLE schema_migrations(version TEXT PRIMARY KEY,applied_at TEXT NOT NULL)")
        for version in ["001_init", "002_items", "003_item_lifecycle"]:
            connection.executescript((MIGRATIONS_DIR / (version + ".sql")).read_text(encoding="utf-8"))
            connection.execute("INSERT INTO schema_migrations VALUES (?, '2020')", (version,))
            connection.commit()
        connection.execute("INSERT INTO households(id,name,created_at) VALUES ('home','home','2020')")
        connection.execute("INSERT INTO users(id,household_id,username,password_hash,display_name,role,created_at) VALUES ('user','home','old','unused','old','owner','2020')")
        for number, kind in [(1, "session"), (2, "device"), (3, "session")]:
            connection.execute("INSERT INTO sessions(id,user_id,token_hash,kind,device_name,expires_at,created_at) VALUES (?, 'user', ?, ?, 'old device', '2099-01-01T00:00:00+00:00', '2020')", (str(number), str(number), kind))
        connection.commit()
    finally:
        connection.close()
    init_db(data)
    init_db(data)
    connection = sqlite3.connect(data / "wuwei.db")
    try:
        groups = connection.execute("SELECT id,device_name,legacy FROM session_groups").fetchall()
        assert len(groups) == 1 and groups[0][1:] == ("升级前登录（可能包含多台设备）", 1)
        assert connection.execute("SELECT DISTINCT group_id FROM sessions").fetchall() == [(groups[0][0],)]
        assert connection.execute("SELECT disabled_at FROM users").fetchone() == (None,)
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
    finally:
        connection.close()


def test_cli_reset_reads_getpass_twice_and_revokes_tokens_without_printing_password(setup_client, monkeypatch, capsys):
    admin = importlib.import_module("app.admin")
    browser = login_browser(setup_client)
    values = iter(["private-new-password", "private-new-password"])
    monkeypatch.setattr(admin.getpass, "getpass", lambda prompt: next(values))
    exit_code = admin.main(["reset-password", "--data-dir", str(setup_client.app.state.settings.data_dir), "--username", "owner"])
    assert exit_code == 0
    output = capsys.readouterr()
    assert "private-new-password" not in output.out + output.err
    assert browser.get("/api/me").status_code == 401
    assert setup_client.get("/api/me").status_code == 401
    with db(setup_client) as connection:
        saved = connection.execute("SELECT password_hash FROM users WHERE username='owner'").fetchone()[0]
    assert verify_password(saved, "private-new-password")


@pytest.mark.parametrize("values", [("password-a", "password-b"), ("short", "short")])
def test_cli_invalid_confirmation_does_not_change_password_or_sessions(setup_client, monkeypatch, values):
    admin = importlib.import_module("app.admin")
    supplied = iter(values)
    monkeypatch.setattr(admin.getpass, "getpass", lambda prompt: next(supplied))
    assert admin.main(["reset-password", "--data-dir", str(setup_client.app.state.settings.data_dir), "--username", "owner"]) == 1
    assert setup_client.get("/api/me").status_code == 200
    with db(setup_client) as connection:
        saved = connection.execute("SELECT password_hash FROM users WHERE username='owner'").fetchone()[0]
    assert verify_password(saved, "password123")


def test_cli_refuses_missing_database_without_creating_one(tmp_path, monkeypatch):
    admin = importlib.import_module("app.admin")
    monkeypatch.setattr(admin.getpass, "getpass", lambda prompt: "password123")
    data = tmp_path / "not-created"
    assert admin.main(["reset-password", "--data-dir", str(data), "--username", "owner"]) == 1
    assert not data.exists()
