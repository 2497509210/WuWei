import sqlite3

import pytest

from test_items import add_items, db, foreign_location, item_location, png
from test_rooms import create_room


def create_item(client, room_name="主卧"):
    room, container, compartment = item_location(client, room_name)
    result = add_items(client, compartment["id"])
    assert result.status_code == 201, result.text
    return room, container, compartment, result.json()["items"][0]


def events(client, item_id, **params):
    response = client.get(f"/api/items/{item_id}/events", params=params)
    assert response.status_code == 200, response.text
    return response.json()


def archive(client, item, reason="不再使用"):
    return client.post(f"/api/items/{item['id']}/archive", json={"expected_version": item["version"], "reason": reason})


def reject_events(client, event_type):
    with db(client) as connection:
        connection.execute(f"CREATE TRIGGER reject_event BEFORE INSERT ON item_events WHEN NEW.event_type='{event_type}' BEGIN SELECT RAISE(ABORT, 'event rejected'); END")


def test_archive_releases_location_and_restores_after_old_room_deleted(setup_client):
    room, _, compartment, item = create_item(setup_client)
    assert item["archived_at"] is None
    result = archive(setup_client, item, " 已赠送 ")
    assert result.status_code == 200, result.text
    archived = result.json()["item"]
    assert archived["archived_at"] and archived["archive_reason"] == "已赠送"
    assert archived["version"] == 2
    assert [archived[field] for field in ["compartment_id", "container_id", "room_id"]] == [None, None, None]
    assert archived["location_path"] == ["1 层", "主卧", "衣柜", "顶层"]
    assert setup_client.get("/api/items").json()["items"] == []
    assert setup_client.get("/api/items", params={"status": "archived", "q": "护照"}).json()["items"][0]["id"] == item["id"]
    assert setup_client.delete(f"/api/rooms/{room['id']}", params={"expected_version": setup_client.get(f"/api/rooms/{room['id']}").json()["room"]["version"]}).status_code == 204
    _, _, new_compartment = item_location(setup_client, "书房")
    restored = setup_client.post(f"/api/items/{item['id']}/restore", json={"expected_version": 2, "compartment_id": new_compartment["id"]})
    assert restored.status_code == 200, restored.text
    active = restored.json()["item"]
    assert active["archived_at"] is None and active["archive_reason"] is None
    assert active["version"] == 3 and active["compartment_id"] == new_compartment["id"]
    assert active["location_status"] == "confirmed" and active["last_confirmed_at"]
    assert active["location_path"] == ["1 层", "书房", "衣柜", "顶层"]
    history = events(setup_client, item["id"])["events"]
    assert [row["type"] for row in history] == ["restore", "archive", "create"]
    assert history[1]["from_path"] == ["1 层", "主卧", "衣柜", "顶层"]
    assert history[1]["to_path"] is None
    assert history[0]["from_path"] == ["1 层", "主卧", "衣柜", "顶层"]
    assert history[0]["to_path"] == ["1 层", "书房", "衣柜", "顶层"]


@pytest.mark.parametrize("action", ["edit", "move", "confirm", "missing", "photo", "archive"])
def test_archived_item_rejects_writes_and_keeps_history(setup_client, action):
    _, _, compartment, item = create_item(setup_client)
    archived = archive(setup_client, item).json()["item"]
    url = f"/api/items/{item['id']}"
    if action in {"edit", "move"}:
        values = {"name": "新名称"} if action == "edit" else {"compartment_id": compartment["id"]}
        response = setup_client.patch(url, json={"expected_version": 2, **values})
    elif action == "photo":
        response = setup_client.post(url + "/photo", data={"expected_version": "2"}, files={"image": ("photo.png", png(), "image/png")})
    elif action == "archive":
        response = archive(setup_client, archived)
    else:
        response = setup_client.post(url + "/" + action, json={"expected_version": 2})
    assert response.status_code == 409, response.text
    assert setup_client.get(url).json()["item"]["version"] == 2
    assert [row["type"] for row in events(setup_client, item["id"])["events"]] == ["archive", "create"]


def test_archived_photo_remains_readable(setup_client):
    _, _, _, item = create_item(setup_client)
    photo = setup_client.post(f"/api/items/{item['id']}/photo", data={"expected_version": "1"}, files={"image": ("photo.png", png(), "image/png")}).json()["item"]
    archived = archive(setup_client, photo).json()["item"]
    assert setup_client.get(archived["photo_url"]).status_code == 200


def test_archive_and_restore_check_version_and_household(setup_client):
    _, _, compartment, item = create_item(setup_client)
    foreign = foreign_location(setup_client)
    url = f"/api/items/{item['id']}"
    assert setup_client.post(url + "/restore", json={"expected_version": 1, "compartment_id": compartment["id"]}).status_code == 409
    assert archive(setup_client, item).status_code == 200
    stale = archive(setup_client, item)
    assert stale.status_code == 409 and stale.json()["error"]["code"] == "version_conflict"
    for target in [foreign, "absent"]:
        assert setup_client.post(url + "/restore", json={"expected_version": 2, "compartment_id": target}).status_code == 404
    assert setup_client.post("/api/items/other-item/archive", json={"expected_version": 1, "reason": ""}).status_code == 404
    assert setup_client.get("/api/items/other-item/events").status_code == 404
    assert setup_client.get(url).json()["item"]["version"] == 2


def test_history_preserves_actor_and_location_snapshots_after_rename(setup_client):
    _, container, source, item = create_item(setup_client)
    _, _, target = item_location(setup_client, "书房")
    moved = setup_client.patch(f"/api/items/{item['id']}", json={"expected_version": 1, "compartment_id": target["id"]})
    assert moved.status_code == 200
    with db(setup_client) as connection:
        connection.execute("UPDATE users SET display_name='新名字'")
        connection.execute("UPDATE compartments SET name='后来改名' WHERE id=?", (source["id"],))
    history = events(setup_client, item["id"])["events"]
    move = history[0]
    assert move["type"] == "move" and move["actor_name"] == "owner"
    assert move["from_path"] == ["1 层", "主卧", "衣柜", "顶层"]
    assert move["to_path"] == ["1 层", "书房", "衣柜", "顶层"]
    assert move["changes"]["compartment_id"] == {"before": source["id"], "after": target["id"]}
    assert move["item_version"] == 2 and move["can_undo"] is True and move["legacy"] is False


def test_all_item_mutations_have_paginated_history(setup_client):
    _, _, _, item = create_item(setup_client)
    url = f"/api/items/{item['id']}"
    assert setup_client.patch(url, json={"expected_version": 1, "name": "旅行护照", "aliases": ["证件"], "quantity": 2}).status_code == 200
    assert setup_client.post(url + "/missing", json={"expected_version": 2}).status_code == 200
    assert setup_client.post(url + "/confirm", json={"expected_version": 3}).status_code == 200
    assert setup_client.post(url + "/photo", data={"expected_version": "4"}, files={"image": ("photo.png", png(), "image/png")}).status_code == 200
    first = events(setup_client, item["id"], limit=2)
    assert [row["type"] for row in first["events"]] == ["photo", "confirm"]
    assert first["has_more"] is True
    remaining = events(setup_client, item["id"], limit=3, offset=2)
    assert [row["type"] for row in remaining["events"]] == ["missing", "update", "create"]
    assert remaining["has_more"] is False
    assert remaining["events"][1]["changes"]["name"] == {"before": "护照", "after": "旅行护照"}
    assert [row["item_version"] for row in first["events"] + remaining["events"]] == [5, 4, 3, 2, 1]
    assert setup_client.get(url + "/events", params={"limit": 0}).status_code == 422
    assert setup_client.get("/api/items", params={"status": "unknown"}).status_code == 422


def test_batch_idempotency_does_not_duplicate_create_history(setup_client):
    _, _, compartment = item_location(setup_client)
    first = add_items(setup_client, compartment["id"], operation_id="same-batch")
    assert first.status_code == 201
    assert add_items(setup_client, compartment["id"], operation_id="same-batch").status_code == 200
    item = first.json()["items"][0]
    assert [row["type"] for row in events(setup_client, item["id"])["events"]] == ["create"]


def test_latest_move_undo_records_new_event_and_restores_position(setup_client):
    _, _, source, item = create_item(setup_client)
    _, _, target = item_location(setup_client, "书房")
    url = f"/api/items/{item['id']}"
    setup_client.patch(url, json={"expected_version": 1, "compartment_id": target["id"]})
    move = events(setup_client, item["id"])["events"][0]
    undone = setup_client.post(url + f"/events/{move['id']}/undo", json={"expected_version": 2})
    assert undone.status_code == 200, undone.text
    assert undone.json()["item"]["compartment_id"] == source["id"]
    assert undone.json()["item"]["version"] == 3
    history = events(setup_client, item["id"])["events"]
    assert [row["type"] for row in history] == ["undo", "move", "create"]
    assert not any(row["can_undo"] for row in history)
    assert setup_client.post(url + f"/events/{move['id']}/undo", json={"expected_version": 3}).status_code == 409


@pytest.mark.parametrize("change", ["edit", "confirm", "missing", "photo", "archive", "second_move", "delete_source", "foreign_source", "stale_version"])
def test_undo_rejects_intervening_change_or_invalid_source(setup_client, change):
    source_room, _, source, item = create_item(setup_client)
    _, _, target = item_location(setup_client, "书房")
    url = f"/api/items/{item['id']}"
    setup_client.patch(url, json={"expected_version": 1, "compartment_id": target["id"]})
    move = events(setup_client, item["id"])["events"][0]
    version = 2
    if change == "edit":
        setup_client.patch(url, json={"expected_version": 2, "notes": "changed"})
        version = 3
    elif change in {"confirm", "missing"}:
        setup_client.post(url + "/" + change, json={"expected_version": 2})
        version = 3
    elif change == "photo":
        setup_client.post(url + "/photo", data={"expected_version": "2"}, files={"image": ("photo.png", png(), "image/png")})
        version = 3
    elif change == "archive":
        setup_client.post(url + "/archive", json={"expected_version": 2, "reason": ""})
        version = 3
    elif change == "second_move":
        setup_client.patch(url, json={"expected_version": 2, "compartment_id": source["id"]})
        version = 3
    elif change == "delete_source":
        assert setup_client.delete(f"/api/rooms/{source_room['id']}", params={"expected_version": setup_client.get(f"/api/rooms/{source_room['id']}").json()["room"]["version"]}).status_code == 204
    elif change == "foreign_source":
        foreign = foreign_location(setup_client)
        with db(setup_client) as connection:
            connection.execute("UPDATE item_events SET from_compartment_id=? WHERE id=?", (foreign, move["id"]))
    else:
        version = 1
    result = setup_client.post(url + f"/events/{move['id']}/undo", json={"expected_version": version})
    assert result.status_code == 409
    assert events(setup_client, item["id"])["events"][0]["type"] != "undo"


def test_container_move_is_recorded_for_each_item_and_not_undoable(setup_client):
    _, container, _, item = create_item(setup_client)
    target = create_room(setup_client, name="书房")
    moved = setup_client.patch(f"/api/containers/{container['id']}", json={"room_id": target["id"], "expected_version": container["version"]})
    assert moved.status_code == 200
    event = events(setup_client, item["id"])["events"][0]
    assert event["type"] == "container_move" and event["can_undo"] is False
    assert event["from_path"] == ["1 层", "主卧", "衣柜", "顶层"]
    assert event["to_path"] == ["1 层", "书房", "衣柜", "顶层"]
    assert event["item_version"] == 2
    response = setup_client.post(f"/api/items/{item['id']}/events/{event['id']}/undo", json={"expected_version": 2})
    assert response.status_code == 409


def test_legacy_events_never_invent_old_names_or_allow_undo(setup_client):
    _, _, source, item = create_item(setup_client)
    with db(setup_client) as connection:
        connection.execute("INSERT INTO item_events(id,item_id,from_compartment_id,to_compartment_id,user_id,created_at) VALUES ('legacy',?,?,?,?,?)", (item["id"], source["id"], source["id"], "gone-user", "2025-01-01"))
    legacy = next(row for row in events(setup_client, item["id"])["events"] if row["id"] == "legacy")
    assert legacy["legacy"] is True and legacy["can_undo"] is False
    assert legacy["from_path"] is None and legacy["to_path"] is None
    assert legacy["actor_name"] is None and legacy["item_version"] is None


@pytest.mark.parametrize("operation", ["archive", "restore", "update", "confirm", "photo", "container_move"])
def test_history_failure_rolls_back_business_change_and_new_photo(setup_client, operation):
    room, container, source, item = create_item(setup_client)
    url = f"/api/items/{item['id']}"
    if operation == "restore":
        item = archive(setup_client, item).json()["item"]
    reject_events(setup_client, operation)
    if operation == "archive":
        response = archive(setup_client, item)
    elif operation == "restore":
        response = setup_client.post(url + "/restore", json={"expected_version": 2, "compartment_id": source["id"]})
    elif operation == "update":
        response = setup_client.patch(url, json={"expected_version": 1, "name": "should rollback"})
    elif operation == "confirm":
        response = setup_client.post(url + "/confirm", json={"expected_version": 1})
    elif operation == "photo":
        response = setup_client.post(url + "/photo", data={"expected_version": "1"}, files={"image": ("photo.png", png(), "image/png")})
    else:
        target = create_room(setup_client, name="书房")
        response = setup_client.patch(f"/api/containers/{container['id']}", json={"room_id": target["id"]})
    assert response.status_code == 500 and response.json()["error"]["code"] == "internal_error"
    current = setup_client.get(url).json()["item"]
    assert current["version"] == item["version"]
    assert current["name"] == "护照" and current["archived_at"] == item["archived_at"]
    assert current["compartment_id"] == item["compartment_id"]
    assert current["photo_url"] is None
    assert not list((setup_client.app.state.settings.data_dir / "media").glob("*.jpg"))
    assert setup_client.get(f"/api/rooms/{room['id']}").json()["containers"][0]["id"] == container["id"]
