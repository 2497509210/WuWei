from __future__ import annotations

import hashlib
import json

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ..bulk_schemas import BulkItemAction
from ..db import connect, now_iso
from ..services.history import find_compartment, find_item, location_path, record_change
from ..session import require_session
from .items import _serialize

router = APIRouter(prefix="/api")


def _error(status: int, code: str, message: str):
    return JSONResponse(status_code=status, content={"error": {"code": code, "message": message}})


def _load_all(connection, ids: list[str], household_id: str):
    rows = [find_item(connection, item_id, household_id) for item_id in ids]
    return None if any(row is None for row in rows) else rows


@router.post("/items/actions/bulk")
def bulk_item_action(payload: BulkItemAction, request: Request):
    selected = sorted(payload.items, key=lambda item: item.id)
    reason = payload.reason or None
    normalized = {
        "action": payload.action,
        "items": [{"id": item.id, "expected_version": item.expected_version} for item in selected],
        "compartment_id": payload.compartment_id,
        "reason": reason,
    }
    fingerprint = hashlib.sha256(json.dumps(normalized, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()
    connection = connect(request.app.state.db_path)
    try:
        connection.execute("BEGIN IMMEDIATE")
        user = require_session(connection, request)
        previous = connection.execute(
            "SELECT * FROM item_bulk_operations WHERE household_id=? AND operation_id=?",
            (user["household_id"], payload.operation_id),
        ).fetchone()
        if previous:
            if previous["request_hash"] != fingerprint:
                return _error(409, "operation_conflict", "这次操作的重试内容已改变，请重新选择后提交")
            current = _load_all(connection, json.loads(previous["item_ids_json"]), user["household_id"])
            if current is None:
                return _error(404, "item_not_found", "所选物品不存在")
            return {"items": [_serialize(row, request) for row in current],
                    "processed": previous["processed"], "changed": previous["changed"], "replayed": True}

        ids = [item.id for item in selected]
        rows = _load_all(connection, ids, user["household_id"])
        if rows is None:
            return _error(404, "item_not_found", "所选物品不存在")
        # Validate the whole set before changing even the first record.
        for expected, row in zip(selected, rows):
            wrong_state = bool(row["archived_at"]) != (payload.action == "restore")
            if row["version"] != expected.expected_version or wrong_state:
                return _error(409, "bulk_conflict", "所选物品的版本或状态已变化，请刷新并重新选择")
        if payload.action != "archive" and not find_compartment(connection, payload.compartment_id, user["household_id"]):
            return _error(404, "compartment_not_found", "目标隔层不存在")

        changed = 0
        timestamp = now_iso()
        for row in rows:
            if payload.action == "move" and row["compartment_id"] == payload.compartment_id:
                continue
            if payload.action == "archive":
                connection.execute(
                    """UPDATE items SET archived_at=?,archive_reason=?,archived_location_json=?,
                       compartment_id=NULL,updated_at=?,version=version+1 WHERE id=?""",
                    (timestamp, reason, json.dumps(location_path(row), ensure_ascii=False), timestamp, row["id"]),
                )
                changes = {
                    "archived_at": {"before": None, "after": timestamp},
                    "archive_reason": {"before": None, "after": reason},
                    "compartment_id": {"before": row["compartment_id"], "after": None},
                }
            else:
                connection.execute(
                    """UPDATE items SET compartment_id=?,location_status='confirmed',last_confirmed_at=?,
                       archived_at=NULL,archive_reason=NULL,archived_location_json=NULL,updated_at=?,version=version+1 WHERE id=?""",
                    (payload.compartment_id, timestamp, timestamp, row["id"]),
                )
                changes = {"compartment_id": {"before": row["compartment_id"], "after": payload.compartment_id}}
                if payload.action == "restore":
                    changes.update({
                        "archived_at": {"before": row["archived_at"], "after": None},
                        "archive_reason": {"before": row["archive_reason"], "after": None},
                    })
            updated = find_item(connection, row["id"], user["household_id"])
            record_change(connection, row, updated, payload.action, user, changes)
            changed += 1

        connection.execute(
            """INSERT INTO item_bulk_operations
               (household_id,operation_id,request_hash,item_ids_json,processed,changed,created_at) VALUES (?,?,?,?,?,?,?)""",
            (user["household_id"], payload.operation_id, fingerprint, json.dumps(ids), len(ids), changed, timestamp),
        )
        result = [_serialize(find_item(connection, item_id, user["household_id"]), request) for item_id in ids]
        connection.commit()
        return {"items": result, "processed": len(ids), "changed": changed, "replayed": False}
    finally:
        connection.close()
