from concurrent.futures import ThreadPoolExecutor

import pytest

from app.routers import items
from test_items import add_items, db, item_location, png
from test_photo_thumbnails import photo_bytes


def make_item(client):
    _, _, slot = item_location(client)
    return add_items(client, slot["id"]).json()["items"][0]


def upload(client, item, operation="replace-once", version=1, content=None):
    return client.post(f"/api/items/{item['id']}/photo",
                       data={"expected_version": str(version), "operation_id": operation},
                       files={"image": ("photo.png", content or png(), "image/png")})


# A response lost after commit must not create another photo/version/history event on retry.
def test_retry_photo_operation_returns_saved_result_without_second_write(setup_client):
    item = make_item(setup_client)
    first = upload(setup_client, item)
    second = upload(setup_client, item)
    assert first.status_code == second.status_code == 200
    assert second.json()["item"] == first.json()["item"]
    with db(setup_client) as connection:
        assert connection.execute("SELECT version FROM items WHERE id=?", (item["id"],)).fetchone()[0] == 2
        assert connection.execute("SELECT COUNT(*) FROM item_events WHERE event_type='photo'").fetchone()[0] == 1
    assert len(list((setup_client.app.state.settings.data_dir / "media").glob("*.jpg"))) == 1


# Reusing the token for another image/version/item is a conflict, never a fresh update.
@pytest.mark.parametrize("changed", ["image", "version", "item"])
def test_photo_operation_rejects_changed_retry(setup_client, changed):
    item = make_item(setup_client)
    assert upload(setup_client, item).status_code == 200
    target = make_item(setup_client) if changed == "item" else item
    content = photo_bytes("blue", (40, 40)) if changed == "image" else None
    response = upload(setup_client, target, version=2 if changed == "version" else 1, content=content)
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "operation_conflict"
    with db(setup_client) as connection:
        assert connection.execute("SELECT COUNT(*) FROM item_events WHERE event_type='photo'").fetchone()[0] == 1


# Replaying an old completed operation must show current data without reverting a later edit.
def test_photo_retry_after_later_edit_returns_current_item_without_reverting(setup_client):
    item = make_item(setup_client)
    assert upload(setup_client, item).status_code == 200
    edited = setup_client.patch(f"/api/items/{item['id']}", json={"expected_version": 2, "notes": "later note"})
    assert edited.status_code == 200
    retried = upload(setup_client, item)
    assert retried.status_code == 200
    assert retried.json()["item"]["version"] == 3
    assert retried.json()["item"]["notes"] == "later note"


# Idempotent replay cannot bypass a revocation while the uploaded image is decoded.
def test_photo_operation_rechecks_session_on_replay_after_decode(setup_client, monkeypatch):
    item = make_item(setup_client)
    assert upload(setup_client, item).status_code == 200
    encode = items.encode_photo
    def revoke(source):
        photo = encode(source)
        with db(setup_client) as connection:
            connection.execute("UPDATE sessions SET revoked_at='2026-01-01'")
        return photo
    monkeypatch.setattr(items, "encode_photo", revoke)
    assert upload(setup_client, item).status_code == 401


# Legacy callers (including an empty optional form value) remain supported; tokens are bounded.
@pytest.mark.parametrize("operation", ["x" * 101])
def test_photo_operation_validates_token(setup_client, operation):
    assert upload(setup_client, make_item(setup_client), operation=operation).status_code == 422


# Two requests arriving together are still one mutation and one file.
def test_concurrent_photo_retry_commits_only_once(setup_client):
    item = make_item(setup_client)
    with ThreadPoolExecutor(max_workers=2) as executor:
        responses = list(executor.map(lambda _: upload(setup_client, item), range(2)))
    assert [response.status_code for response in responses] == [200, 200]
    assert responses[0].json()["item"]["version"] == responses[1].json()["item"]["version"] == 2
    with db(setup_client) as connection:
        assert connection.execute("SELECT COUNT(*) FROM item_events WHERE event_type='photo'").fetchone()[0] == 1
        assert connection.execute("SELECT COUNT(*) FROM item_photo_operations").fetchone()[0] == 1
    assert len(list((setup_client.app.state.settings.data_dir / "media").glob("*.jpg"))) == 1


# A completed operation remains a read-only replay after archive, never reviving or rewriting the record.
def test_photo_replay_after_archive_does_not_modify_archived_item(setup_client):
    item = make_item(setup_client)
    assert upload(setup_client, item).status_code == 200
    archived = setup_client.post(f"/api/items/{item['id']}/archive", json={"expected_version": 2, "reason": "stored"})
    assert archived.status_code == 200
    response = upload(setup_client, item)
    assert response.status_code == 200
    assert response.json()["item"] == archived.json()["item"]
    with db(setup_client) as connection:
        assert connection.execute("SELECT COUNT(*) FROM item_events WHERE event_type='photo'").fetchone()[0] == 1


def test_photo_operation_insert_failure_rolls_back_photo_and_history(setup_client):
    item = make_item(setup_client)
    with db(setup_client) as connection:
        connection.execute("CREATE TRIGGER reject_photo_operation BEFORE INSERT ON item_photo_operations BEGIN SELECT RAISE(ABORT, 'fixture failure'); END")
    response = upload(setup_client, item)
    assert response.status_code == 500
    assert setup_client.get(f"/api/items/{item['id']}").json()["item"] == item
    with db(setup_client) as connection:
        assert connection.execute("SELECT COUNT(*) FROM item_events WHERE event_type='photo'").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM item_photo_operations").fetchone()[0] == 0
    assert list((setup_client.app.state.settings.data_dir / "media").glob("*.jpg")) == []
