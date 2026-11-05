from __future__ import annotations

import hashlib
import json
import logging
import uuid
from pathlib import Path
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, File, Form, Query, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse

from ..db import connect, now_iso
from ..schemas import ItemArchiveIn, ItemBatchIn, ItemName, ItemRestoreIn, ItemUpdate, ItemVersionIn
from ..services.history import (
    can_undo_move, find_compartment as _find_compartment,
    find_item as _find_item, latest_event_id, location_path as _location_path,
    record_change,
)
from ..services.photos import PhotoValidationError, encode_photo
from ..services.item_query import iter_items
from ..session import require_session, require_user

router = APIRouter(prefix="/api")
logger = logging.getLogger(__name__)

def _error(status: int, code: str, message: str, **details):
    return JSONResponse(status_code=status, content={"error": {"code": code, "message": message, **details}})


def _serialize(row, request: Request):
    return {
        "id": row["id"], "name": row["name"], "aliases": json.loads(row["aliases_json"]),
        "notes": row["notes"] or "", "quantity": row["quantity"],
        "compartment_id": row["compartment_id"], "room_id": row["room_id"], "container_id": row["container_id"],
        "photo_url": f"{request.app.state.settings.base_path}/api/items/{row['id']}/photo?v={row['version']}" if row["photo_path"] else None,
        "location_path": _location_path(row), "version": row["version"],
        "location_status": row["location_status"], "last_confirmed_at": row["last_confirmed_at"],
        "updated_at": row["updated_at"],
        "archived_at": row["archived_at"], "archive_reason": row["archive_reason"],
    }


def _check_version(row, expected_version: int, request: Request):
    if row["version"] != expected_version:
        return _error(409, "version_conflict", "物品已被更新，请查看最新位置后再操作", current=_serialize(row, request))
    return None


def _check_active(row):
    if row["archived_at"]:
        return _error(409, "item_archived", "物品已归档，请恢复后再修改")
    return None


@router.get("/items")
def list_items(request: Request, q: str = "", compartment_id: str | None = None,
               status: Literal["active", "archived"] = "active", user: dict = Depends(require_user)):
    connection = connect(request.app.state.db_path)
    try:
        if compartment_id and not _find_compartment(connection, compartment_id, user["household_id"]):
            return _error(404, "compartment_not_found", "隔层不存在")
        rows = iter_items(connection, user["household_id"], status=status, q=q, compartment_id=compartment_id)
        return {"items": [_serialize(row, request) for row in rows]}
    finally:
        connection.close()


@router.post("/items/batch")
def create_batch(payload: ItemBatchIn, request: Request, user: dict = Depends(require_user)):
    connection = connect(request.app.state.db_path)
    try:
        connection.execute("BEGIN IMMEDIATE")
        user = require_session(connection, request)
        if not _find_compartment(connection, payload.compartment_id, user["household_id"]):
            return _error(404, "compartment_not_found", "隔层不存在")
        fingerprint = hashlib.sha256(json.dumps({"compartment_id": payload.compartment_id, "names": payload.names}, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()
        previous = connection.execute("SELECT * FROM item_batch_operations WHERE household_id=? AND operation_id=?", (user["household_id"], payload.operation_id)).fetchone()
        if previous:
            if previous["request_hash"] != fingerprint:
                return _error(409, "operation_conflict", "这次登记的重试内容已改变，请重新登记")
            items = [_serialize(_find_item(connection, item_id, user["household_id"]), request) for item_id in json.loads(previous["item_ids_json"])]
            return {"items": items}
        created, ids = now_iso(), []
        for name in payload.names:
            item_id = str(uuid.uuid4())
            connection.execute(
                """INSERT INTO items (id,household_id,name,quantity,compartment_id,created_by,created_at,updated_at,last_confirmed_at)
                   VALUES (?,?,?,1,?,?,?,?,?)""",
                (item_id, user["household_id"], name, payload.compartment_id, user["id"], created, created, created),
            )
            record_change(connection, None, _find_item(connection, item_id, user["household_id"]), "create", user,
                          {"name": {"before": None, "after": name}, "quantity": {"before": None, "after": 1}})
            ids.append(item_id)
        connection.execute("INSERT INTO item_batch_operations VALUES (?,?,?,?,?)", (user["household_id"], payload.operation_id, fingerprint, json.dumps(ids), created))
        items = [_serialize(_find_item(connection, item_id, user["household_id"]), request) for item_id in ids]
        connection.commit()
        return JSONResponse(status_code=201, content={"items": items})
    finally:
        connection.close()


@router.post("/items/quick")
def create_quick_item(
    request: Request, name: Annotated[ItemName, Form()],
    compartment_id: Annotated[str, Form(min_length=1, max_length=100)],
    operation_id: Annotated[str, Form(min_length=1, max_length=100)],
    image: Annotated[UploadFile | None, File()] = None, user: dict = Depends(require_user),
):
    connection = None
    new_path = None
    committed = False
    try:
        try:
            photo = encode_photo(image.file) if image else None
        except PhotoValidationError as exc:
            return _error(exc.status, exc.code, str(exc))
        fingerprint = hashlib.sha256(json.dumps({
            "name": name, "compartment_id": compartment_id,
            "image_hash": photo.source_hash if photo else None,
        }, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()
        connection = connect(request.app.state.db_path)
        connection.execute("BEGIN IMMEDIATE")
        user = require_session(connection, request)
        previous = connection.execute(
            "SELECT * FROM item_quick_operations WHERE household_id=? AND operation_id=?",
            (user["household_id"], operation_id),
        ).fetchone()
        if previous:
            if previous["request_hash"] != fingerprint:
                return _error(409, "operation_conflict", "这次登记的重试内容已改变，请重新登记")
            item = _find_item(connection, previous["item_id"], user["household_id"])
            return {"item": _serialize(item, request)}
        if not _find_compartment(connection, compartment_id, user["household_id"]):
            return _error(404, "compartment_not_found", "隔层不存在")
        item_id, created = str(uuid.uuid4()), now_iso()
        connection.execute(
            """INSERT INTO items(id,household_id,name,quantity,compartment_id,created_by,created_at,updated_at,last_confirmed_at)
               VALUES (?,?,?,1,?,?,?,?,?)""",
            (item_id, user["household_id"], name, compartment_id, user["id"], created, created, created),
        )
        item = _find_item(connection, item_id, user["household_id"])
        record_change(connection, None, item, "create", user, {
            "name": {"before": None, "after": name}, "quantity": {"before": None, "after": 1},
        })
        if photo:
            filename = f"{uuid.uuid4()}.jpg"
            new_path = _media_path(request, filename)
            new_path.parent.mkdir(parents=True, exist_ok=True)
            new_path.write_bytes(photo.content)
            connection.execute("UPDATE items SET photo_path=?,version=version+1 WHERE id=?", (filename, item_id))
            updated = _find_item(connection, item_id, user["household_id"])
            record_change(connection, item, updated, "photo", user, {"photo": {"before": False, "after": True}})
            item = updated
        connection.execute(
            "INSERT INTO item_quick_operations(household_id,operation_id,request_hash,item_id,created_at) VALUES (?,?,?,?,?)",
            (user["household_id"], operation_id, fingerprint, item_id, created),
        )
        result = _serialize(item, request)
        connection.commit()
        committed = True
        return JSONResponse(status_code=201, content={"item": result})
    finally:
        if connection:
            connection.close()
        if image:
            image.file.close()
        if new_path and not committed:
            new_path.unlink(missing_ok=True)


@router.get("/items/{item_id}")
def get_item(item_id: str, request: Request, user: dict = Depends(require_user)):
    connection = connect(request.app.state.db_path)
    try:
        row = _find_item(connection, item_id, user["household_id"])
        return {"item": _serialize(row, request)} if row else _error(404, "item_not_found", "物品不存在")
    finally:
        connection.close()


@router.patch("/items/{item_id}")
def update_item(item_id: str, payload: ItemUpdate, request: Request, user: dict = Depends(require_user)):
    connection = connect(request.app.state.db_path)
    try:
        connection.execute("BEGIN IMMEDIATE")
        user = require_session(connection, request)
        row = _find_item(connection, item_id, user["household_id"])
        if not row:
            return _error(404, "item_not_found", "物品不存在")
        conflict = _check_version(row, payload.expected_version, request)
        if conflict:
            return conflict
        archived = _check_active(row)
        if archived:
            return archived
        values = payload.model_dump(exclude_unset=True, exclude={"expected_version"})
        if not values:
            return {"item": _serialize(row, request)}
        target = None
        if "compartment_id" in values:
            target = _find_compartment(connection, values["compartment_id"], user["household_id"])
            if not target:
                return _error(404, "compartment_not_found", "隔层不存在")
        if "aliases" in values:
            values["aliases"] = list(dict.fromkeys(values["aliases"]))
        before_values = _serialize(row, request)
        changes = {}
        for key, value in values.items():
            displayed_value = (value or "") if key == "notes" else value
            if before_values[key] != displayed_value:
                changes[key] = {"before": before_values[key], "after": displayed_value}
        if not changes:
            return {"item": before_values}
        if "aliases" in values:
            values["aliases_json"] = json.dumps(values.pop("aliases"), ensure_ascii=False)
        changed_at = now_iso()
        moving = target is not None and values["compartment_id"] != row["compartment_id"]
        if moving:
            values.update(location_status="confirmed", last_confirmed_at=changed_at)
        values.update(version=row["version"] + 1, updated_at=changed_at)
        assignments = ", ".join(f"{key}=?" for key in values)
        connection.execute(f"UPDATE items SET {assignments} WHERE id=?", (*values.values(), item_id))
        updated = _find_item(connection, item_id, user["household_id"])
        record_change(connection, row, updated, "move" if moving else "update", user, changes)
        result = _serialize(updated, request)
        connection.commit()
        return {"item": result}
    finally:
        connection.close()


def _set_location_status(item_id: str, payload: ItemVersionIn, status: str, request: Request, user: dict):
    connection = connect(request.app.state.db_path)
    try:
        connection.execute("BEGIN IMMEDIATE")
        user = require_session(connection, request)
        row = _find_item(connection, item_id, user["household_id"])
        if not row:
            return _error(404, "item_not_found", "物品不存在")
        conflict = _check_version(row, payload.expected_version, request)
        if conflict:
            return conflict
        archived = _check_active(row)
        if archived:
            return archived
        if status == "confirmed" and not row["compartment_id"]:
            return _error(409, "item_has_no_location", "请先为物品选择位置，再确认它在这里")
        changed = now_iso()
        connection.execute(
            "UPDATE items SET location_status=?,last_confirmed_at=?,updated_at=?,version=version+1 WHERE id=?",
            (status, changed if status == "confirmed" else row["last_confirmed_at"], changed, item_id),
        )
        updated = _find_item(connection, item_id, user["household_id"])
        record_change(connection, row, updated, "confirm" if status == "confirmed" else "missing", user,
                      {"location_status": {"before": row["location_status"], "after": status},
                       "last_confirmed_at": {"before": row["last_confirmed_at"], "after": updated["last_confirmed_at"]}})
        result = _serialize(updated, request)
        connection.commit()
        return {"item": result}
    finally:
        connection.close()


@router.post("/items/{item_id}/confirm")
def confirm_item(item_id: str, payload: ItemVersionIn, request: Request, user: dict = Depends(require_user)):
    return _set_location_status(item_id, payload, "confirmed", request, user)


@router.post("/items/{item_id}/missing")
def missing_item(item_id: str, payload: ItemVersionIn, request: Request, user: dict = Depends(require_user)):
    return _set_location_status(item_id, payload, "missing", request, user)


@router.post("/items/{item_id}/archive")
def archive_item(item_id: str, payload: ItemArchiveIn, request: Request, user: dict = Depends(require_user)):
    connection = connect(request.app.state.db_path)
    try:
        connection.execute("BEGIN IMMEDIATE")
        user = require_session(connection, request)
        row = _find_item(connection, item_id, user["household_id"])
        if not row:
            return _error(404, "item_not_found", "物品不存在")
        conflict = _check_version(row, payload.expected_version, request)
        if conflict:
            return conflict
        archived = _check_active(row)
        if archived:
            return archived
        changed = now_iso()
        reason = payload.reason or None
        connection.execute(
            """UPDATE items SET archived_at=?,archive_reason=?,archived_location_json=?,compartment_id=NULL,
               updated_at=?,version=version+1 WHERE id=?""",
            (changed, reason, json.dumps(_location_path(row), ensure_ascii=False), changed, item_id),
        )
        updated = _find_item(connection, item_id, user["household_id"])
        record_change(connection, row, updated, "archive", user, {
            "archived_at": {"before": None, "after": changed},
            "archive_reason": {"before": None, "after": reason},
            "compartment_id": {"before": row["compartment_id"], "after": None},
        })
        result = _serialize(updated, request)
        connection.commit()
        return {"item": result}
    finally:
        connection.close()


@router.post("/items/{item_id}/restore")
def restore_item(item_id: str, payload: ItemRestoreIn, request: Request, user: dict = Depends(require_user)):
    connection = connect(request.app.state.db_path)
    try:
        connection.execute("BEGIN IMMEDIATE")
        user = require_session(connection, request)
        row = _find_item(connection, item_id, user["household_id"])
        if not row:
            return _error(404, "item_not_found", "物品不存在")
        conflict = _check_version(row, payload.expected_version, request)
        if conflict:
            return conflict
        if not row["archived_at"]:
            return _error(409, "item_not_archived", "物品尚未归档")
        if not _find_compartment(connection, payload.compartment_id, user["household_id"]):
            return _error(404, "compartment_not_found", "隔层不存在")
        changed = now_iso()
        connection.execute(
            """UPDATE items SET archived_at=NULL,archive_reason=NULL,archived_location_json=NULL,
               compartment_id=?,location_status='confirmed',last_confirmed_at=?,updated_at=?,version=version+1 WHERE id=?""",
            (payload.compartment_id, changed, changed, item_id),
        )
        updated = _find_item(connection, item_id, user["household_id"])
        record_change(connection, row, updated, "restore", user, {
            "archived_at": {"before": row["archived_at"], "after": None},
            "archive_reason": {"before": row["archive_reason"], "after": None},
            "compartment_id": {"before": None, "after": payload.compartment_id},
        })
        result = _serialize(updated, request)
        connection.commit()
        return {"item": result}
    finally:
        connection.close()


@router.get("/items/{item_id}/events")
def list_events(item_id: str, request: Request, limit: Annotated[int, Query(ge=1, le=100)] = 50,
                offset: Annotated[int, Query(ge=0)] = 0, user: dict = Depends(require_user)):
    connection = connect(request.app.state.db_path)
    try:
        connection.execute("BEGIN")
        item = _find_item(connection, item_id, user["household_id"])
        if not item:
            return _error(404, "item_not_found", "物品不存在")
        rows = connection.execute(
            "SELECT * FROM item_events WHERE item_id=? ORDER BY item_version DESC,created_at DESC,rowid DESC LIMIT ? OFFSET ?",
            (item_id, limit + 1, offset),
        ).fetchall()
        latest_id = latest_event_id(connection, item_id)
        result = []
        for row in rows[:limit]:
            legacy = bool(row["legacy"])
            result.append({
                "id": row["id"], "type": row["event_type"], "created_at": row["created_at"],
                "actor_name": row["actor_name"],
                "from_path": json.loads(row["from_path_json"]) if row["from_path_json"] else None,
                "to_path": json.loads(row["to_path_json"]) if row["to_path_json"] else None,
                "changes": json.loads(row["changes_json"]), "item_version": row["item_version"],
                "can_undo": can_undo_move(connection, item, row, user["household_id"], latest_id),
                "legacy": legacy,
            })
        return {"events": result, "has_more": len(rows) > limit}
    finally:
        connection.close()


@router.post("/items/{item_id}/events/{event_id}/undo")
def undo_move(item_id: str, event_id: str, payload: ItemVersionIn, request: Request, user: dict = Depends(require_user)):
    connection = connect(request.app.state.db_path)
    try:
        connection.execute("BEGIN IMMEDIATE")
        user = require_session(connection, request)
        row = _find_item(connection, item_id, user["household_id"])
        if not row:
            return _error(404, "item_not_found", "物品不存在")
        conflict = _check_version(row, payload.expected_version, request)
        if conflict:
            return conflict
        event = connection.execute("SELECT * FROM item_events WHERE id=? AND item_id=?", (event_id, item_id)).fetchone()
        if not event:
            return _error(404, "event_not_found", "操作记录不存在")
        if not can_undo_move(connection, row, event, user["household_id"], latest_event_id(connection, item_id)):
            return _error(409, "undo_not_available", "这次移动已不能撤销，请选择物品现在的位置")
        changed = now_iso()
        connection.execute(
            "UPDATE items SET compartment_id=?,location_status='confirmed',last_confirmed_at=?,updated_at=?,version=version+1 WHERE id=?",
            (event["from_compartment_id"], changed, changed, item_id),
        )
        updated = _find_item(connection, item_id, user["household_id"])
        record_change(connection, row, updated, "undo", user, {
            "compartment_id": {"before": row["compartment_id"], "after": updated["compartment_id"]},
        })
        result = _serialize(updated, request)
        connection.commit()
        return {"item": result}
    finally:
        connection.close()


def _media_path(request: Request, relative_path: str | None) -> Path | None:
    if not relative_path:
        return None
    root = (request.app.state.settings.data_dir / "media").resolve()
    path = (root / relative_path).resolve()
    return path if path.is_relative_to(root) and path != root else None


@router.get("/items/{item_id}/photo")
def get_photo(item_id: str, request: Request, user: dict = Depends(require_user)):
    connection = connect(request.app.state.db_path)
    try:
        row = _find_item(connection, item_id, user["household_id"])
        path = _media_path(request, row["photo_path"]) if row else None
        if not path or not path.is_file():
            return _error(404, "photo_not_found", "照片不存在")
        return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "private, no-store"})
    finally:
        connection.close()


@router.post("/items/{item_id}/photo")
def upload_photo(
    item_id: str, request: Request, expected_version: Annotated[int, Form(ge=1)],
    image: Annotated[UploadFile, File()], user: dict = Depends(require_user),
):
    connection = connect(request.app.state.db_path)
    new_path = None
    committed = False
    try:
        # Check authorization/version before spending work decoding untrusted uploads.
        row = _find_item(connection, item_id, user["household_id"])
        if not row:
            return _error(404, "item_not_found", "物品不存在")
        conflict = _check_version(row, expected_version, request)
        if conflict:
            return conflict
        archived = _check_active(row)
        if archived:
            return archived
        try:
            photo = encode_photo(image.file)
        except PhotoValidationError as exc:
            return _error(exc.status, exc.code, str(exc))
        connection.execute("BEGIN IMMEDIATE")
        user = require_session(connection, request)
        row = _find_item(connection, item_id, user["household_id"])
        if not row:
            return _error(404, "item_not_found", "物品不存在")
        conflict = _check_version(row, expected_version, request)
        if conflict:
            return conflict
        archived = _check_active(row)
        if archived:
            return archived
        filename = f"{uuid.uuid4()}.jpg"
        new_path = _media_path(request, filename)
        new_path.parent.mkdir(parents=True, exist_ok=True)
        new_path.write_bytes(photo.content)
        old_path = _media_path(request, row["photo_path"])
        connection.execute("UPDATE items SET photo_path=?,updated_at=?,version=version+1 WHERE id=?", (filename, now_iso(), item_id))
        updated = _find_item(connection, item_id, user["household_id"])
        record_change(connection, row, updated, "photo", user, {
            "photo": {"before": bool(row["photo_path"]), "after": True},
        })
        result = _serialize(updated, request)
        connection.commit()
        committed = True
        if old_path and old_path != new_path:
            try:
                old_path.unlink(missing_ok=True)
            except OSError:
                logger.warning("Old photo cleanup failed after replacement: %s", old_path, exc_info=True)
        return {"item": result}
    finally:
        connection.close()
        image.file.close()
        if new_path and not committed:
            new_path.unlink(missing_ok=True)
