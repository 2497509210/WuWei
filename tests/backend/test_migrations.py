import sqlite3

import pytest

from app.db import MIGRATIONS_DIR, init_db


def test_existing_v1_database_is_upgraded_without_losing_items(tmp_path):
    data = tmp_path / "legacy"
    data.mkdir()
    with sqlite3.connect(data / "wuwei.db") as connection:
        connection.executescript((MIGRATIONS_DIR / "001_init.sql").read_text(encoding="utf-8"))
        connection.execute("CREATE TABLE schema_migrations(version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)")
        connection.execute("INSERT INTO schema_migrations VALUES ('001_init','2026-01-01')")
        connection.execute("INSERT INTO households(id,name,created_at) VALUES ('home','我家','2026-01-01')")
        connection.execute("INSERT INTO items(id,household_id,name,created_at,updated_at) VALUES ('passport','home','旧护照','2026-01-01','2026-01-01')")
    upgraded = init_db(data)
    init_db(data)
    with sqlite3.connect(upgraded) as connection:
        row = connection.execute("SELECT name,aliases_json,version,location_status FROM items WHERE id='passport'").fetchone()
    assert row == ("旧护照", "[]", 1, "confirmed")


def test_failed_migration_rolls_back_all_schema_changes(tmp_path, monkeypatch):
    migrations = tmp_path / "migrations"
    migrations.mkdir()
    (migrations / "001_failure.sql").write_text("CREATE TABLE partial(id TEXT);\nTHIS IS INVALID SQL;", encoding="utf-8")
    monkeypatch.setattr("app.db.MIGRATIONS_DIR", migrations)
    data = tmp_path / "data"
    with pytest.raises(sqlite3.OperationalError):
        init_db(data)
    with sqlite3.connect(data / "wuwei.db") as connection:
        assert connection.execute("SELECT name FROM sqlite_master WHERE name='partial'").fetchall() == []
        assert connection.execute("SELECT version FROM schema_migrations").fetchall() == []


def test_v2_history_and_compartment_names_upgrade_without_invented_snapshots(tmp_path):
    data = tmp_path / "v2"
    data.mkdir()
    connection = sqlite3.connect(data / "wuwei.db")
    try:
        connection.executescript((MIGRATIONS_DIR / "001_init.sql").read_text(encoding="utf-8"))
        connection.executescript((MIGRATIONS_DIR / "002_items.sql").read_text(encoding="utf-8"))
        connection.execute("CREATE TABLE schema_migrations(version TEXT PRIMARY KEY,applied_at TEXT NOT NULL)")
        connection.executemany("INSERT INTO schema_migrations VALUES (?, '2026-01-01')", [("001_init",), ("002_items",)])
        connection.execute("INSERT INTO households(id,name,created_at) VALUES ('home','我家','2026-01-01')")
        connection.execute("INSERT INTO floors(id,household_id,name,level) VALUES ('floor','home','一层',1)")
        connection.execute("INSERT INTO rooms(id,floor_id,name,width_cm,depth_cm,height_cm) VALUES ('room','floor','主卧',460,360,260)")
        connection.execute("INSERT INTO containers(id,room_id,preset,name,x_cm,z_cm,width_cm,depth_cm,height_cm) VALUES ('box','room','storage_box','箱子',100,100,100,100,100)")
        connection.execute("INSERT INTO compartments(id,container_id,name,kind) VALUES ('slot','box','旧隔层名称','box')")
        connection.execute("INSERT INTO items(id,household_id,name,compartment_id,version,created_at,updated_at) VALUES ('item','home','护照','slot',8,'2026-01-01','2026-01-01')")
        connection.execute("INSERT INTO item_events(id,item_id,from_compartment_id,to_compartment_id,user_id,created_at) VALUES ('event','item','gone','slot','deleted-user','2026-01-01')")
        connection.commit()
    finally:
        connection.close()
    init_db(data)
    init_db(data)
    connection = sqlite3.connect(data / "wuwei.db")
    try:
        assert connection.execute("SELECT id,name,default_name,custom_name FROM compartments").fetchone() == ("slot", "旧隔层名称", "旧隔层名称", None)
        assert connection.execute("SELECT compartment_id,version,archived_at FROM items").fetchone() == ("slot", 8, None)
        assert connection.execute("SELECT id,event_type,actor_name,from_path_json,to_path_json,item_version,legacy FROM item_events").fetchone() == ("event", "move", None, None, None, None, 1)
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
    finally:
        connection.close()
