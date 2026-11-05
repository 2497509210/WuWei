from __future__ import annotations

from fastapi import APIRouter, Request

from ..db import connect

router = APIRouter(prefix="/api")


@router.get("/health")
def health(request: Request):
    settings = request.app.state.settings
    try:
        connection = connect(request.app.state.db_path)
        try:
            connection.execute("SELECT 1").fetchone()
        finally:
            connection.close()
        db_status = "ok"
    except Exception:
        db_status = "error"
    return {"ok": db_status == "ok", "version": settings.version, "db": db_status}
