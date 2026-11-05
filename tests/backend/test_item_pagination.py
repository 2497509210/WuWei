import json
import time

import pytest

from app.db import connect
from test_items import db, foreign_location, item_location


def seed_rows(client, count, *, compartment_id=None, prefix="sample", names=None):
    household_id = client.get("/api/me").json()["household"]["id"]
    rows = [(f"{prefix}-{index:05d}", household_id, names[index] if names else f"物品 {index:05d}",
             compartment_id, "2026-11-05T00:00:00+00:00", "2026-11-05T00:00:00+00:00")
            for index in range(count)]
    with db(client) as connection:
        connection.executemany(
            "INSERT INTO items(id,household_id,name,compartment_id,created_at,updated_at) VALUES (?,?,?,?,?,?)", rows,
        )
    return [row[0] for row in rows]


def test_default_pagination_and_unpaged_compatibility(setup_client):
    expected_ids = seed_rows(setup_client, 85)
    page = setup_client.get("/api/items", params={"page": 1})
    assert page.status_code == 200
    body = page.json()
    assert {key: body[key] for key in ("total", "page", "page_size", "has_more")} == {
        "total": 85, "page": 1, "page_size": 40, "has_more": True,
    }
    assert [row["id"] for row in body["items"]] == expected_ids[:40]
    sized = setup_client.get("/api/items", params={"page_size": 25}).json()
    assert sized["page"] == 1 and len(sized["items"]) == 25
    legacy = setup_client.get("/api/items").json()
    assert set(legacy) == {"items"} and len(legacy["items"]) == 85
    empty = setup_client.get("/api/items", params={"page": 100}).json()
    assert empty["items"] == [] and empty["total"] == 85 and empty["page"] == 100
    assert empty["has_more"] is False


@pytest.mark.parametrize("query", [
    {"page": 0}, {"page": -1}, {"page_size": 0}, {"page_size": 101},
    {"page": "1.5"}, {"location_status": "unknown"},
])
def test_invalid_page_parameters_are_rejected(setup_client, query):
    response = setup_client.get("/api/items", params=query)
    assert response.status_code == 422


def test_a_thousand_items_have_exact_nonoverlapping_page_boundaries(setup_client):
    expected_ids = seed_rows(setup_client, 1000)
    seen = []
    for page_number in range(1, 26):
        response = setup_client.get("/api/items", params={"page": page_number, "page_size": 40})
        assert response.status_code == 200
        page = response.json()
        assert page["total"] == 1000 and page["has_more"] is (page_number < 25)
        assert [row["id"] for row in page["items"]] == expected_ids[(page_number - 1) * 40:page_number * 40]
        seen.extend(row["id"] for row in page["items"])
    assert seen == expected_ids and len(set(seen)) == 1000


def test_search_ranks_exact_prefix_contains_alias_and_notes(setup_client):
    ids = seed_rows(setup_client, 7, names=["其他记录", "配件", "备用相机", "相机包", "相机", "相机", "不相关"])
    with db(setup_client) as connection:
        connection.execute("UPDATE items SET notes='相机充电线',updated_at='2026-12-01' WHERE id=?", (ids[0],))
        connection.execute("UPDATE items SET aliases_json=?,updated_at='2026-12-02' WHERE id=?", (json.dumps(["相机电源"], ensure_ascii=False), ids[1]))
        connection.execute("UPDATE items SET updated_at='2026-12-03' WHERE id=?", (ids[5],))
    response = setup_client.get("/api/items", params={"q": " 相机 ", "page": 1, "page_size": 100})
    assert response.status_code == 200
    body = response.json()
    assert [row["id"] for row in body["items"]] == [ids[5], ids[4], ids[3], ids[2], ids[1], ids[0]]
    assert body["total"] == 6


@pytest.mark.parametrize("query,expected", [
    ("STRASSE", ["unicode-00000"]), ("%", ["unicode-00001"]),
    ("_", ["unicode-00002"]), ("证", ["unicode-00003"]),
    ("原备注", ["unicode-00004"]), ("' OR 1=1 --", []),
    ("a,b", []),
])
def test_sql_search_preserves_unicode_and_literal_substrings(setup_client, query, expected):
    ids = seed_rows(setup_client, 5, prefix="unicode", names=["Straße", "100%棉", "文件_夹", "护照", "其他"])
    with db(setup_client) as connection:
        connection.execute("UPDATE items SET aliases_json=? WHERE id=?", (json.dumps(["证件", "a", "b"], ensure_ascii=False), ids[3]))
        connection.execute("UPDATE items SET notes='原备注' WHERE id=?", (ids[4],))
    body = setup_client.get("/api/items", params={"q": query, "page": 1}).json()
    assert [row["id"] for row in body["items"]] == expected
    assert body["total"] == len(expected)


def test_room_missing_and_compartment_filters_match_export_without_page_limit(setup_client):
    room, container, compartment = item_location(setup_client)
    _, _, other_compartment = item_location(setup_client, "书房")
    ids = seed_rows(setup_client, 45, compartment_id=compartment["id"], prefix="matching")
    seed_rows(setup_client, 3, compartment_id=other_compartment["id"], prefix="elsewhere")
    with db(setup_client) as connection:
        connection.execute("UPDATE items SET location_status='missing' WHERE id LIKE 'matching-%'")
    query = {"status": "active", "room_id": room["id"], "location_status": "missing", "page": 1}
    page = setup_client.get("/api/items", params=query).json()
    assert len(page["items"]) == 40 and page["total"] == 45
    result = setup_client.post("/api/inventory/export", json={
        "format": "json", "scope": "filtered", "status": "active", "room_id": room["id"], "location_status": "missing",
    })
    assert result.status_code == 200, result.text
    assert [row["id"] for row in result.json()["items"]] == ids
    assert result.json()["item_count"] == 45
    mismatched = setup_client.get("/api/items", params={**query, "compartment_id": other_compartment["id"]}).json()
    assert mismatched["total"] == 0 and mismatched["items"] == []


def test_location_filters_validate_household_before_returning_empty_results(setup_client):
    foreign_location(setup_client)
    for params in ({"room_id": "other-room"}, {"room_id": "deleted-room"}, {"compartment_id": "other-slot"}):
        response = setup_client.get("/api/items", params={"page": 1, **params})
        assert response.status_code == 404
        exported = setup_client.post("/api/inventory/export", json={"format": "json", "scope": "filtered", **params})
        assert exported.status_code == 404
    for scope in ["all", "selected"]:
        response = setup_client.post("/api/inventory/export", json={
            "format": "json", "scope": scope, "room_id": "other-room", **({"ids": ["other-item"]} if scope == "selected" else {}),
        })
        assert response.status_code == 422


def test_archived_filters_do_not_silently_expand_to_active_room(setup_client):
    room, _, compartment = item_location(setup_client)
    ids = seed_rows(setup_client, 2, compartment_id=compartment["id"])
    archived = setup_client.post(f"/api/items/{ids[0]}/archive", json={"expected_version": 1, "reason": ""})
    assert archived.status_code == 200
    page = setup_client.get("/api/items", params={"status": "archived", "page": 1}).json()
    assert [row["id"] for row in page["items"]] == [ids[0]] and page["total"] == 1
    room_page = setup_client.get("/api/items", params={"status": "archived", "room_id": room["id"], "page": 1}).json()
    assert room_page["items"] == [] and room_page["total"] == 0


@pytest.mark.parametrize("count", [1000, 5000])
def test_database_limits_materialized_items_and_records_page_cost(setup_client, monkeypatch, count, record_property):
    from app.routers import items
    seed_rows(setup_client, count)
    materialized = []
    def observed_connect(path):
        connection = connect(path)
        original_factory = connection.row_factory
        def factory(cursor, row):
            if any(column[0] == "aliases_json" for column in cursor.description):
                materialized.append(row)
            return original_factory(cursor, row)
        connection.row_factory = factory
        return connection
    monkeypatch.setattr(items, "connect", observed_connect)
    start = time.perf_counter()
    response = setup_client.get("/api/items", params={"page": 2, "page_size": 40})
    elapsed_ms = (time.perf_counter() - start) * 1000
    assert response.status_code == 200
    assert response.json()["total"] == count and len(response.json()["items"]) == 40
    assert len(materialized) == 40, "unmatched and off-page items must stay in SQLite"
    record_property("dataset_items", count)
    record_property("page_ms", round(elapsed_ms, 3))
    record_property("response_bytes", len(response.content))
    print(f"dataset={count} page_ms={elapsed_ms:.3f} response_bytes={len(response.content)} materialized={len(materialized)}")


def test_page_and_total_share_one_database_snapshot(setup_client, monkeypatch):
    from app.routers import items
    ids = seed_rows(setup_client, 42)
    require_session = items.require_session
    def update_after_auth(connection, request):
        user = require_session(connection, request)
        with db(setup_client) as writer:
            writer.execute("DELETE FROM items WHERE id=?", (ids[0],))
        return user
    monkeypatch.setattr(items, "require_session", update_after_auth)
    response = setup_client.get("/api/items", params={"page": 1})
    assert response.status_code == 200
    body = response.json()
    assert body["total"] == 42 and [row["id"] for row in body["items"]] == ids[:40]
    with db(setup_client) as connection:
        assert connection.execute("SELECT COUNT(*) FROM items").fetchone()[0] == 41


def test_export_rank_matches_unpaged_and_paged_search(setup_client):
    ids = seed_rows(setup_client, 3, names=["备用相机", "相机包", "相机"])
    first = setup_client.get("/api/items", params={"q": "相机", "page": 1, "page_size": 1}).json()
    assert [row["id"] for row in first["items"]] == [ids[2]]
    assert first["total"] == 3
    exported = setup_client.post("/api/inventory/export", json={"format": "json", "scope": "filtered", "q": "相机"}).json()
    assert [row["id"] for row in exported["items"]] == list(reversed(ids))
    assert exported["item_count"] == 3
