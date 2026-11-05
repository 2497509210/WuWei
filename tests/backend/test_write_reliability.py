from concurrent.futures import ThreadPoolExecutor
import sqlite3
import threading

import pytest

from app.db import connect
from app.routers import compartments, containers, items, rooms
from test_items import add_items, db, foreign_location, item_location, png
from test_rooms import create_container, create_room


def current_room(client, room_id):
    return client.get(f"/api/rooms/{room_id}").json()["room"]


def business_snapshot(connection):
    return {table: connection.execute(f"SELECT * FROM {table} ORDER BY id").fetchall()
            for table in ["floors", "rooms", "containers", "compartments", "items", "item_events"]}


def pending_write(client, operation):
    room, container, slot = item_location(client)
    target = container["compartments"][1]
    item = None
    if operation.startswith("item_"):
        item = add_items(client, slot["id"]).json()["items"][0]
    if operation == "item_restore":
        item = client.post(f"/api/items/{item['id']}/archive", json={"expected_version": 1, "reason": ""}).json()["item"]
    if operation == "item_undo":
        item = client.patch(f"/api/items/{item['id']}", json={"expected_version": 1, "compartment_id": target["id"]}).json()["item"]
        event = client.get(f"/api/items/{item['id']}/events").json()["events"][0]
    room = current_room(client, room["id"])
    if operation == "floor_create":
        return rooms, lambda: client.post("/api/floors", json={"name": "2 层", "level": 2})
    if operation == "room_create":
        return rooms, lambda: client.post("/api/rooms", json={"name": "另一房间", "width_cm": 400, "depth_cm": 400, "height_cm": 260})
    if operation == "room_patch":
        return rooms, lambda: client.patch(f"/api/rooms/{room['id']}", json={"name": "未经复核", "expected_version": room["version"]})
    if operation == "room_delete":
        return rooms, lambda: client.delete(f"/api/rooms/{room['id']}", params={"expected_version": room["version"]})
    if operation == "container_create":
        return containers, lambda: client.post("/api/containers", json={"room_id": room["id"], "preset": "storage_box", "name": "新箱子", "x_cm": 100, "z_cm": 100, "width_cm": 40, "depth_cm": 40, "height_cm": 40})
    if operation == "container_patch":
        return containers, lambda: client.patch(f"/api/containers/{container['id']}", json={"name": "未经复核", "expected_version": container["version"]})
    if operation == "container_delete":
        return containers, lambda: client.delete(f"/api/containers/{container['id']}", params={"expected_version": container["version"]})
    if operation == "compartment_rename":
        return compartments, lambda: client.patch(f"/api/compartments/{slot['id']}", json={"custom_name": "未经复核", "expected_container_version": container["version"]})
    if operation == "item_batch":
        return items, lambda: add_items(client, slot["id"], ["未经复核"])
    if operation == "item_patch":
        return items, lambda: client.patch(f"/api/items/{item['id']}", json={"name": "未经复核", "expected_version": item["version"]})
    if operation in {"item_confirm", "item_missing"}:
        return items, lambda: client.post(f"/api/items/{item['id']}/{operation.removeprefix('item_')}", json={"expected_version": item["version"]})
    if operation == "item_archive":
        return items, lambda: client.post(f"/api/items/{item['id']}/archive", json={"expected_version": item["version"], "reason": "未经复核"})
    if operation == "item_restore":
        return items, lambda: client.post(f"/api/items/{item['id']}/restore", json={"expected_version": item["version"], "compartment_id": slot["id"]})
    if operation == "item_undo":
        return items, lambda: client.post(f"/api/items/{item['id']}/events/{event['id']}/undo", json={"expected_version": item["version"]})
    if operation == "item_photo":
        return items, lambda: client.post(f"/api/items/{item['id']}/photo", data={"expected_version": str(item["version"])}, files={"image": ("image.png", png(), "image/png")})
    raise AssertionError(operation)


OPERATIONS = ["floor_create", "room_create", "room_patch", "room_delete", "container_create", "container_patch",
              "container_delete", "compartment_rename", "item_batch", "item_patch", "item_confirm", "item_missing",
              "item_archive", "item_restore", "item_undo", "item_photo"]


@pytest.mark.parametrize("operation", OPERATIONS)
@pytest.mark.parametrize("revocation", ["session", "disabled"])
def test_old_writes_recheck_session_after_waiting_for_lock(setup_client, monkeypatch, operation, revocation):
    module, submit = pending_write(setup_client, operation)
    waiting = threading.Event()
    class ObservedConnection:
        def __init__(self, connection): self.connection = connection
        def execute(self, sql, *args):
            statement = sql.strip().upper()
            if statement.startswith(("BEGIN IMMEDIATE", "INSERT", "UPDATE", "DELETE")):
                waiting.set()
            return self.connection.execute(sql, *args)
        def __getattr__(self, name): return getattr(self.connection, name)
    monkeypatch.setattr(module, "connect", lambda path: ObservedConnection(connect(path)))
    connection = sqlite3.connect(setup_client.app.state.db_path)
    connection.execute("BEGIN IMMEDIATE")
    try:
        before = business_snapshot(connection)
        with ThreadPoolExecutor(max_workers=1) as executor:
            job = executor.submit(submit)
            reached_write = waiting.wait(5)
            if revocation == "session":
                connection.execute("UPDATE sessions SET revoked_at='2026-01-01'")
            else:
                connection.execute("UPDATE users SET disabled_at='2026-01-01'")
            connection.commit()
            assert reached_write, "request never reached its write transaction"
            result = job.result(timeout=5)
        assert result.status_code == 401, result.text
        assert business_snapshot(connection) == before
        assert not list((setup_client.app.state.settings.data_dir / "media").glob("*.jpg"))
    finally:
        connection.close()


@pytest.mark.parametrize("operation", ["floor_create", "room_create", "room_patch", "room_delete"])
def test_owner_write_rechecks_role_after_waiting_for_lock(setup_client, monkeypatch, operation):
    module, submit = pending_write(setup_client, operation)
    waiting = threading.Event()
    class ObservedConnection:
        def __init__(self, connection): self.connection = connection
        def execute(self, sql, *args):
            if sql.strip().upper().startswith(("BEGIN IMMEDIATE", "INSERT", "UPDATE", "DELETE")): waiting.set()
            return self.connection.execute(sql, *args)
        def __getattr__(self, name): return getattr(self.connection, name)
    monkeypatch.setattr(module, "connect", lambda path: ObservedConnection(connect(path)))
    connection = sqlite3.connect(setup_client.app.state.db_path)
    connection.execute("BEGIN IMMEDIATE")
    try:
        before = business_snapshot(connection)
        with ThreadPoolExecutor(max_workers=1) as executor:
            job = executor.submit(submit)
            reached_write = waiting.wait(5)
            connection.execute("UPDATE users SET role='member'")
            connection.commit()
            assert reached_write
            result = job.result(timeout=5)
        assert result.status_code == 403 and result.json()["error"]["code"] == "owner_required"
        assert business_snapshot(connection) == before
    finally:
        connection.close()


def test_existing_photo_upload_rechecks_session_after_decoding(setup_client, monkeypatch):
    _, _, slot = item_location(setup_client)
    item = add_items(setup_client, slot["id"]).json()["items"][0]
    original_encode = items.encode_photo
    def revoke_after_decode(source):
        photo = original_encode(source)
        with db(setup_client) as connection:
            connection.execute("UPDATE sessions SET revoked_at='2026-01-01'")
        return photo
    monkeypatch.setattr(items, "encode_photo", revoke_after_decode)
    response = setup_client.post(f"/api/items/{item['id']}/photo", data={"expected_version": "1"}, files={"image": ("image.png", png(), "image/png")})
    assert response.status_code == 401
    with db(setup_client) as connection:
        assert connection.execute("SELECT version,photo_path FROM items WHERE id=?", (item["id"],)).fetchone() == (1, None)
        assert connection.execute("SELECT COUNT(*) FROM item_events WHERE event_type='photo'").fetchone()[0] == 0
    assert not list((setup_client.app.state.settings.data_dir / "media").glob("*.jpg"))


@pytest.mark.parametrize("kind", ["rooms", "containers"])
@pytest.mark.parametrize("version", [None, 0, -1])
def test_delete_requires_a_positive_expected_version(setup_client, kind, version):
    room, container, _ = item_location(setup_client)
    target = room if kind == "rooms" else container
    response = setup_client.delete(f"/api/{kind}/{target['id']}", params={} if version is None else {"expected_version": version})
    assert response.status_code == 422
    assert setup_client.get(f"/api/{kind}/{target['id']}").status_code == 200


def test_room_delete_rejects_added_empty_container_after_confirmation(setup_client):
    room = create_room(setup_client)
    container = create_container(setup_client, room["id"])
    rejected = setup_client.delete(f"/api/rooms/{room['id']}", params={"expected_version": room["version"]})
    assert rejected.status_code == 409
    assert rejected.json()["error"]["code"] == "room_version_conflict"
    current = rejected.json()["error"]["current_room"]
    assert current["version"] == room["version"] + 1 and current["container_count"] == 1
    assert setup_client.get(f"/api/containers/{container['id']}").status_code == 200
    assert setup_client.delete(f"/api/rooms/{room['id']}", params={"expected_version": current["version"]}).status_code == 204


def test_container_delete_rejects_later_layout_change(setup_client):
    _, container, _ = item_location(setup_client)
    changed = setup_client.patch(f"/api/containers/{container['id']}", json={"expected_version": 1, "x_cm": 200}).json()["container"]
    rejected = setup_client.delete(f"/api/containers/{container['id']}", params={"expected_version": container["version"]})
    assert rejected.status_code == 409 and rejected.json()["error"]["code"] == "version_conflict"
    assert rejected.json()["error"]["current"]["x_cm"] == 200
    assert setup_client.delete(f"/api/containers/{container['id']}", params={"expected_version": changed["version"]}).status_code == 204


def test_layout_mutations_advance_room_version_and_noop_does_not(setup_client):
    room = create_room(setup_client)
    assert room["version"] == 1
    container = create_container(setup_client, room["id"])
    assert current_room(setup_client, room["id"])["version"] == 2
    same = setup_client.patch(f"/api/containers/{container['id']}", json={"name": container["name"], "config": container["config"], "expected_version": 1})
    assert same.status_code == 200 and same.json()["container"]["version"] == 1
    assert current_room(setup_client, room["id"])["version"] == 2
    changed = setup_client.patch(f"/api/containers/{container['id']}", json={"expected_version": 1, "name": "新柜名"}).json()["container"]
    assert current_room(setup_client, room["id"])["version"] == 3
    slot = changed["compartments"][0]
    renamed = setup_client.patch(f"/api/compartments/{slot['id']}", json={"expected_container_version": 2, "custom_name": "证件"}).json()["container"]
    assert current_room(setup_client, room["id"])["version"] == 4
    same_name = setup_client.patch(f"/api/compartments/{slot['id']}", json={"expected_container_version": 3, "custom_name": "证件"})
    assert same_name.status_code == 200 and same_name.json()["container"]["version"] == 3
    assert current_room(setup_client, room["id"])["version"] == 4
    target = create_room(setup_client, name="书房")
    moved = setup_client.patch(f"/api/containers/{container['id']}", json={"expected_version": renamed["version"], "room_id": target["id"]}).json()["container"]
    assert current_room(setup_client, room["id"])["version"] == 5
    assert current_room(setup_client, target["id"])["version"] == 2
    assert setup_client.delete(f"/api/containers/{container['id']}", params={"expected_version": moved["version"]}).status_code == 204
    assert current_room(setup_client, target["id"])["version"] == 3


def test_delete_preserves_nonempty_and_household_guards(setup_client):
    room, container, slot = item_location(setup_client)
    add_items(setup_client, slot["id"])
    room = current_room(setup_client, room["id"])
    assert setup_client.delete(f"/api/rooms/{room['id']}", params={"expected_version": room["version"]}).json()["error"]["code"] == "room_not_empty"
    assert setup_client.delete(f"/api/containers/{container['id']}", params={"expected_version": container["version"]}).json()["error"]["code"] == "container_not_empty"
    foreign_location(setup_client)
    assert setup_client.delete("/api/rooms/other-room", params={"expected_version": 1}).status_code == 404
    assert setup_client.delete("/api/containers/other-box", params={"expected_version": 1}).status_code == 404


def test_failed_container_update_does_not_advance_room_version(setup_client):
    room, container, _ = item_location(setup_client)
    before = current_room(setup_client, room["id"])
    # Even a failure after updating container fields must roll back its parent's version.
    with db(setup_client) as connection:
        connection.execute("CREATE TRIGGER fail_parent BEFORE UPDATE OF version ON rooms BEGIN SELECT RAISE(ABORT, 'parent failed'); END")
    with pytest.raises(sqlite3.IntegrityError):
        setup_client.patch(f"/api/containers/{container['id']}", json={"expected_version": container["version"], "name": "should rollback"})
    assert current_room(setup_client, room["id"]) == before
    assert setup_client.get(f"/api/containers/{container['id']}").json()["container"] == container


def test_container_write_responses_supply_authoritative_parent_room_snapshots(setup_client):
    room = create_room(setup_client)
    result = setup_client.post("/api/containers", json={"room_id": room["id"], "preset": "storage_box", "name": "箱子",
        "x_cm": 100, "z_cm": 100, "width_cm": 40, "depth_cm": 40, "height_cm": 40})
    assert result.status_code == 201
    container = result.json()["container"]
    assert result.json()["rooms"] == [current_room(setup_client, room["id"])]
    unchanged = setup_client.patch(f"/api/containers/{container['id']}", json={"expected_version": 1})
    assert unchanged.json()["rooms"] == result.json()["rooms"]
    renamed = setup_client.patch(f"/api/compartments/{container['compartments'][0]['id']}", json={"expected_container_version": 1, "custom_name": "证件"})
    assert renamed.json()["rooms"] == [current_room(setup_client, room["id"])]
    target = create_room(setup_client, name="书房")
    moved = setup_client.patch(f"/api/containers/{container['id']}", json={"expected_version": 2, "room_id": target["id"]})
    snapshots = {entry["id"]: entry for entry in moved.json()["rooms"]}
    assert snapshots == {room["id"]: current_room(setup_client, room["id"]), target["id"]: current_room(setup_client, target["id"])}
    assert snapshots[room["id"]]["container_count"] == 0
    assert snapshots[target["id"]]["container_count"] == 1
