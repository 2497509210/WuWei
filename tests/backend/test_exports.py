import csv
import io
import json

import pytest

from test_items import add_items, db, foreign_location, item_location


@pytest.fixture
def export_client(setup_client):
    # The application registration is owned by the integration task.
    try:
        from app.routers.exports import router
    except ImportError:
        return setup_client
    if not any(getattr(route, "path", "") == "/api/inventory/export" for route in setup_client.app.routes):
        setup_client.app.include_router(router)
    return setup_client


def export(client, **payload):
    return client.post("/api/inventory/export", json={"format": "json", "scope": "filtered", **payload})


def seed(client):
    _, _, compartment = item_location(client)
    created = add_items(client, compartment["id"], ["护照", "100%棉_布", "备用线材"]).json()["items"]
    client.patch(f"/api/items/{created[0]['id']}", json={"expected_version": 1, "aliases": ["旅行证件", "Passport"], "notes": '备注,含"引号"\n下一行'})
    client.post(f"/api/items/{created[2]['id']}/archive", json={"expected_version": 1, "reason": "已换新"})
    return compartment, created


def test_json_export_metadata_fields_and_scope_match_list(export_client):
    compartment, created = seed(export_client)
    result = export(export_client)
    assert result.status_code == 200, result.text
    assert result.headers["content-disposition"] == 'attachment; filename="wuwei-inventory.json"'
    assert result.headers["cache-control"] == "no-store"
    assert result.headers["x-content-type-options"] == "nosniff"
    data = result.json()
    assert data["schema_version"] == 1 and data["exported_at"] and data["scope"] == "filtered"
    assert data["item_count"] == 2
    assert [row["id"] for row in data["items"]] == [row["id"] for row in export_client.get("/api/items").json()["items"]]
    row = next(row for row in data["items"] if row["id"] == created[0]["id"])
    assert row["aliases"] == ["旅行证件", "Passport"] and row["notes"] == '备注,含"引号"\n下一行'
    assert row["location_path"] == ["1 层", "主卧", "衣柜", "顶层"]
    assert row["has_photo"] is False and row["created_at"]
    assert row["compartment_id"] == compartment["id"]


@pytest.mark.parametrize("query", ["旅行", "passport", "%", "_", "下一行", " 不存在 "])
def test_filtered_export_has_exactly_the_list_search_semantics(export_client, query):
    compartment, _ = seed(export_client)
    expected = export_client.get("/api/items", params={"q": query, "compartment_id": compartment["id"]}).json()["items"]
    result = export(export_client, q=query, compartment_id=compartment["id"])
    assert result.status_code == 200, result.text
    assert [row["id"] for row in result.json()["items"]] == [row["id"] for row in expected]


def test_all_and_selected_include_archived_without_leaking_paths(export_client):
    _, created = seed(export_client)
    with db(export_client) as connection:
        connection.execute("UPDATE items SET photo_path='/private/media/photo.jpg' WHERE id=?", (created[0]["id"],))
    foreign_location(export_client)
    all_items = export(export_client, scope="all").json()
    assert all_items["item_count"] == 3
    assert next(row for row in all_items["items"] if row["id"] == created[0]["id"])["has_photo"] is True
    archived = next(row for row in all_items["items"] if row["id"] == created[2]["id"])
    assert archived["status"] == "archived" and archived["compartment_id"] is None and archived["location_path"][-1] == "顶层"
    assert archived["archive_reason"] == "已换新"
    text = json.dumps(all_items)
    for forbidden in ["photo_url", "photo_path", "/private/", "password", "token", "other-item", "household_id"]:
        assert forbidden not in text
    result = export(export_client, scope="selected", ids=[created[2]["id"], created[0]["id"]])
    assert result.status_code == 200
    assert {row["id"] for row in result.json()["items"]} == {created[2]["id"], created[0]["id"]}
    filtered = export(export_client, status="archived").json()
    assert [row["id"] for row in filtered["items"]] == [created[2]["id"]]


def test_selected_rejects_entire_export_for_missing_or_foreign_id(export_client):
    _, created = seed(export_client)
    foreign_location(export_client)
    for invalid in ["missing", "other-item"]:
        result = export(export_client, scope="selected", ids=[created[0]["id"], invalid])
        assert result.status_code == 404
        assert result.json()["error"]["code"] == "item_not_found"
        assert "content-disposition" not in result.headers
    assert export(export_client, compartment_id="other-slot").status_code == 404


@pytest.mark.parametrize("payload", [
    {"scope": "selected", "ids": []}, {"scope": "selected", "ids": ["same", "same"]},
    {"scope": "selected", "ids": [str(i) for i in range(101)]}, {"scope": "selected"},
    {"scope": "selected", "ids": ["one"], "status": "active"}, {"scope": "selected", "ids": ["one"], "q": ""},
    {"scope": "all", "status": "active"}, {"scope": "all", "compartment_id": "cp"},
    {"scope": "filtered", "ids": ["one"]}, {"format": "html"}, {"unexpected": "value"},
])
def test_export_rejects_ambiguous_or_invalid_scope(export_client, payload):
    result = export(export_client, **payload)
    assert result.status_code == 422
    assert "content-disposition" not in result.headers


@pytest.mark.parametrize("unsafe", ["=SUM(1,2)", "+cmd", "-1+1", "@SUM(1,2)", "  =cmd", "\t=cmd", "\r@cmd", "\n+cmd", "\ufeff=cmd"])
def test_csv_formula_cells_are_textual_but_json_keeps_raw_values(export_client, unsafe):
    _, _, compartment = item_location(export_client)
    item = add_items(export_client, compartment["id"], ["safe"]).json()["items"][0]
    with db(export_client) as connection:
        connection.execute("UPDATE items SET name=?,notes=?,aliases_json=?,archive_reason=? WHERE id=?", (unsafe, unsafe, json.dumps([unsafe]), unsafe, item["id"]))
    result = export(export_client, format="csv")
    assert result.status_code == 200, result.text
    assert result.content.startswith(b"\xef\xbb\xbf")
    assert result.headers["content-disposition"] == 'attachment; filename="wuwei-inventory.csv"'
    row = next(csv.DictReader(io.StringIO(result.content.decode("utf-8-sig"))))
    for field in ["名称", "备注", "别名", "归档原因"]:
        assert row[field].startswith("'")
    raw = export(export_client).json()["items"][0]
    assert raw["name"] == unsafe and raw["notes"] == unsafe and raw["aliases"] == [unsafe]


def test_csv_round_trips_unicode_quotes_commas_and_newlines(export_client):
    _, created = seed(export_client)
    result = export(export_client, format="csv")
    rows = list(csv.DictReader(io.StringIO(result.content.decode("utf-8-sig"))))
    row = next(row for row in rows if row["ID"] == created[0]["id"])
    assert row["名称"] == "护照" and row["备注"] == '备注,含"引号"\n下一行'
    assert row["位置路径"] == "1 层 / 主卧 / 衣柜 / 顶层"
    assert row["状态"] == "在用" and row["有照片"] == "否"


def test_export_cap_is_explicit_and_applies_after_filtering(export_client):
    household = export_client.get("/api/me").json()["household"]["id"]
    with db(export_client) as connection:
        connection.executemany("INSERT INTO items(id,household_id,name,created_at,updated_at) VALUES (?,?,?,?,?)",
                               [(f"item-{i}", household, "match" if i == 0 else "other", "2026-11-05", "2026-11-05") for i in range(10001)])
    result = export(export_client, scope="all")
    assert result.status_code == 413 and result.json()["error"]["code"] == "export_limit_exceeded"
    assert "content-disposition" not in result.headers
    filtered = export(export_client, q="match")
    assert filtered.status_code == 200 and filtered.json()["item_count"] == 1
    with db(export_client) as connection:
        connection.execute("DELETE FROM items WHERE id='item-10000'")
    assert export(export_client, scope="all").json()["item_count"] == 10000


def test_export_checks_active_session_and_disabled_account(export_client):
    with db(export_client) as connection:
        connection.execute("UPDATE users SET disabled_at='2026-11-05' WHERE username='owner'")
    result = export(export_client)
    assert result.status_code == 401 and "content-disposition" not in result.headers


def test_export_reads_one_snapshot_for_session_and_rows(export_client, monkeypatch):
    from app.routers import exports
    _, created = seed(export_client)
    actual = exports.require_session
    def concurrent_update(connection, request):
        user = actual(connection, request)
        with db(export_client) as writer:
            writer.execute("UPDATE items SET name='concurrent rename' WHERE id=?", (created[0]["id"],))
        return user
    monkeypatch.setattr(exports, "require_session", concurrent_update)
    result = export(export_client)
    assert result.status_code == 200
    assert next(row for row in result.json()["items"] if row["id"] == created[0]["id"])["name"] == "护照"
