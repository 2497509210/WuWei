import json
import os
import time

import pytest

from app import admin
from test_photo_thumbnails import item_with_photo, photo_bytes


def call(data, *extra):
    return admin.main(["clean-thumbnails", "--data-dir", str(data), *extra])


def old(path):
    when = time.time() - 8 * 86400
    os.utime(path, (when, when))


def test_cleanup_previews_then_removes_only_old_unreferenced_managed_thumbnails(setup_client, capsys):
    data = setup_client.app.state.settings.data_dir
    item = item_with_photo(setup_client)
    setup_client.get(item["thumbnail_url"])
    orphan = next((data / "cache").iterdir())
    response = setup_client.post(f"/api/items/{item['id']}/photo", data={"expected_version": item["version"]}, files={"image": ("new.jpg", photo_bytes("blue"), "image/jpeg")})
    current = response.json()["item"]
    setup_client.get(current["thumbnail_url"])
    retained = next(path for path in (data / "cache").iterdir() if path != orphan)
    old(orphan); old(retained)
    # Archived item photos still matter and must stay referenced.
    assert setup_client.post(f"/api/items/{item['id']}/archive", json={"expected_version": current["version"], "reason": "fixture"}).status_code == 200
    fresh = data / "cache" / ("f" * 64 + ".jpg"); fresh.write_bytes(b"recent")
    unknown = data / "cache" / "notes.txt"; unknown.write_text("leave alone"); old(unknown)
    media_before = {path.name: path.read_bytes() for path in (data / "media").iterdir()}
    assert call(data) == 0
    report = json.loads(capsys.readouterr().out)
    assert report["candidates"] == [orphan.name] and report["deleted"] == 0
    assert orphan.exists()
    assert call(data, "--apply") == 0
    report = json.loads(capsys.readouterr().out)
    assert report["deleted"] == 1 and not orphan.exists()
    assert retained.exists() and fresh.exists() and unknown.exists()
    assert {path.name: path.read_bytes() for path in (data / "media").iterdir()} == media_before


def test_cleanup_requires_existing_database_and_does_not_create_directories(tmp_path, capsys):
    assert call(tmp_path / "missing") == 1
    assert not (tmp_path / "missing").exists()
    assert "not found" in capsys.readouterr().err


def test_cleanup_rejects_symlink_cache_directory(setup_client, tmp_path):
    data = setup_client.app.state.settings.data_dir
    outside = tmp_path / "unrelated"; outside.mkdir()
    target = outside / ("a" * 64 + ".jpg"); target.write_bytes(b"keep"); old(target)
    try:
        (data / "cache").symlink_to(outside, target_is_directory=True)
    except OSError:
        pytest.skip("Host does not permit symbolic links")
    assert call(data, "--apply") == 1
    assert target.exists()
