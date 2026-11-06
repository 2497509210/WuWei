from concurrent.futures import ThreadPoolExecutor
import io
import sqlite3
import threading

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from test_items import db, foreign_location, item_location, png
from test_rooms import create_room


def quick(client, compartment_id, *, name="护照", operation_id="quick-1", image=None):
    files = {"image": ("photo.png", image, "image/png")} if image is not None else None
    return client.post("/api/items/quick", data={"name": name, "compartment_id": compartment_id, "operation_id": operation_id}, files=files)


def counts(client):
    with db(client) as connection:
        return tuple(connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                     for table in ["items", "item_events", "item_quick_operations"])


def test_location_endpoints_follow_container_move_and_names(setup_client):
    _, container, compartment = item_location(setup_client)
    response = setup_client.get(f"/api/containers/{container['id']}")
    assert response.status_code == 200, response.text
    assert response.json()["container"]["id"] == container["id"]
    assert response.json()["room"]["container_count"] == 1
    location_url = f"/api/locations/compartments/{compartment['id']}"
    first = setup_client.get(location_url)
    assert first.status_code == 200, first.text
    assert first.json()["location"] == {
        "room_id": container["room_id"], "container_id": container["id"],
        "compartment_id": compartment["id"], "path": ["1 层", "主卧", "衣柜", "顶层"],
    }
    renamed = setup_client.patch(f"/api/compartments/{compartment['id']}", json={"expected_container_version": 1, "custom_name": "证件"})
    assert renamed.status_code == 200
    target = create_room(setup_client, name="书房")
    assert setup_client.patch(f"/api/containers/{container['id']}", json={"room_id": target["id"], "expected_version": 2}).status_code == 200
    updated = setup_client.get(location_url).json()["location"]
    assert updated["room_id"] == target["id"]
    assert updated["path"] == ["1 层", "书房", "衣柜", "证件"]
    assert setup_client.get(f"/api/containers/{container['id']}").json()["room"]["id"] == target["id"]


def test_location_routes_hide_foreign_and_deleted_ids_and_require_login(setup_client):
    _, container, compartment = item_location(setup_client)
    foreign = foreign_location(setup_client)
    assert setup_client.get("/api/containers/other-box").status_code == 404
    assert setup_client.get(f"/api/locations/compartments/{foreign}").status_code == 404
    assert setup_client.delete(f"/api/containers/{container['id']}", params={"expected_version": setup_client.get(f"/api/containers/{container['id']}").json()["container"]["version"]}).status_code == 204
    assert setup_client.get(f"/api/containers/{container['id']}").status_code == 404
    assert setup_client.get(f"/api/locations/compartments/{compartment['id']}").status_code == 404
    setup_client.post("/api/auth/logout")
    assert setup_client.get("/api/containers/other-box").status_code == 401
    assert setup_client.get(f"/api/locations/compartments/{foreign}").status_code == 401


@pytest.mark.parametrize("with_image", [False, True])
def test_quick_creation_and_retry_are_atomic_and_idempotent(setup_client, with_image):
    _, _, compartment = item_location(setup_client)
    data = png() if with_image else None
    response = quick(setup_client, compartment["id"], name=" 护照 ", image=data)
    assert response.status_code == 201, response.text
    item = response.json()["item"]
    assert item["name"] == "护照" and item["compartment_id"] == compartment["id"]
    assert item["version"] == (2 if with_image else 1)
    if with_image:
        photo = setup_client.get(item["photo_url"])
        assert photo.status_code == 200 and photo.headers["content-type"] == "image/jpeg"
        assert Image.open(io.BytesIO(photo.content)).size == (8, 8)
    else:
        assert item["photo_url"] is None
    retry = quick(setup_client, compartment["id"], name="护照", image=data)
    assert retry.status_code == 200
    assert retry.json()["item"] == item
    assert counts(setup_client) == (1, 2 if with_image else 1, 1)
    assert len(list((setup_client.app.state.settings.data_dir / "media").glob("*.jpg"))) == (1 if with_image else 0)
    events = setup_client.get(f"/api/items/{item['id']}/events").json()["events"]
    assert [event["type"] for event in events] == (["photo", "create"] if with_image else ["create"])


@pytest.mark.parametrize("change", ["name", "location", "photo", "omit_photo"])
def test_same_operation_id_with_different_content_conflicts_without_side_effects(setup_client, change):
    _, container, compartment = item_location(setup_client)
    original = quick(setup_client, compartment["id"], image=png())
    assert original.status_code == 201
    encoded = io.BytesIO()
    Image.new("RGB", (8, 8), "blue").save(encoded, format="PNG")
    result = quick(setup_client, container["compartments"][1]["id"] if change == "location" else compartment["id"],
                   name="新名字" if change == "name" else "护照",
                   image=None if change == "omit_photo" else encoded.getvalue() if change == "photo" else png())
    assert result.status_code == 409 and result.json()["error"]["code"] == "operation_conflict"
    assert counts(setup_client) == (1, 2, 1)
    assert len(list((setup_client.app.state.settings.data_dir / "media").glob("*.jpg"))) == 1


def test_replay_after_archive_and_source_room_deletion_returns_original_item(setup_client):
    room, _, compartment = item_location(setup_client)
    created = quick(setup_client, compartment["id"], image=png())
    assert created.status_code == 201
    item = created.json()["item"]
    assert setup_client.post(f"/api/items/{item['id']}/archive", json={"expected_version": 2, "reason": ""}).status_code == 200
    assert setup_client.delete(f"/api/rooms/{room['id']}", params={"expected_version": setup_client.get(f"/api/rooms/{room['id']}").json()["room"]["version"]}).status_code == 204
    replay = quick(setup_client, compartment["id"], image=png())
    assert replay.status_code == 200
    assert replay.json()["item"]["id"] == item["id"] and replay.json()["item"]["archived_at"]
    assert counts(setup_client) == (1, 3, 1)


@pytest.mark.parametrize("invalid,status", [(b"not-image", 400), (b"x" * (8 * 1024 * 1024 + 1), 413)])
def test_invalid_photo_never_creates_partial_item(setup_client, invalid, status):
    _, _, compartment = item_location(setup_client)
    result = quick(setup_client, compartment["id"], image=invalid)
    assert result.status_code == status
    assert counts(setup_client) == (0, 0, 0)
    assert not list((setup_client.app.state.settings.data_dir / "media").glob("*"))


def test_image_pixel_limit_is_shared_with_existing_upload(setup_client):
    _, _, compartment = item_location(setup_client)
    image = io.BytesIO()
    Image.new("RGB", (5000, 4001)).save(image, format="PNG")
    result = quick(setup_client, compartment["id"], image=image.getvalue())
    assert result.status_code == 400 and result.json()["error"]["code"] == "invalid_image"
    assert counts(setup_client) == (0, 0, 0)


@pytest.mark.parametrize("name", [" ", "x" * 121])
def test_quick_name_validation_leaves_no_operation_record(setup_client, name):
    _, _, compartment = item_location(setup_client)
    assert quick(setup_client, compartment["id"], name=name).status_code == 422
    assert counts(setup_client) == (0, 0, 0)


def test_quick_requires_same_household_and_authentication(setup_client):
    _, _, compartment = item_location(setup_client)
    foreign = foreign_location(setup_client)
    assert quick(setup_client, foreign, image=png()).status_code == 404
    assert quick(setup_client, "deleted").status_code == 404
    setup_client.post("/api/auth/logout")
    assert quick(setup_client, compartment["id"], image=png()).status_code == 401
    with db(setup_client) as connection:
        assert connection.execute("SELECT COUNT(*) FROM item_quick_operations").fetchone()[0] == 0


@pytest.mark.parametrize("stage", ["create", "photo", "operation"])
def test_quick_transaction_failure_cleans_item_history_and_new_photo(setup_client, stage):
    _, _, compartment = item_location(setup_client)
    with db(setup_client) as connection:
        if stage == "operation":
            connection.execute("CREATE TRIGGER reject_quick BEFORE INSERT ON item_quick_operations BEGIN SELECT RAISE(ABORT, 'operation failed'); END")
        else:
            connection.execute(f"CREATE TRIGGER reject_quick BEFORE INSERT ON item_events WHEN NEW.event_type='{stage}' BEGIN SELECT RAISE(ABORT, 'history failed'); END")
    response = quick(setup_client, compartment["id"], image=png())
    assert response.status_code == 500 and response.json()["error"]["code"] == "internal_error"
    assert counts(setup_client) == (0, 0, 0)
    assert not list((setup_client.app.state.settings.data_dir / "media").glob("*.jpg"))


def test_quick_rechecks_session_after_image_decoding(setup_client, monkeypatch):
    from app.routers import items
    _, _, compartment = item_location(setup_client)
    real_encode = items.encode_photo

    def encode_and_revoke(source):
        result = real_encode(source)
        with db(setup_client) as connection:
            connection.execute("UPDATE sessions SET revoked_at='2026-01-01'")
        return result

    monkeypatch.setattr(items, "encode_photo", encode_and_revoke)
    result = quick(setup_client, compartment["id"], image=png())
    assert result.status_code == 401
    assert counts(setup_client) == (0, 0, 0)
    assert not list((setup_client.app.state.settings.data_dir / "media").glob("*.jpg"))


def test_concurrent_identical_quick_requests_create_one_item(setup_client):
    _, _, compartment = item_location(setup_client)
    token = setup_client.cookies.get("wuwei_session")
    ready = threading.Barrier(2)

    def submit():
        browser = TestClient(setup_client.app)
        browser.cookies.set("wuwei_session", token)
        ready.wait(timeout=5)
        return quick(browser, compartment["id"], image=png())

    with ThreadPoolExecutor(max_workers=2) as executor:
        pending = [executor.submit(submit) for _ in range(2)]
        results = [future.result(timeout=5) for future in pending]
    assert sorted(response.status_code for response in results) == [200, 201]
    assert results[0].json()["item"]["id"] == results[1].json()["item"]["id"]
    assert counts(setup_client) == (1, 2, 1)
