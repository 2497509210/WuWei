from __future__ import annotations

from datetime import datetime, timezone

from fastapi import HTTPException, Request

from .db import connect, now_iso
from .security import token_hash

SESSION_COOKIE = "wuwei_session"
DEVICE_COOKIE = "wuwei_device"


def load_session(connection, token: str):
    return connection.execute(
        """
        SELECT s.id AS session_id, s.kind, s.expires_at, s.group_id,
               u.id, u.username, u.display_name, u.role, u.household_id,
               h.name AS household_name
        FROM sessions s
        JOIN users u ON u.id = s.user_id
        JOIN session_groups g ON g.id = s.group_id AND g.user_id = s.user_id
        JOIN households h ON h.id = u.household_id
        WHERE s.token_hash = ? AND s.revoked_at IS NULL AND g.revoked_at IS NULL AND u.disabled_at IS NULL
        """,
        (token_hash(token),),
    ).fetchone()


def session_valid(row) -> bool:
    if not row:
        return False
    return datetime.fromisoformat(row["expires_at"]) > datetime.now(timezone.utc)


def session_from_connection(connection, request: Request):
    for cookie_name in (SESSION_COOKIE, DEVICE_COOKIE):
        token = request.cookies.get(cookie_name)
        if not token:
            continue
        row = load_session(connection, token)
        if session_valid(row):
            return row, cookie_name, token
    return None, None, None


def current_session(request: Request):
    connection = connect(request.app.state.db_path)
    row, cookie_name, token = session_from_connection(connection, request)
    if row:
        return connection, row, cookie_name, token
    connection.close()
    return None, None, None, None


def require_session(connection, request: Request, *, owner: bool = False):
    """Use the caller's transaction so concurrent revocation cannot race a write."""
    row, _, _ = session_from_connection(connection, request)
    if not row:
        raise HTTPException(status_code=401, detail={"code": "not_authenticated", "message": "请先登录"})
    if owner and row["role"] != "owner":
        raise HTTPException(status_code=403, detail={"code": "owner_required", "message": "只有家庭管理员可以操作"})
    return row


def revoke_group(connection, group_id: str) -> None:
    changed = now_iso()
    connection.execute("UPDATE session_groups SET revoked_at=? WHERE id=? AND revoked_at IS NULL", (changed, group_id))
    connection.execute("UPDATE sessions SET revoked_at=? WHERE group_id=? AND revoked_at IS NULL", (changed, group_id))


def revoke_all_sessions(connection, user_id: str) -> None:
    changed = now_iso()
    connection.execute("UPDATE session_groups SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL", (changed, user_id))
    connection.execute("UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL", (changed, user_id))


def require_user(request: Request) -> dict:
    connection, row, _, _ = current_session(request)
    if not row:
        raise HTTPException(status_code=401, detail={"code": "not_authenticated", "message": "请先登录"})
    connection.close()
    return {
        "id": row["id"],
        "username": row["username"],
        "display_name": row["display_name"],
        "role": row["role"],
        "household_id": row["household_id"],
    }


def require_owner(request: Request) -> dict:
    user = require_user(request)
    if user["role"] != "owner":
        raise HTTPException(status_code=403, detail={"code": "owner_required", "message": "只有家庭管理员可以操作"})
    return user
