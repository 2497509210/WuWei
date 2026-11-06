from concurrent.futures import ThreadPoolExecutor
import sqlite3
import threading

import pytest
from fastapi.testclient import TestClient

from app.security import hash_password
from test_accounts import join_member
from test_items import add_items, db, foreign_location, item_location


def selection(items):
    return [{"id": item["id"], "expected_version": item["version"]} for item in items]


def bulk(client, items, action="move", operation="bulk-one", **extras):
    return client.post("/api/items/actions/bulk", json={
        "operation_id": operation, "action": action, "items": selection(items), **extras,
    })


def get_items(client, items):
    return [client.get(f"/api/items/{item['id']}").json()["item"] for item in items]


def operation_count(client):
    with db(client) as connection:
        return connection.execute("SELECT COUNT(*) FROM item_bulk_operations").fetchone()[0]


def test_move_validates_all_and_logs_only_changed_items(setup_client):
    _, container, source = item_location(setup_client)
    target = container["compartments"][1]
    first = add_items(setup_client, source["id"], ["护照"]).json()["items"][0]
    second = add_items(setup_client, target["id"], ["钥匙"]).json()["items"][0]
    result = bulk(setup_client, [first, second], compartment_id=target["id"])
    assert result.status_code == 200, result.text
    assert {key: result.json()[key] for key in ["processed", "changed", "replayed"]} == {"processed": 2, "changed": 1, "replayed": False}
    current = {item["id"]: item for item in result.json()["items"]}
    assert current[first["id"]]["version"] == 2 and current[first["id"]]["compartment_id"] == target["id"]
    assert current[second["id"]]["version"] == 1
    history = setup_client.get(f"/api/items/{first['id']}/events").json()["events"]
    assert history[0]["type"] == "move" and history[0]["can_undo"]
    assert history[0]["from_path"] == ["1 层", "主卧", "衣柜", "顶层"]
    assert history[0]["to_path"] == ["1 层", "主卧", "衣柜", "中层"]
    undone = setup_client.post(f"/api/items/{first['id']}/events/{history[0]['id']}/undo", json={"expected_version": 2})
    assert undone.status_code == 200 and undone.json()["item"]["compartment_id"] == source["id"]
    assert len(setup_client.get(f"/api/items/{second['id']}/events").json()["events"]) == 1


def test_archive_detaches_snapshots_and_restore_selects_new_location(setup_client):
    room, _, source = item_location(setup_client)
    items = add_items(setup_client, source["id"], ["护照", "钥匙"]).json()["items"]
    archived = bulk(setup_client, items, action="archive", reason=" 已收起 ")
    assert archived.status_code == 200, archived.text
    assert archived.json()["changed"] == 2
    for item in archived.json()["items"]:
        assert item["compartment_id"] is None and item["room_id"] is None
        assert item["archive_reason"] == "已收起"
        assert item["location_path"] == ["1 层", "主卧", "衣柜", "顶层"]
    assert setup_client.delete(f"/api/rooms/{room['id']}", params={"expected_version": setup_client.get(f"/api/rooms/{room['id']}").json()["room"]["version"]}).status_code == 204
    _, _, target = item_location(setup_client, "书房")
    restored = bulk(setup_client, archived.json()["items"], action="restore", operation="restore", compartment_id=target["id"])
    assert restored.status_code == 200 and restored.json()["changed"] == 2
    for item in restored.json()["items"]:
        assert item["archived_at"] is None and item["archive_reason"] is None
        assert item["version"] == 3 and item["compartment_id"] == target["id"]
        assert item["location_status"] == "confirmed" and item["last_confirmed_at"]
        history = setup_client.get(f"/api/items/{item['id']}/events").json()["events"]
        assert [event["type"] for event in history] == ["restore", "archive", "create"]
        assert history[1]["to_path"] is None
        assert history[0]["from_path"] == ["1 层", "主卧", "衣柜", "顶层"]


def test_replay_is_order_independent_and_returns_current_items_original_changed(setup_client):
    _, _, source = item_location(setup_client)
    items = add_items(setup_client, source["id"], ["护照", "钥匙"]).json()["items"]
    result = bulk(setup_client, items, action="archive")
    assert result.status_code == 200
    _, _, target = item_location(setup_client, "书房")
    restored = setup_client.post(f"/api/items/{items[0]['id']}/restore", json={"expected_version": 2, "compartment_id": target["id"]})
    assert restored.status_code == 200
    replay = bulk(setup_client, list(reversed(items)), action="archive", reason="   ")
    assert replay.status_code == 200, replay.text
    assert {key: replay.json()[key] for key in ["processed", "changed", "replayed"]} == {"processed": 2, "changed": 2, "replayed": True}
    latest = {item["id"]: item for item in replay.json()["items"]}
    assert latest[items[0]["id"]]["version"] == 3 and latest[items[0]["id"]]["archived_at"] is None
    assert operation_count(setup_client) == 1


def test_move_replay_survives_target_deletion_after_items_archived(setup_client):
    _, _, source = item_location(setup_client)
    target_room, _, target = item_location(setup_client, "书房")
    items = add_items(setup_client, source["id"], ["护照", "钥匙"]).json()["items"]
    moved = bulk(setup_client, items, compartment_id=target["id"])
    assert moved.status_code == 200
    archived = bulk(setup_client, moved.json()["items"], action="archive", operation="archive")
    assert archived.status_code == 200
    assert setup_client.delete(f"/api/rooms/{target_room['id']}", params={"expected_version": setup_client.get(f"/api/rooms/{target_room['id']}").json()["room"]["version"]}).status_code == 204
    replay = bulk(setup_client, items, compartment_id=target["id"])
    assert replay.status_code == 200 and replay.json()["replayed"]
    assert all(item["archived_at"] for item in replay.json()["items"])
    assert operation_count(setup_client) == 2


def test_noop_move_is_recorded_once_without_versions_or_history_changes(setup_client):
    _, _, source = item_location(setup_client)
    items = add_items(setup_client, source["id"], ["护照", "钥匙"]).json()["items"]
    first = bulk(setup_client, items, compartment_id=source["id"])
    assert first.status_code == 200 and first.json()["changed"] == 0
    retry = bulk(setup_client, items, compartment_id=source["id"])
    assert retry.status_code == 200 and retry.json()["changed"] == 0 and retry.json()["replayed"]
    assert get_items(setup_client, items) == items
    assert operation_count(setup_client) == 1
    with db(setup_client) as connection:
        assert connection.execute("SELECT COUNT(*) FROM item_events").fetchone()[0] == 2


def test_missing_or_foreign_item_takes_precedence_over_version_conflict(setup_client):
    _, _, source = item_location(setup_client)
    items = add_items(setup_client, source["id"], ["护照"]).json()["items"]
    foreign_location(setup_client)
    response = setup_client.post("/api/items/actions/bulk", json={
        "operation_id": "hidden", "action": "archive",
        "items": [{"id": items[0]["id"], "expected_version": 99}, {"id": "other-item", "expected_version": 1}],
    })
    assert response.status_code == 404 and response.json()["error"]["code"] == "item_not_found"
    assert get_items(setup_client, items) == items


def test_unauthenticated_bulk_cannot_create_an_operation(setup_client):
    _, _, source = item_location(setup_client)
    items = add_items(setup_client, source["id"], ["护照"]).json()["items"]
    setup_client.post("/api/auth/logout")
    assert bulk(setup_client, items, action="archive").status_code == 401
    assert operation_count(setup_client) == 0


def test_same_household_actor_can_replay_without_new_actor_history(setup_client):
    _, _, source = item_location(setup_client)
    items = add_items(setup_client, source["id"], ["护照"]).json()["items"]
    member, _ = join_member(setup_client)
    assert bulk(setup_client, items, action="archive").status_code == 200
    response = bulk(member, items, action="archive")
    assert response.status_code == 200 and response.json()["replayed"] is True
    assert response.json()["changed"] == 1
    history = setup_client.get(f"/api/items/{items[0]['id']}/events").json()["events"]
    assert [event["type"] for event in history] == ["archive", "create"]
    assert history[0]["actor_name"] == "owner"


def test_same_operation_id_in_other_household_is_a_separate_operation(setup_client):
    _, _, source = item_location(setup_client)
    items = add_items(setup_client, source["id"], ["护照"]).json()["items"]
    assert bulk(setup_client, items, action="archive").status_code == 200
    foreign_location(setup_client)
    with db(setup_client) as connection:
        connection.execute("INSERT INTO users(id,household_id,username,password_hash,display_name,role,created_at) VALUES ('other-owner','other-home','other-owner',?,'别家管理员','owner','2026-01-01')", (hash_password("password123"),))
    other = TestClient(setup_client.app)
    assert other.post("/api/auth/login", json={"username": "other-owner", "password": "password123"}).status_code == 200
    response = bulk(other, [{"id": "other-item", "version": 1}], action="archive")
    assert response.status_code == 200 and response.json()["replayed"] is False
    assert [item["id"] for item in response.json()["items"]] == ["other-item"]
    assert operation_count(setup_client) == 2


@pytest.mark.parametrize("difference", ["action", "reason", "version", "items", "target"])
def test_operation_id_rejects_different_normalized_content(setup_client, difference):
    _, container, source = item_location(setup_client)
    items = add_items(setup_client, source["id"], ["护照", "钥匙"]).json()["items"]
    assert bulk(setup_client, items, compartment_id=container["compartments"][1]["id"]).status_code == 200
    payload = {"operation_id": "bulk-one", "action": "move", "items": selection(items), "compartment_id": container["compartments"][1]["id"]}
    if difference == "action":
        payload = {"operation_id": "bulk-one", "action": "archive", "items": selection(items)}
    elif difference == "reason":
        assert bulk(setup_client, get_items(setup_client, items), action="archive", operation="reason", reason="a").status_code == 200
        payload = {"operation_id": "reason", "action": "archive", "items": selection([{**item, "version": 2} for item in items]), "reason": "b"}
    elif difference == "version":
        payload["items"][0]["expected_version"] = 2
    elif difference == "items":
        payload["items"] = payload["items"][:1]
    else:
        payload["compartment_id"] = source["id"]
    response = setup_client.post("/api/items/actions/bulk", json=payload)
    assert response.status_code == 409 and response.json()["error"]["code"] == "operation_conflict"


@pytest.mark.parametrize("problem", ["stale", "state", "missing", "foreign", "target_missing", "target_foreign"])
def test_any_invalid_item_or_target_rejects_entire_batch(setup_client, problem):
    _, container, source = item_location(setup_client)
    items = add_items(setup_client, source["id"], ["护照", "钥匙"]).json()["items"]
    target = container["compartments"][1]["id"]
    selected = selection(items)
    if problem == "stale":
        setup_client.patch(f"/api/items/{items[1]['id']}", json={"expected_version": 1, "name": "changed"})
    elif problem == "state":
        archived = setup_client.post(f"/api/items/{items[1]['id']}/archive", json={"expected_version": 1, "reason": ""}).json()["item"]
        selected[1]["expected_version"] = archived["version"]
    elif problem in {"missing", "foreign"}:
        if problem == "foreign":
            foreign_location(setup_client)
        selected[1]["id"] = "missing" if problem == "missing" else "other-item"
    elif problem == "target_foreign":
        target = foreign_location(setup_client)
    else:
        target = "deleted"
    before = get_items(setup_client, items)
    response = setup_client.post("/api/items/actions/bulk", json={"operation_id": "bulk-one", "action": "move", "items": selected, "compartment_id": target})
    assert response.status_code == (409 if problem in {"stale", "state"} else 404)
    if problem in {"stale", "state"}:
        assert response.json()["error"]["code"] == "bulk_conflict"
    elif problem in {"missing", "foreign"}:
        assert response.json()["error"]["code"] == "item_not_found"
    assert get_items(setup_client, items) == before
    assert operation_count(setup_client) == 0


@pytest.mark.parametrize("extra", [
    {"action": "unknown"}, {"items": []}, {"items": [{"id": "i", "expected_version": 1}] * 2},
    {"items": [{"id": str(index), "expected_version": 1} for index in range(101)]},
    {"operation_id": ""}, {"operation_id": "x" * 101}, {"unknown": "ignored?"},
    {"items": [{"id": "i", "expected_version": 1, "extra": 1}]},
    {"items": [{"id": "i", "expected_version": 0}]}, {"reason": "x" * 501},
    {"action": "move"}, {"action": "restore", "compartment_id": " "},
    {"compartment_id": "target"}, {"compartment_id": None}, {"reason": None},
    {"action": "move", "compartment_id": "target", "reason": ""},
    {"action": "restore", "compartment_id": "target", "reason": None},
])
def test_bulk_rejects_invalid_or_ambiguous_payload(setup_client, extra):
    payload = {"operation_id": "valid", "action": "archive", "items": [{"id": "i", "expected_version": 1}]}
    response = setup_client.post("/api/items/actions/bulk", json={**payload, **extra})
    assert response.status_code == 422, response.text


@pytest.mark.parametrize("failure", ["second_event", "operation"])
def test_event_or_operation_failure_rolls_back_every_item(setup_client, failure):
    _, container, source = item_location(setup_client)
    items = add_items(setup_client, source["id"], ["护照", "钥匙"]).json()["items"]
    ordered = sorted(items, key=lambda item: item["id"])
    with db(setup_client) as connection:
        if failure == "second_event":
            connection.execute(f"CREATE TRIGGER fail_bulk BEFORE INSERT ON item_events WHEN NEW.event_type='move' AND NEW.item_id='{ordered[1]['id']}' BEGIN SELECT RAISE(ABORT, 'failed second item'); END")
        else:
            connection.execute("CREATE TRIGGER fail_bulk BEFORE INSERT ON item_bulk_operations BEGIN SELECT RAISE(ABORT, 'operation failed'); END")
    response = bulk(setup_client, items, compartment_id=container["compartments"][1]["id"])
    assert response.status_code == 500 and response.json()["error"]["code"] == "internal_error"
    assert get_items(setup_client, items) == items
    assert operation_count(setup_client) == 0
    with db(setup_client) as connection:
        assert connection.execute("SELECT COUNT(*) FROM item_events WHERE event_type='move'").fetchone()[0] == 0


def test_concurrent_duplicate_requests_apply_once(setup_client):
    _, container, source = item_location(setup_client)
    items = add_items(setup_client, source["id"], ["护照", "钥匙"]).json()["items"]
    token = setup_client.cookies.get("wuwei_session")
    ready = threading.Barrier(2)
    def submit():
        browser = TestClient(setup_client.app)
        browser.cookies.set("wuwei_session", token)
        ready.wait(timeout=5)
        return bulk(browser, items, compartment_id=container["compartments"][1]["id"])
    with ThreadPoolExecutor(max_workers=2) as executor:
        jobs = [executor.submit(submit) for _ in range(2)]
        replies = [job.result(timeout=5) for job in jobs]
    assert [reply.status_code for reply in replies] == [200, 200]
    assert sorted(reply.json()["replayed"] for reply in replies) == [False, True]
    assert all(reply.json()["changed"] == 2 for reply in replies)
    assert operation_count(setup_client) == 1
    assert all(item["version"] == 2 for item in get_items(setup_client, items))


@pytest.mark.parametrize("revocation", ["session", "disabled"])
def test_waiting_bulk_rechecks_session_before_mutating(setup_client, monkeypatch, revocation):
    from app.routers import bulk_items
    from app.db import connect
    _, container, source = item_location(setup_client)
    items = add_items(setup_client, source["id"], ["护照", "钥匙"]).json()["items"]
    waiting = threading.Event()
    class ObservedConnection:
        def __init__(self, connection): self.connection = connection
        def execute(self, sql, *args):
            if sql == "BEGIN IMMEDIATE": waiting.set()
            return self.connection.execute(sql, *args)
        def __getattr__(self, name): return getattr(self.connection, name)
    monkeypatch.setattr(bulk_items, "connect", lambda path: ObservedConnection(connect(path)))
    connection = sqlite3.connect(setup_client.app.state.db_path)
    connection.execute("BEGIN IMMEDIATE")
    try:
        with ThreadPoolExecutor(max_workers=1) as executor:
            pending = executor.submit(bulk, setup_client, items, compartment_id=container["compartments"][1]["id"])
            assert waiting.wait(5)
            connection.execute("UPDATE sessions SET revoked_at='2026-01-01'" if revocation == "session" else "UPDATE users SET disabled_at='2026-01-01'")
            connection.commit()
            response = pending.result(timeout=5)
        assert response.status_code == 401
        assert connection.execute("SELECT COUNT(*) FROM item_bulk_operations").fetchone()[0] == 0
        assert connection.execute("SELECT DISTINCT version FROM items").fetchall() == [(1,)]
    finally:
        connection.close()
