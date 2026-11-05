import io
from dataclasses import replace

from fastapi.testclient import TestClient
from PIL import Image

from app.security import hash_password
from test_items import add_items, db, foreign_location, item_location


def photo_bytes(color="red", size=(1600, 800)):
    output = io.BytesIO()
    image = Image.new("RGB", size, color)
    image.save(output, format="JPEG", quality=90)
    image.close()
    return output.getvalue()


def item_with_photo(client, color="red", size=(1600, 800)):
    _, _, compartment = item_location(client)
    item = add_items(client, compartment["id"]).json()["items"][0]
    response = client.post(f"/api/items/{item['id']}/photo", data={"expected_version": "1"},
                           files={"image": ("test.jpg", photo_bytes(color, size), "image/jpeg")})
    assert response.status_code == 200
    return response.json()["item"]


def test_thumbnail_is_authenticated_320px_jpeg_without_changing_original(setup_client):
    item = item_with_photo(setup_client)
    assert item["thumbnail_url"] and "variant=thumbnail" in item["thumbnail_url"]
    original = setup_client.get(item["photo_url"])
    thumbnail = setup_client.get(item["thumbnail_url"])
    assert original.status_code == thumbnail.status_code == 200
    assert thumbnail.headers["content-type"] == "image/jpeg"
    assert thumbnail.headers["cache-control"] == "private, no-store"
    assert Image.open(io.BytesIO(original.content)).size == (1600, 800)
    assert Image.open(io.BytesIO(thumbnail.content)).size == (320, 160)
    assert len(thumbnail.content) < len(original.content)
    current = setup_client.get(f"/api/items/{item['id']}").json()["item"]
    assert current["version"] == 2
    assert len(setup_client.get(f"/api/items/{item['id']}/events").json()["events"]) == 2


def test_thumbnail_cache_stays_outside_media_and_reuses_bytes(setup_client):
    item = item_with_photo(setup_client)
    first = setup_client.get(item["thumbnail_url"])
    data_dir = setup_client.app.state.settings.data_dir
    cached = list((data_dir / "cache").rglob("*.jpg"))
    assert len(cached) == 1
    assert len(list((data_dir / "media").iterdir())) == 1
    cached_time = cached[0].stat().st_mtime_ns
    second = setup_client.get(item["thumbnail_url"])
    assert second.status_code == 200 and second.content == first.content
    assert cached[0].stat().st_mtime_ns == cached_time
    assert cached[0].read_bytes() == first.content


def test_replacing_photo_cannot_serve_old_thumbnail_even_through_old_url(setup_client):
    item = item_with_photo(setup_client)
    first = setup_client.get(item["thumbnail_url"])
    result = setup_client.post(f"/api/items/{item['id']}/photo", data={"expected_version": "2"},
                               files={"image": ("new.jpg", photo_bytes("blue"), "image/jpeg")})
    assert result.status_code == 200
    new_item = result.json()["item"]
    second = setup_client.get(new_item["thumbnail_url"])
    assert second.status_code == 200 and second.content != first.content
    assert setup_client.get(item["thumbnail_url"]).content == second.content
    assert Image.open(io.BytesIO(second.content)).getpixel((10, 10))[2] > 200


def test_warm_thumbnail_cache_does_not_bypass_auth_or_household(setup_client):
    item = item_with_photo(setup_client)
    assert setup_client.get(item["thumbnail_url"]).status_code == 200
    foreign_location(setup_client)
    with db(setup_client) as connection:
        connection.execute("INSERT INTO users(id,household_id,username,password_hash,display_name,role,created_at) VALUES ('foreign-user','other-home','foreign',?,'foreign','owner','2026')", (hash_password("password123"),))
    outsider = TestClient(setup_client.app)
    assert outsider.post("/api/auth/login", json={"username": "foreign", "password": "password123"}).status_code == 200
    assert outsider.get(item["thumbnail_url"]).status_code == 404
    setup_client.post("/api/auth/logout")
    assert setup_client.get(item["thumbnail_url"]).status_code == 401
    assert setup_client.get("/cache/" + next((setup_client.app.state.settings.data_dir / "cache").rglob("*.jpg")).name).headers.get("content-type", "").startswith("text/html")


def test_deleted_original_photo_cannot_be_read_from_cached_thumbnail(setup_client):
    item = item_with_photo(setup_client)
    assert setup_client.get(item["thumbnail_url"]).status_code == 200
    with db(setup_client) as connection:
        filename = connection.execute("SELECT photo_path FROM items WHERE id=?", (item["id"],)).fetchone()[0]
    (setup_client.app.state.settings.data_dir / "media" / filename).unlink()
    assert setup_client.get(item["thumbnail_url"]).status_code == 404


def test_thumbnail_without_photo_and_invalid_variant_are_explicit(setup_client):
    _, _, compartment = item_location(setup_client)
    item = add_items(setup_client, compartment["id"]).json()["items"][0]
    assert item["thumbnail_url"] is None
    assert setup_client.get(f"/api/items/{item['id']}/photo?variant=thumbnail").status_code == 404
    assert setup_client.get(f"/api/items/{item['id']}/photo?variant=public").status_code == 422


def test_small_photo_is_not_enlarged_and_archived_photo_keeps_thumbnail(setup_client):
    item = item_with_photo(setup_client, size=(80, 40))
    assert Image.open(io.BytesIO(setup_client.get(item["thumbnail_url"]).content)).size == (80, 40)
    archived = setup_client.post(f"/api/items/{item['id']}/archive", json={"expected_version": 2, "reason": ""}).json()["item"]
    assert setup_client.get(archived["thumbnail_url"]).status_code == 200


def test_thumbnail_url_preserves_deployment_base_path(setup_client):
    setup_client.app.state.settings = replace(setup_client.app.state.settings, base_path="/wuwei")
    item = item_with_photo(setup_client)
    assert item["thumbnail_url"].startswith(f"/wuwei/api/items/{item['id']}/photo?")
