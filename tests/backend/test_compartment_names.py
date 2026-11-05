from test_items import add_items, foreign_location, item_location


def test_custom_name_survives_layout_sync_and_can_reset_to_default(setup_client):
    room, container, compartment = item_location(setup_client)
    assert compartment["default_name"] == "顶层" and compartment["custom_name"] is None
    item = add_items(setup_client, compartment["id"]).json()["items"][0]
    renamed = setup_client.patch(f"/api/compartments/{compartment['id']}", json={"expected_container_version": 1, "custom_name": " 证件区 "})
    assert renamed.status_code == 200, renamed.text
    container = renamed.json()["container"]
    assert container["version"] == 2
    assert container["compartments"][0]["name"] == "证件区"
    assert container["compartments"][0]["custom_name"] == "证件区"
    changed = setup_client.patch(f"/api/containers/{container['id']}", json={"expected_version": 2, "config": {"layers": 4}})
    assert changed.status_code == 200
    slot = changed.json()["container"]["compartments"][0]
    assert slot["id"] == compartment["id"] and slot["name"] == "证件区"
    assert slot["default_name"] == "第 1 层"
    assert setup_client.get(f"/api/items/{item['id']}").json()["item"]["location_path"][-1] == "证件区"
    reset = setup_client.patch(f"/api/compartments/{compartment['id']}", json={"expected_container_version": 3, "custom_name": None})
    assert reset.status_code == 200
    assert reset.json()["container"]["compartments"][0]["name"] == "第 1 层"


def test_compartment_rename_validates_version_name_and_household(setup_client):
    _, container, compartment = item_location(setup_client)
    url = f"/api/compartments/{compartment['id']}"
    assert setup_client.patch(url, json={"expected_container_version": 1, "custom_name": "   "}).status_code == 422
    assert setup_client.patch(url, json={"custom_name": "证件"}).status_code == 422
    assert setup_client.patch(url, json={"expected_container_version": 1}).status_code == 422
    assert setup_client.patch(url, json={"expected_container_version": 1, "custom_name": "证件"}).status_code == 200
    stale = setup_client.patch(url, json={"expected_container_version": 1, "custom_name": "会覆盖"})
    assert stale.status_code == 409 and stale.json()["error"]["code"] == "version_conflict"
    assert stale.json()["error"]["current"]["compartments"][0]["name"] == "证件"
    foreign = foreign_location(setup_client)
    assert setup_client.patch(f"/api/compartments/{foreign}", json={"expected_container_version": 1, "custom_name": "别家"}).status_code == 404
    setup_client.post("/api/auth/logout")
    assert setup_client.patch(url, json={"expected_container_version": 2, "custom_name": "未登录"}).status_code == 401
