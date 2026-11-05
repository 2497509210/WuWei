from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse

from ..db import connect
from ..schemas import CompartmentUpdate
from ..services.history import find_compartment
from ..services.layout import serialize_container
from ..session import require_session, require_user
from .containers import _advance_rooms, _compartments, _container_or_404, _room_snapshots

router = APIRouter(prefix="/api")


@router.patch("/compartments/{compartment_id}")
def rename_compartment(compartment_id: str, payload: CompartmentUpdate, request: Request,
                       user: dict = Depends(require_user)):
    connection = connect(request.app.state.db_path)
    try:
        connection.execute("BEGIN IMMEDIATE")
        user = require_session(connection, request)
        compartment = find_compartment(connection, compartment_id, user["household_id"])
        if not compartment:
            return JSONResponse(status_code=404, content={"error": {"code": "compartment_not_found", "message": "隔层不存在"}})
        container_id = compartment["container_id"]
        container = _container_or_404(connection, container_id, user["household_id"])
        if container["version"] != payload.expected_container_version:
            return JSONResponse(status_code=409, content={"error": {
                "code": "version_conflict", "message": "容器已被更新，请查看最新隔层后再操作",
                "current": serialize_container(container, _compartments(connection, container_id)),
            }})
        if compartment["custom_name"] != payload.custom_name:
            connection.execute(
                "UPDATE compartments SET custom_name=?, name=COALESCE(?,default_name) WHERE id=?",
                (payload.custom_name, payload.custom_name, compartment_id),
            )
            connection.execute("UPDATE containers SET version=version+1 WHERE id=?", (container_id,))
            _advance_rooms(connection, [container["room_id"]])
        result = serialize_container(_container_or_404(connection, container_id, user["household_id"]),
                                     _compartments(connection, container_id))
        response = {"container": result, "rooms": _room_snapshots(connection, [container["room_id"]])}
        connection.commit()
        return response
    finally:
        connection.close()
