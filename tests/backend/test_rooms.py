import sqlite3

from conftest import setup_household


def create_room(client, name="主卧", width=460, depth=360, height=260):
    response = client.post(
        "/api/rooms",
        json={"name": name, "width_cm": width, "depth_cm": depth, "height_cm": height},
    )
    assert response.status_code == 201, response.text
    return response.json()["room"]


def create_container(client, room_id, preset="wardrobe", name="衣柜", layers=3):
    response = client.post(
        "/api/containers",
        json={
            "room_id": room_id,
            "preset": preset,
            "name": name,
            "x_cm": 100,
            "z_cm": 80,
            "width_cm": 180,
            "depth_cm": 58,
            "height_cm": 220,
            "rot_deg": 0,
            "config": {"layers": layers, "cols": 1, "doors": 2},
        },
    )
    assert response.status_code == 201, response.text
    return response.json()["container"]


def test_bootstrap_creates_default_floor(setup_client):
    response = setup_client.get("/api/bootstrap")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["household"]["name"] == "我家"
    assert len(body["floors"]) == 1
    assert body["floors"][0]["name"] == "1 层"
    assert body["floors"][0]["rooms"] == []


def test_create_room_and_read_it_back(setup_client):
    room = create_room(setup_client)
    assert room["name"] == "主卧"
    assert room["width_cm"] == 460

    detail = setup_client.get(f"/api/rooms/{room['id']}")
    assert detail.status_code == 200
    assert detail.json()["room"]["id"] == room["id"]
    assert detail.json()["containers"] == []

    bootstrap = setup_client.get("/api/bootstrap").json()
    rooms = bootstrap["floors"][0]["rooms"]
    assert rooms[0]["id"] == room["id"]
    assert rooms[0]["container_count"] == 0


def test_room_validation(setup_client):
    response = setup_client.post(
        "/api/rooms",
        json={"name": "", "width_cm": 10, "depth_cm": 10, "height_cm": 10},
    )
    assert response.status_code == 422


def test_unauthorized_room_access(client):
    assert client.get("/api/bootstrap").status_code == 401
    assert client.post("/api/rooms", json={"name": "x", "width_cm": 460, "depth_cm": 360, "height_cm": 260}).status_code == 401


def test_wardrobe_compartments_follow_layer_count(setup_client):
    room = create_room(setup_client)
    wardrobe = create_container(setup_client, room["id"], layers=4)
    assert len(wardrobe["compartments"]) == 4
    assert {c["kind"] for c in wardrobe["compartments"]} == {"shelf"}
    assert [c["level_index"] for c in wardrobe["compartments"]] == [0, 1, 2, 3]

    detail = setup_client.get(f"/api/rooms/{room['id']}").json()
    assert len(detail["containers"]) == 1
    assert len(detail["containers"][0]["compartments"]) == 4


def test_patch_container_layers_adds_and_removes(setup_client):
    room = create_room(setup_client)
    wardrobe = create_container(setup_client, room["id"], layers=3)

    more = setup_client.patch(f"/api/containers/{wardrobe['id']}", json={"config": {"layers": 5, "cols": 1, "doors": 2}})
    assert more.status_code == 200, more.text
    assert len(more.json()["container"]["compartments"]) == 5

    less = setup_client.patch(f"/api/containers/{wardrobe['id']}", json={"config": {"layers": 2, "cols": 1, "doors": 2}})
    assert less.status_code == 200, less.text
    assert len(less.json()["container"]["compartments"]) == 2


def test_cannot_remove_layer_that_holds_items(setup_client):
    room = create_room(setup_client)
    wardrobe = create_container(setup_client, room["id"], layers=3)
    household_id = setup_client.get("/api/me").json()["household"]["id"]
    top = [c for c in wardrobe["compartments"] if c["level_index"] == 2][0]

    db_path = setup_client.app.state.settings.data_dir / "wuwei.db"
    with sqlite3.connect(db_path) as connection:
        connection.execute(
            "INSERT INTO items (id, household_id, name, quantity, compartment_id, created_at, updated_at) "
            "VALUES ('item-1', ?, '护照', 1, ?, '2026-11-03T00:00:00+00:00', '2026-11-03T00:00:00+00:00')",
            (household_id, top["id"]),
        )
        connection.commit()

    response = setup_client.patch(
        f"/api/containers/{wardrobe['id']}",
        json={"config": {"layers": 1, "cols": 1, "doors": 2}},
    )
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "compartment_not_empty"


def test_move_container_and_delete_room_cascades(setup_client):
    room = create_room(setup_client)
    wardrobe = create_container(setup_client, room["id"], layers=3)

    moved = setup_client.patch(f"/api/containers/{wardrobe['id']}", json={"x_cm": 220, "z_cm": 140})
    assert moved.status_code == 200
    assert moved.json()["container"]["x_cm"] == 220

    deleted = setup_client.delete(f"/api/rooms/{room['id']}", params={"expected_version": setup_client.get(f"/api/rooms/{room['id']}").json()["room"]["version"]})
    assert deleted.status_code == 204
    assert setup_client.get(f"/api/rooms/{room['id']}").status_code == 404

    db_path = setup_client.app.state.settings.data_dir / "wuwei.db"
    with sqlite3.connect(db_path) as connection:
        assert connection.execute("SELECT COUNT(*) FROM containers").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM compartments").fetchone()[0] == 0


def test_container_bounds_take_rotation_into_account(setup_client):
    room = create_room(setup_client, width=360, depth=460)

    shelf = setup_client.post(
        "/api/containers",
        json={
            "room_id": room["id"],
            "preset": "shelf",
            "name": "置物架",
            "x_cm": 342,
            "z_cm": 60,
            "rot_deg": 270,
            "width_cm": 120,
            "depth_cm": 35,
            "height_cm": 180,
            "config": {"layers": 5, "cols": 1},
        },
    )
    assert shelf.status_code == 201, shelf.text

    too_far = setup_client.post(
        "/api/containers",
        json={
            "room_id": room["id"],
            "preset": "shelf",
            "name": "贴不上的置物架",
            "x_cm": 343,
            "z_cm": 60,
            "rot_deg": 270,
            "width_cm": 120,
            "depth_cm": 35,
            "height_cm": 180,
            "config": {"layers": 5, "cols": 1},
        },
    )
    assert too_far.status_code == 400
    assert too_far.json()["error"]["code"] == "container_out_of_room"

    bed_too_far = setup_client.post(
        "/api/containers",
        json={
            "room_id": room["id"],
            "preset": "bed",
            "name": "床",
            "x_cm": 266,
            "z_cm": 169,
            "rot_deg": 270,
            "width_cm": 180,
            "depth_cm": 200,
            "height_cm": 45,
            "config": {"layers": 1, "cols": 1},
        },
    )
    assert bed_too_far.status_code == 400


def test_rotating_container_that_would_leave_room_is_rejected(setup_client):
    room = create_room(setup_client, width=360, depth=460)
    bed = setup_client.post(
        "/api/containers",
        json={
            "room_id": room["id"],
            "preset": "bed",
            "name": "床",
            "x_cm": 265,
            "z_cm": 169,
            "rot_deg": 0,
            "width_cm": 180,
            "depth_cm": 200,
            "height_cm": 45,
            "config": {"layers": 1, "cols": 1},
        },
    )
    assert bed.status_code == 201, bed.text

    rotated = setup_client.patch(f"/api/containers/{bed.json()['container']['id']}", json={"rot_deg": 270})
    assert rotated.status_code == 400
    assert rotated.json()["error"]["code"] == "container_out_of_room"


def test_non_right_angle_container_rotation_is_rejected(setup_client):
    room = create_room(setup_client)
    container = create_container(setup_client, room["id"])
    response = setup_client.patch(f"/api/containers/{container['id']}", json={"rot_deg": 45})
    assert response.status_code == 422


def test_stale_container_version_does_not_overwrite_move(setup_client):
    room = create_room(setup_client)
    container = create_container(setup_client, room["id"])
    first = setup_client.patch(f"/api/containers/{container['id']}", json={"expected_version": container["version"], "x_cm": 220})
    assert first.status_code == 200
    stale = setup_client.patch(f"/api/containers/{container['id']}", json={"expected_version": container["version"], "x_cm": 300})
    assert stale.status_code == 409
    assert stale.json()["error"]["current"]["x_cm"] == 220
