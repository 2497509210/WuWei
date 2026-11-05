import io
import sqlite3
import uuid
from contextlib import contextmanager
from pathlib import Path

import pytest
from PIL import Image

from test_rooms import create_container, create_room


def item_location(client, room_name="主卧"):
    room = create_room(client, name=room_name)
    container = create_container(client, room["id"])
    return room, container, container["compartments"][0]


def add_items(client, compartment_id, names=None, operation_id=None):
    return client.post("/api/items/batch", json={
        "compartment_id": compartment_id, "names": names or ["护照"],
        "operation_id": operation_id or str(uuid.uuid4()),
    })


@contextmanager
def db(client):
    connection = sqlite3.connect(client.app.state.settings.data_dir / "wuwei.db")
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def foreign_location(client):
    with db(client) as connection:
        connection.execute("INSERT INTO households(id,name,created_at) VALUES ('other-home','别家','2026-01-01')")
        connection.execute("INSERT INTO floors(id,household_id,name,level) VALUES ('other-floor','other-home','2 层',2)")
        connection.execute("INSERT INTO rooms(id,floor_id,name,width_cm,depth_cm,height_cm) VALUES ('other-room','other-floor','客厅',460,360,260)")
        connection.execute("INSERT INTO containers(id,room_id,preset,name,x_cm,z_cm,width_cm,depth_cm,height_cm) VALUES ('other-box','other-room','storage_box','箱子',100,100,100,100,100)")
        connection.execute("INSERT INTO compartments(id,container_id,name,kind) VALUES ('other-slot','other-box','箱内','box')")
        connection.execute("INSERT INTO items(id,household_id,name,quantity,compartment_id,created_at,updated_at) VALUES ('other-item','other-home','护照',1,'other-slot','2026-01-01','2026-01-01')")
    return "other-slot"


def test_batch_records_location_and_idempotent_retry(setup_client):
    _, container, compartment = item_location(setup_client)
    response = add_items(setup_client, compartment["id"], [" 护照 ", "充电头"], "registration-1")
    assert response.status_code == 201, response.text
    items = response.json()["items"]
    assert [item["name"] for item in items] == ["护照", "充电头"]
    assert items[0]["location_path"] == ["1 层", "主卧", "衣柜", "顶层"]
    assert items[0]["container_id"] == container["id"]
    assert items[0]["version"] == 1
    assert items[0]["location_status"] == "confirmed"
    assert items[0]["last_confirmed_at"]
    retry = add_items(setup_client, compartment["id"], [" 护照 ", "充电头"], "registration-1")
    assert retry.status_code == 200
    assert [item["id"] for item in retry.json()["items"]] == [item["id"] for item in items]
    assert len(setup_client.get("/api/items").json()["items"]) == 2
    changed = add_items(setup_client, compartment["id"], ["钥匙"], "registration-1")
    assert changed.status_code == 409


def test_chinese_search_matches_alias_notes_and_literal_wildcards(setup_client):
    _, _, compartment = item_location(setup_client)
    items = add_items(setup_client, compartment["id"], ["充电头", "100%棉_布", "备用钥匙"]).json()["items"]
    result = setup_client.patch(f"/api/items/{items[0]['id']}", json={
        "expected_version": 1, "aliases": ["电源适配器", "插头"], "notes": "旅行时使用", "quantity": 2,
    })
    assert result.status_code == 200, result.text
    for query in ["电源", "旅行", "充电"]:
        found = setup_client.get("/api/items", params={"q": query}).json()["items"]
        assert [item["id"] for item in found] == [items[0]["id"]]
    for query in ["%", "_"]:
        assert [item["name"] for item in setup_client.get("/api/items", params={"q": query}).json()["items"]] == ["100%棉_布"]


def test_move_item_writes_one_event_and_rejects_stale_version(setup_client):
    first_room, _, first = item_location(setup_client)
    second_room, _, second = item_location(setup_client, "书房")
    item = add_items(setup_client, first["id"]).json()["items"][0]
    moved = setup_client.patch(f"/api/items/{item['id']}", json={"expected_version": 1, "compartment_id": second["id"]})
    assert moved.status_code == 200, moved.text
    assert moved.json()["item"]["room_id"] == second_room["id"]
    assert moved.json()["item"]["version"] == 2
    stale = setup_client.patch(f"/api/items/{item['id']}", json={"expected_version": 1, "compartment_id": first["id"]})
    assert stale.status_code == 409
    assert stale.json()["error"]["code"] == "version_conflict"
    assert stale.json()["error"]["current"]["room_id"] == second_room["id"]
    assert setup_client.get("/api/items", params={"compartment_id": first["id"]}).json()["items"] == []
    with db(setup_client) as connection:
        events = connection.execute("SELECT from_compartment_id,to_compartment_id FROM item_events WHERE item_id=? AND event_type='move'", (item["id"],)).fetchall()
    assert events == [(first["id"], second["id"])]


def test_move_is_rolled_back_when_event_insert_fails(setup_client):
    _, _, first = item_location(setup_client)
    _, _, second = item_location(setup_client, "书房")
    item = add_items(setup_client, first["id"]).json()["items"][0]
    with db(setup_client) as connection:
        connection.execute("CREATE TRIGGER reject_event BEFORE INSERT ON item_events BEGIN SELECT RAISE(ABORT, 'event rejected'); END")
    with pytest.raises(sqlite3.IntegrityError):
        setup_client.patch(f"/api/items/{item['id']}", json={"expected_version": 1, "compartment_id": second["id"]})
    unchanged = setup_client.get(f"/api/items/{item['id']}").json()["item"]
    assert unchanged["compartment_id"] == first["id"]
    assert unchanged["version"] == 1


def test_confirmation_and_missing_keep_location_and_check_version(setup_client):
    _, _, compartment = item_location(setup_client)
    item = add_items(setup_client, compartment["id"]).json()["items"][0]
    missing = setup_client.post(f"/api/items/{item['id']}/missing", json={"expected_version": 1})
    assert missing.status_code == 200
    assert missing.json()["item"]["location_status"] == "missing"
    assert missing.json()["item"]["compartment_id"] == compartment["id"]
    assert setup_client.post(f"/api/items/{item['id']}/confirm", json={"expected_version": 1}).status_code == 409
    confirmed = setup_client.post(f"/api/items/{item['id']}/confirm", json={"expected_version": 2})
    assert confirmed.json()["item"]["location_status"] == "confirmed"
    assert confirmed.json()["item"]["version"] == 3
    assert confirmed.json()["item"]["last_confirmed_at"]


def test_item_routes_reject_other_household_and_unauthenticated_access(setup_client):
    _, _, compartment = item_location(setup_client)
    item = add_items(setup_client, compartment["id"]).json()["items"][0]
    other = foreign_location(setup_client)
    assert add_items(setup_client, other).status_code == 404
    assert setup_client.get("/api/items", params={"compartment_id": other}).status_code == 404
    assert setup_client.get("/api/items/other-item").status_code == 404
    assert setup_client.get("/api/items/other-item/photo").status_code == 404
    assert setup_client.patch(f"/api/items/{item['id']}", json={"expected_version": 1, "compartment_id": other}).status_code == 404
    assert [row["id"] for row in setup_client.get("/api/items").json()["items"]] == [item["id"]]
    setup_client.post("/api/auth/logout")
    assert setup_client.get("/api/items").status_code == 401
    assert add_items(setup_client, compartment["id"]).status_code == 401


def png():
    output = io.BytesIO()
    Image.new("RGB", (8, 8), "red").save(output, format="PNG")
    return output.getvalue()


def test_photo_upload_validates_image_and_version_and_requires_auth(setup_client):
    _, _, compartment = item_location(setup_client)
    item = add_items(setup_client, compartment["id"]).json()["items"][0]
    url = f"/api/items/{item['id']}/photo"
    invalid = setup_client.post(url, data={"expected_version": "1"}, files={"image": ("fake.png", b"not an image", "image/png")})
    assert invalid.status_code == 400
    result = setup_client.post(url, data={"expected_version": "1"}, files={"image": ("../../escape.png", png(), "image/png")})
    assert result.status_code == 200, result.text
    assert result.json()["item"]["version"] == 2
    assert result.json()["item"]["photo_url"].startswith(url)
    photo = setup_client.get(result.json()["item"]["photo_url"])
    assert photo.status_code == 200
    assert photo.headers["content-type"] == "image/jpeg"
    assert Image.open(io.BytesIO(photo.content)).size == (8, 8)
    stale = setup_client.post(url, data={"expected_version": "1"}, files={"image": ("new.png", png(), "image/png")})
    assert stale.status_code == 409
    assert len(list((setup_client.app.state.settings.data_dir / "media").glob("*"))) == 1
    setup_client.post("/api/auth/logout")
    assert setup_client.get(url).status_code == 401


@pytest.mark.parametrize("names", [[], ["  "], ["护照", ""], ["x"] * 101])
def test_invalid_batch_never_partially_creates_items(setup_client, names):
    _, _, compartment = item_location(setup_client)
    response = setup_client.post("/api/items/batch", json={"compartment_id": compartment["id"], "names": names, "operation_id": "invalid-batch"})
    assert response.status_code == 422
    assert setup_client.get("/api/items").json()["items"] == []


def test_room_delete_and_shrink_preserve_stored_items(setup_client):
    room, _, compartment = item_location(setup_client)
    item = add_items(setup_client, compartment["id"]).json()["items"][0]
    assert setup_client.delete(f"/api/rooms/{room['id']}", params={"expected_version": setup_client.get(f"/api/rooms/{room['id']}").json()["room"]["version"]}).status_code == 409
    shrink = setup_client.patch(f"/api/rooms/{room['id']}", json={"width_cm": 100})
    assert shrink.status_code == 409
    assert setup_client.get(f"/api/items/{item['id']}").json()["item"]["compartment_id"] == compartment["id"]


def test_move_whole_container_keeps_compartment_ids_and_items(setup_client):
    _, container, compartment = item_location(setup_client)
    item = add_items(setup_client, compartment["id"]).json()["items"][0]
    second = create_room(setup_client, name="书房")
    moved = setup_client.patch(f"/api/containers/{container['id']}", json={"room_id": second["id"], "x_cm": 200, "z_cm": 100})
    assert moved.status_code == 200, moved.text
    assert moved.json()["container"]["room_id"] == second["id"]
    assert [row["id"] for row in moved.json()["container"]["compartments"]] == [row["id"] for row in container["compartments"]]
    updated = setup_client.get(f"/api/items/{item['id']}").json()["item"]
    assert updated["compartment_id"] == compartment["id"]
    assert updated["location_path"] == ["1 层", "书房", "衣柜", "顶层"]
    assert updated["version"] == 2
    foreign_location(setup_client)
    assert setup_client.patch(f"/api/containers/{container['id']}", json={"room_id": "other-room"}).status_code == 404


def test_box_move_checks_destination_bounds(setup_client):
    original, container, _ = item_location(setup_client)
    small = create_room(setup_client, name="小房间", width=100, depth=100)
    rejected = setup_client.patch(f"/api/containers/{container['id']}", json={"room_id": small["id"]})
    assert rejected.status_code == 400
    assert setup_client.get(f"/api/rooms/{original['id']}").json()["containers"][0]["id"] == container["id"]


def test_compartment_ids_survive_layer_addition(setup_client):
    _, container, compartment = item_location(setup_client)
    item = add_items(setup_client, compartment["id"]).json()["items"][0]
    changed = setup_client.patch(f"/api/containers/{container['id']}", json={"config": {"layers": 4}})
    assert changed.status_code == 200
    assert changed.json()["container"]["compartments"][0]["id"] == compartment["id"]
    assert setup_client.get(f"/api/items/{item['id']}").json()["item"]["compartment_id"] == compartment["id"]


def test_box_move_rejects_lower_destination_ceiling(setup_client):
    original, container, _ = item_location(setup_client)
    low = create_room(setup_client, name="阁楼", height=210)
    response = setup_client.patch(f"/api/containers/{container['id']}", json={"room_id": low["id"]})
    assert response.status_code == 400
    assert setup_client.get(f"/api/rooms/{original['id']}").json()["containers"][0]["room_id"] == original["id"]


def test_unplaced_legacy_item_cannot_be_confirmed(setup_client):
    household_id = setup_client.get("/api/me").json()["household"]["id"]
    with db(setup_client) as connection:
        connection.execute("INSERT INTO items(id,household_id,name,created_at,updated_at) VALUES ('unplaced',?,'旧物品','2026-01-01','2026-01-01')", (household_id,))
    result = setup_client.post("/api/items/unplaced/confirm", json={"expected_version": 1})
    assert result.status_code == 409
    assert result.json()["error"]["code"] == "item_has_no_location"
    assert setup_client.get("/api/items/unplaced").json()["item"]["version"] == 1


def test_photo_replacement_succeeds_if_old_file_cleanup_fails(setup_client, monkeypatch):
    _, _, compartment = item_location(setup_client)
    item = add_items(setup_client, compartment["id"]).json()["items"][0]
    url = f"/api/items/{item['id']}/photo"
    first = setup_client.post(url, data={"expected_version": "1"}, files={"image": ("first.png", png(), "image/png")})
    assert first.status_code == 200
    old_path = next((setup_client.app.state.settings.data_dir / "media").glob("*.jpg"))
    original_unlink = Path.unlink

    def locked_old_file(path, *args, **kwargs):
        if path == old_path:
            raise PermissionError("file is open elsewhere")
        return original_unlink(path, *args, **kwargs)

    monkeypatch.setattr(Path, "unlink", locked_old_file)
    result = setup_client.post(url, data={"expected_version": "2"}, files={"image": ("second.png", png(), "image/png")})
    assert result.status_code == 200
    assert result.json()["item"]["version"] == 3
    assert setup_client.get(result.json()["item"]["photo_url"]).status_code == 200
