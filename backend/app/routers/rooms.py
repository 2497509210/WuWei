from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse

from ..db import connect
from ..schemas import FloorCreate, RoomCreate, RoomUpdate
from ..services.layout import ensure_default_floor, serialize_container, serialize_room
from ..session import require_owner, require_session, require_user
from .containers import _inside_room

router = APIRouter(prefix="/api")


def _error(status_code: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(status_code=status_code, content={"error": {"code": code, "message": message}})


def _household(connection, household_id: str):
    return connection.execute("SELECT * FROM households WHERE id = ?", (household_id,)).fetchone()


def _room_or_404(connection, room_id: str, household_id: str):
    return connection.execute(
        """
        SELECT r.*, (SELECT COUNT(*) FROM containers c WHERE c.room_id = r.id) AS container_count
        FROM rooms r
        JOIN floors f ON f.id = r.floor_id
        WHERE r.id = ? AND f.household_id = ?
        """,
        (room_id, household_id),
    ).fetchone()


@router.get("/bootstrap")
def bootstrap(request: Request, user: dict = Depends(require_user)):
    connection = connect(request.app.state.db_path)
    try:
        connection.execute("BEGIN IMMEDIATE")
        user = require_session(connection, request)
        ensure_default_floor(connection, user["household_id"])
        connection.commit()
        household = _household(connection, user["household_id"])
        floor_rows = connection.execute(
            "SELECT * FROM floors WHERE household_id = ? ORDER BY level, sort, name",
            (user["household_id"],),
        ).fetchall()
        floors = []
        for floor in floor_rows:
            room_rows = connection.execute(
                """
                SELECT r.*, (SELECT COUNT(*) FROM containers c WHERE c.room_id = r.id) AS container_count
                FROM rooms r WHERE r.floor_id = ? ORDER BY r.sort, r.name
                """,
                (floor["id"],),
            ).fetchall()
            floors.append(
                {
                    "id": floor["id"],
                    "name": floor["name"],
                    "level": floor["level"],
                    "rooms": [serialize_room(room) for room in room_rows],
                }
            )
        return {
            "user": {"id": user["id"], "username": user["username"], "display_name": user["display_name"], "role": user["role"]},
            "household": {"id": household["id"], "name": household["name"]},
            "floors": floors,
        }
    finally:
        connection.close()


@router.post("/floors")
def create_floor(payload: FloorCreate, request: Request, user: dict = Depends(require_owner)):
    connection = connect(request.app.state.db_path)
    try:
        connection.execute("BEGIN IMMEDIATE")
        user = require_session(connection, request, owner=True)
        floor_id = str(uuid.uuid4())
        connection.execute(
            "INSERT INTO floors (id, household_id, name, level, sort) VALUES (?, ?, ?, ?, ?)",
            (floor_id, user["household_id"], payload.name.strip(), payload.level, 0),
        )
        connection.commit()
        row = connection.execute("SELECT * FROM floors WHERE id = ?", (floor_id,)).fetchone()
        return {"floor": {"id": row["id"], "name": row["name"], "level": row["level"], "rooms": []}}
    finally:
        connection.close()


@router.post("/rooms")
def create_room(payload: RoomCreate, request: Request, user: dict = Depends(require_owner)):
    connection = connect(request.app.state.db_path)
    try:
        connection.execute("BEGIN IMMEDIATE")
        user = require_session(connection, request, owner=True)
        if payload.floor_id:
            floor = connection.execute(
                "SELECT * FROM floors WHERE id = ? AND household_id = ?",
                (payload.floor_id, user["household_id"]),
            ).fetchone()
            if not floor:
                return _error(404, "floor_not_found", "楼层不存在")
        else:
            floor = ensure_default_floor(connection, user["household_id"])

        room_id = str(uuid.uuid4())
        sort = connection.execute(
            "SELECT COALESCE(MAX(sort), -1) + 1 AS next FROM rooms WHERE floor_id = ?", (floor["id"],)
        ).fetchone()["next"]
        connection.execute(
            """
            INSERT INTO rooms (id, floor_id, name, width_cm, depth_cm, height_cm, wall_color, sort)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                room_id,
                floor["id"],
                payload.name.strip(),
                payload.width_cm,
                payload.depth_cm,
                payload.height_cm,
                payload.wall_color,
                sort,
            ),
        )
        connection.commit()
        room = _room_or_404(connection, room_id, user["household_id"])
        return JSONResponse(status_code=201, content={"room": serialize_room(room)})
    finally:
        connection.close()


@router.get("/rooms/{room_id}")
def get_room(room_id: str, request: Request, user: dict = Depends(require_user)):
    connection = connect(request.app.state.db_path)
    try:
        room = _room_or_404(connection, room_id, user["household_id"])
        if not room:
            return _error(404, "room_not_found", "房间不存在")
        container_rows = connection.execute(
            """
            SELECT c.*, (SELECT COUNT(*) FROM items i JOIN compartments cp ON cp.id = i.compartment_id WHERE cp.container_id = c.id) AS item_count
            FROM containers c WHERE c.room_id = ? ORDER BY c.sort, c.name
            """,
            (room_id,),
        ).fetchall()
        containers = []
        for container in container_rows:
            compartments = connection.execute(
                "SELECT * FROM compartments WHERE container_id = ? ORDER BY level_index, col, sort",
                (container["id"],),
            ).fetchall()
            containers.append(serialize_container(container, compartments))
        return {"room": serialize_room(room), "containers": containers}
    finally:
        connection.close()


@router.patch("/rooms/{room_id}")
def update_room(room_id: str, payload: RoomUpdate, request: Request, user: dict = Depends(require_owner)):
    connection = connect(request.app.state.db_path)
    try:
        connection.execute("BEGIN IMMEDIATE")
        user = require_session(connection, request, owner=True)
        room = _room_or_404(connection, room_id, user["household_id"])
        if not room:
            return _error(404, "room_not_found", "房间不存在")
        if payload.expected_version is not None and payload.expected_version != room["version"]:
            return JSONResponse(status_code=409, content={"error": {
                "code": "room_version_conflict", "message": "房间已被更新，请加载最新房间后重新编辑",
                "current_room": serialize_room(room),
            }})
        values = payload.model_dump(exclude_unset=True, exclude={"expected_version"})
        if not values:
            return {"room": serialize_room(room)}
        if any(value is None for key, value in values.items() if key != "wall_color"):
            return _error(422, "invalid_value", "名称和尺寸不能为 null")
        values = {key: value for key, value in values.items() if value != room[key]}
        if not values:
            return {"room": serialize_room(room)}
        proposed_room = {**dict(room), **values}
        containers = connection.execute("SELECT * FROM containers WHERE room_id=?", (room_id,)).fetchall()
        for container in containers:
            if not _inside_room(proposed_room, container["x_cm"], container["z_cm"], container["width_cm"], container["depth_cm"], container["rot_deg"]) or container["y_cm"] + container["height_cm"] > proposed_room["height_cm"]:
                return _error(409, "room_contains_outside_container", "修改后有容器超出房间，请先移动或调整容器")
        values["version"] = room["version"] + 1
        assignments = ", ".join(f"{key} = ?" for key in values)
        connection.execute(
            f"UPDATE rooms SET {assignments} WHERE id = ?",
            (*values.values(), room_id),
        )
        connection.commit()
        return {"room": serialize_room(_room_or_404(connection, room_id, user["household_id"]))}
    finally:
        connection.close()


@router.delete("/rooms/{room_id}")
def delete_room(room_id: str, request: Request, expected_version: Annotated[int, Query(ge=1)],
                user: dict = Depends(require_owner)):
    connection = connect(request.app.state.db_path)
    try:
        connection.execute("BEGIN IMMEDIATE")
        user = require_session(connection, request, owner=True)
        room = _room_or_404(connection, room_id, user["household_id"])
        if not room:
            return _error(404, "room_not_found", "房间不存在")
        if expected_version != room["version"]:
            return JSONResponse(status_code=409, content={"error": {
                "code": "room_version_conflict", "message": "房间已被更新，请加载最新房间后重新确认删除",
                "current_room": serialize_room(room),
            }})
        item_count = connection.execute(
            "SELECT COUNT(*) FROM items i JOIN compartments cp ON cp.id=i.compartment_id JOIN containers c ON c.id=cp.container_id WHERE c.room_id=?",
            (room_id,),
        ).fetchone()[0]
        if item_count:
            return _error(409, "room_not_empty", "房间里还有物品，请先移走再删除")
        connection.execute("DELETE FROM rooms WHERE id = ?", (room_id,))
        connection.commit()
        return JSONResponse(status_code=204, content=None)
    finally:
        connection.close()
