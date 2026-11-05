from __future__ import annotations

import json
import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse

from ..db import connect, now_iso
from ..schemas import PRESETS, ContainerCreate, ContainerUpdate
from ..services.layout import (
    CompartmentNotEmpty,
    normalize_config,
    parse_config,
    serialize_container,
    serialize_room,
    sync_compartments,
)
from ..session import require_session, require_user
from ..services.history import ITEM_QUERY, find_compartment, find_item, location_path, record_change

router = APIRouter(prefix="/api")


def _error(status_code: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(status_code=status_code, content={"error": {"code": code, "message": message}})


def _container_or_404(connection, container_id: str, household_id: str):
    return connection.execute(
        """
        SELECT c.*, (SELECT COUNT(*) FROM items i JOIN compartments cp ON cp.id = i.compartment_id WHERE cp.container_id = c.id) AS item_count
        FROM containers c
        JOIN rooms r ON r.id = c.room_id
        JOIN floors f ON f.id = r.floor_id
        WHERE c.id = ? AND f.household_id = ?
        """,
        (container_id, household_id),
    ).fetchone()


def _room_of_container(connection, container_id: str):
    return connection.execute(
        "SELECT r.* FROM rooms r JOIN containers c ON c.room_id = r.id WHERE c.id = ?",
        (container_id,),
    ).fetchone()


def _inside_room(room, x: int, z: int, width: int, depth: int, rot_deg: int) -> bool:
    footprint_w, footprint_d = (depth, width) if rot_deg % 180 == 90 else (width, depth)
    return (
        x - footprint_w / 2 >= 0
        and z - footprint_d / 2 >= 0
        and x + footprint_w / 2 <= room["width_cm"]
        and z + footprint_d / 2 <= room["depth_cm"]
    )


def _compartments(connection, container_id: str):
    return connection.execute(
        "SELECT * FROM compartments WHERE container_id = ? ORDER BY level_index, col, sort",
        (container_id,),
    ).fetchall()


def _room_snapshots(connection, room_ids):
    snapshots = []
    for room_id in dict.fromkeys(room_ids):
        row = connection.execute(
            "SELECT r.*, (SELECT COUNT(*) FROM containers c WHERE c.room_id=r.id) AS container_count FROM rooms r WHERE r.id=?",
            (room_id,),
        ).fetchone()
        snapshots.append(serialize_room(row))
    return snapshots


def _advance_rooms(connection, room_ids):
    for room_id in dict.fromkeys(room_ids):
        connection.execute("UPDATE rooms SET version=version+1 WHERE id=?", (room_id,))


@router.get("/containers/{container_id}")
def get_container(container_id: str, request: Request):
    connection = connect(request.app.state.db_path)
    try:
        connection.execute("BEGIN")
        user = require_session(connection, request)
        container = _container_or_404(connection, container_id, user["household_id"])
        if not container:
            return _error(404, "container_not_found", "容器不存在")
        room = connection.execute(
            "SELECT r.*, (SELECT COUNT(*) FROM containers c WHERE c.room_id=r.id) AS container_count FROM rooms r WHERE r.id=?",
            (container["room_id"],),
        ).fetchone()
        return {"room": serialize_room(room), "container": serialize_container(container, _compartments(connection, container_id))}
    finally:
        connection.close()


@router.get("/locations/compartments/{compartment_id}")
def get_compartment_location(compartment_id: str, request: Request):
    connection = connect(request.app.state.db_path)
    try:
        connection.execute("BEGIN")
        user = require_session(connection, request)
        compartment = find_compartment(connection, compartment_id, user["household_id"])
        if not compartment:
            return _error(404, "compartment_not_found", "隔层不存在")
        container = _container_or_404(connection, compartment["container_id"], user["household_id"])
        return {"location": {"room_id": container["room_id"], "container_id": container["id"],
                             "compartment_id": compartment["id"], "path": location_path(compartment)}}
    finally:
        connection.close()


@router.post("/containers")
def create_container(payload: ContainerCreate, request: Request, user: dict = Depends(require_user)):
    if payload.preset not in PRESETS:
        return _error(400, "invalid_preset", "不支持的容器类型")
    connection = connect(request.app.state.db_path)
    try:
        connection.execute("BEGIN IMMEDIATE")
        user = require_session(connection, request)
        room = connection.execute(
            "SELECT r.* FROM rooms r JOIN floors f ON f.id = r.floor_id WHERE r.id = ? AND f.household_id = ?",
            (payload.room_id, user["household_id"]),
        ).fetchone()
        if not room:
            return _error(404, "room_not_found", "房间不存在")
        if not _inside_room(room, payload.x_cm, payload.z_cm, payload.width_cm, payload.depth_cm, payload.rot_deg) or payload.y_cm + payload.height_cm > room["height_cm"]:
            return _error(400, "container_out_of_room", "容器超出房间范围")

        config = normalize_config(payload.preset, payload.config)
        container_id = str(uuid.uuid4())
        sort = connection.execute(
            "SELECT COALESCE(MAX(sort), -1) + 1 AS next FROM containers WHERE room_id = ?", (payload.room_id,)
        ).fetchone()["next"]
        connection.execute(
            """
            INSERT INTO containers
                (id, room_id, preset, name, x_cm, z_cm, y_cm, rot_deg, width_cm, depth_cm, height_cm, color, config_json, sort)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                container_id,
                payload.room_id,
                payload.preset,
                payload.name.strip(),
                payload.x_cm,
                payload.z_cm,
                payload.y_cm,
                payload.rot_deg,
                payload.width_cm,
                payload.depth_cm,
                payload.height_cm,
                payload.color,
                json.dumps(config, ensure_ascii=False),
                sort,
            ),
        )
        sync_compartments(connection, container_id, payload.preset, config)
        _advance_rooms(connection, [payload.room_id])
        row = _container_or_404(connection, container_id, user["household_id"])
        result = {"container": serialize_container(row, _compartments(connection, container_id)),
                  "rooms": _room_snapshots(connection, [payload.room_id])}
        connection.commit()
        return JSONResponse(
            status_code=201,
            content=result,
        )
    finally:
        connection.close()


@router.patch("/containers/{container_id}")
def update_container(
    container_id: str, payload: ContainerUpdate, request: Request, user: dict = Depends(require_user)
):
    connection = connect(request.app.state.db_path)
    try:
        connection.execute("BEGIN IMMEDIATE")
        user = require_session(connection, request)
        row = _container_or_404(connection, container_id, user["household_id"])
        if not row:
            return _error(404, "container_not_found", "容器不存在")
        if payload.expected_version is not None and payload.expected_version != row["version"]:
            return JSONResponse(status_code=409, content={"error": {
                "code": "version_conflict", "message": "容器已被更新，请查看最新布局后再操作",
                "current": serialize_container(row, _compartments(connection, container_id)),
            }})
        values = payload.model_dump(exclude_unset=True, exclude={"expected_version"})
        if any(value is None for key, value in values.items() if key not in {"color", "config"}):
            return _error(422, "invalid_value", "名称、位置和尺寸不能为 null")
        room_id = values.get("room_id", row["room_id"])
        room = connection.execute(
            "SELECT r.* FROM rooms r JOIN floors f ON f.id=r.floor_id WHERE r.id=? AND f.household_id=?",
            (room_id, user["household_id"]),
        ).fetchone()
        if not room:
            return _error(404, "room_not_found", "房间不存在")

        moved_items = connection.execute(
            ITEM_QUERY + " WHERE c.id=? AND i.household_id=? AND i.archived_at IS NULL",
            (container_id, user["household_id"]),
        ).fetchall() if room_id != row["room_id"] else []

        next_config = normalize_config(row["preset"], payload.config) if "config" in values else parse_config(row["config_json"])
        x = values.get("x_cm", row["x_cm"])
        z = values.get("z_cm", row["z_cm"])
        width = values.get("width_cm", row["width_cm"])
        depth = values.get("depth_cm", row["depth_cm"])
        rot = values.get("rot_deg", row["rot_deg"])
        y = values.get("y_cm", row["y_cm"])
        height = values.get("height_cm", row["height_cm"])
        if not _inside_room(room, x, z, width, depth, rot) or y + height > room["height_cm"]:
            return _error(400, "container_out_of_room", "容器超出房间范围")

        if "config" in values:
            if next_config != parse_config(row["config_json"]):
                values["config_json"] = json.dumps(next_config, ensure_ascii=False)
            values.pop("config")
        values = {key: value for key, value in values.items() if value != row[key]}
        if not values:
            return {"container": serialize_container(row, _compartments(connection, container_id)),
                    "rooms": _room_snapshots(connection, [row["room_id"]])}
        values["version"] = row["version"] + 1
        assignments = ", ".join(f"{key} = ?" for key in values)
        if assignments:
            connection.execute(
                f"UPDATE containers SET {assignments} WHERE id = ?",
                (*values.values(), container_id),
            )
        try:
            sync_compartments(connection, container_id, row["preset"], next_config)
        except CompartmentNotEmpty as exc:
            connection.rollback()
            return _error(
                409,
                "compartment_not_empty",
                f"这些隔层还有物品，先移走再改：{'、'.join(exc.names)}",
            )
        if room_id != row["room_id"]:
            connection.execute(
                """UPDATE items SET version=version+1, updated_at=?
                   WHERE compartment_id IN (SELECT id FROM compartments WHERE container_id=?)""",
                (now_iso(), container_id),
            )
            for before in moved_items:
                after = find_item(connection, before["id"], user["household_id"])
                record_change(connection, before, after, "container_move", user, {
                    "room_id": {"before": before["room_id"], "after": after["room_id"]},
                })
        affected_rooms = [row["room_id"], room_id]
        _advance_rooms(connection, affected_rooms)
        updated = _container_or_404(connection, container_id, user["household_id"])
        result = {"container": serialize_container(updated, _compartments(connection, container_id)),
                  "rooms": _room_snapshots(connection, affected_rooms)}
        connection.commit()
        return result
    finally:
        connection.close()


@router.delete("/containers/{container_id}")
def delete_container(container_id: str, request: Request, expected_version: Annotated[int, Query(ge=1)],
                     user: dict = Depends(require_user)):
    connection = connect(request.app.state.db_path)
    try:
        connection.execute("BEGIN IMMEDIATE")
        user = require_session(connection, request)
        row = _container_or_404(connection, container_id, user["household_id"])
        if not row:
            return _error(404, "container_not_found", "容器不存在")
        if expected_version != row["version"]:
            return JSONResponse(status_code=409, content={"error": {
                "code": "version_conflict", "message": "容器已被更新，请加载最新布局后重新确认删除",
                "current": serialize_container(row, _compartments(connection, container_id)),
            }})
        if row["item_count"]:
            return _error(409, "container_not_empty", "这个容器还有物品，先移走再删除")
        connection.execute("DELETE FROM containers WHERE id = ?", (container_id,))
        _advance_rooms(connection, [row["room_id"]])
        connection.commit()
        return JSONResponse(status_code=204, content=None)
    finally:
        connection.close()
