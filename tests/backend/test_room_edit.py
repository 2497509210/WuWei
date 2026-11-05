import sqlite3
from contextlib import closing

import pytest

from app import db as database

from test_items import db, foreign_location
from test_rooms import create_container, create_room


def test_room_edit_returns_versions_and_rejects_stale_overwrite(setup_client):
    room = create_room(setup_client)
    assert room.get("version") == 1
    result = setup_client.patch(f"/api/rooms/{room['id']}", json={"expected_version": 1, "name": "  书房  ", "width_cm": 500})
    assert result.status_code == 200, result.text
    current = result.json()["room"]
    assert current["name"] == "书房" and current["width_cm"] == 500 and current["version"] == 2
    stale = setup_client.patch(f"/api/rooms/{room['id']}", json={"expected_version": 1, "name": "旧客户端草稿"})
    assert stale.status_code == 409
    assert stale.json()["error"]["code"] == "room_version_conflict"
    assert stale.json()["error"]["current_room"] == current
    assert setup_client.get(f"/api/rooms/{room['id']}").json()["room"] == current
    assert setup_client.get("/api/bootstrap").json()["floors"][0]["rooms"][0] == current


@pytest.mark.parametrize("action", ["create", "update"])
def test_room_names_reject_whitespace_after_trim(setup_client, action):
    room = create_room(setup_client)
    if action == "create":
        response = setup_client.post("/api/rooms", json={"name": " \t ", "width_cm": 400, "depth_cm": 300, "height_cm": 250})
    else:
        response = setup_client.patch(f"/api/rooms/{room['id']}", json={"expected_version": 1, "name": " \t "})
    assert response.status_code == 422


def test_room_create_trims_name_and_noop_does_not_invalidate_version(setup_client):
    room = create_room(setup_client, name="  主卧  ")
    assert room["name"] == "主卧" and room.get("version") == 1
    for values in [{"expected_version": 1}, {"expected_version": 1, "name": " 主卧 "}]:
        response = setup_client.patch(f"/api/rooms/{room['id']}", json=values)
        assert response.status_code == 200 and response.json()["room"]["version"] == 1
    compatible = setup_client.patch(f"/api/rooms/{room['id']}", json={"name": "客房"})
    assert compatible.status_code == 200 and compatible.json()["room"]["version"] == 2


@pytest.mark.parametrize("patch", [{"width_cm": 100}, {"depth_cm": 100}, {"height_cm": 200}])
def test_room_shrink_keeps_version_and_container_when_it_would_clip(setup_client, patch):
    room = create_room(setup_client)
    cabinet = create_container(setup_client, room["id"])
    baseline = setup_client.get(f"/api/rooms/{room['id']}").json()["room"]
    rejected = setup_client.patch(f"/api/rooms/{room['id']}", json={"expected_version": baseline["version"], **patch})
    assert rejected.status_code == 409 and rejected.json()["error"]["code"] == "room_contains_outside_container"
    actual = setup_client.get(f"/api/rooms/{room['id']}").json()
    assert actual["room"]["version"] == baseline["version"]
    assert actual["containers"][0] == cabinet


def test_room_edit_limits_member_and_other_household(setup_client):
    room = create_room(setup_client)
    foreign_location(setup_client)
    assert setup_client.patch("/api/rooms/other-room", json={"expected_version": 1, "name": "别家"}).status_code == 404
    with db(setup_client) as connection:
        connection.execute("UPDATE users SET role='member' WHERE username='owner'")
    assert setup_client.get(f"/api/rooms/{room['id']}").status_code == 200
    assert setup_client.patch(f"/api/rooms/{room['id']}", json={"expected_version": 1, "name": "不能修改"}).status_code == 403
    assert setup_client.delete(f"/api/rooms/{room['id']}", params={"expected_version": setup_client.get(f"/api/rooms/{room['id']}").json()["room"]["version"]}).status_code == 403


@pytest.mark.parametrize("patch", [{"name": None}, {"width_cm": None}, {"depth_cm": None}, {"height_cm": None}, {"expected_version": 0}])
def test_room_invalid_fields_leave_record_unchanged(setup_client, patch):
    room = create_room(setup_client)
    result = setup_client.patch(f"/api/rooms/{room['id']}", json={"expected_version": 1, **patch})
    assert result.status_code == 422
    assert setup_client.get(f"/api/rooms/{room['id']}").json()["room"] == room


def test_room_version_migration_preserves_existing_room(tmp_path):
    data = tmp_path / "old-data"
    data.mkdir()
    with closing(sqlite3.connect(data / "wuwei.db")) as connection:
        connection.executescript("CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL);")
        for migration in sorted(database.MIGRATIONS_DIR.glob("*.sql")):
            if migration.stem >= "005_room_version":
                break
            connection.executescript(migration.read_text(encoding="utf-8"))
            connection.execute("INSERT INTO schema_migrations VALUES (?,?)", (migration.stem, "2026-11-04"))
            connection.commit()
        connection.execute("INSERT INTO households VALUES ('home','我家',NULL,'2026-11-04')")
        connection.execute("INSERT INTO floors VALUES ('floor','home','1层',1,0)")
        connection.execute("INSERT INTO rooms(id,floor_id,name,width_cm,depth_cm,height_cm,wall_color,sort) VALUES ('room','floor','旧房间',460,360,260,NULL,0)")
        connection.commit()
    database.init_db(data)
    database.init_db(data)
    with closing(sqlite3.connect(data / "wuwei.db")) as connection:
        assert connection.execute("SELECT id,name,width_cm,depth_cm,height_cm,version FROM rooms").fetchone() == ("room", "旧房间", 460, 360, 260, 1)
