from __future__ import annotations

from datetime import datetime, timedelta, timezone
import uuid

from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse

from ..account_schemas import JoinHousehold, PasswordChange, ProfileUpdate
from ..db import connect, now_iso
from ..security import clear_auth_cookie, hash_password, new_token, token_hash, verify_password
from ..session import (
    DEVICE_COOKIE, SESSION_COOKIE, require_session, revoke_all_sessions, revoke_group,
    session_from_connection,
)
from .auth import apply_login_cookies, create_login_tokens, error, _user_payload

router = APIRouter(prefix="/api")


def _clear_cookies(response: Response, request: Request):
    settings = request.app.state.settings
    for name in (SESSION_COOKIE, DEVICE_COOKIE):
        clear_auth_cookie(response, name, settings)
    return response


def _rate_limit(request: Request, key: str):
    retry = request.app.state.limiter.retry_after(key)
    if retry is not None:
        return error(429, "too_many_attempts", "尝试过多，请稍后再试", headers={"Retry-After": str(retry)})
    return None


def _invite_payload(row):
    return {key: row[key] for key in ("id", "created_at", "expires_at", "used_at", "revoked_at")}


@router.patch("/account/profile")
def update_profile(payload: ProfileUpdate, request: Request):
    connection = connect(request.app.state.db_path)
    try:
        connection.execute("BEGIN IMMEDIATE")
        user = require_session(connection, request)
        connection.execute("UPDATE users SET display_name=? WHERE id=?", (payload.display_name, user["id"]))
        current = connection.execute("SELECT * FROM users WHERE id=?", (user["id"],)).fetchone()
        connection.commit()
        return {"user": _user_payload(current)}
    finally:
        connection.close()


@router.post("/account/password")
def change_password(payload: PasswordChange, request: Request):
    connection = connect(request.app.state.db_path)
    try:
        connection.execute("BEGIN IMMEDIATE")
        user = require_session(connection, request)
        key = "password:" + user["id"]
        blocked = _rate_limit(request, key)
        if blocked:
            return blocked
        row = connection.execute("SELECT password_hash FROM users WHERE id=?", (user["id"],)).fetchone()
        if not verify_password(row["password_hash"], payload.current_password):
            request.app.state.limiter.record_failure(key)
            return error(400, "current_password_invalid", "当前密码不正确")
        connection.execute("UPDATE users SET password_hash=? WHERE id=?", (hash_password(payload.new_password), user["id"]))
        revoke_all_sessions(connection, user["id"])
        connection.commit()
        request.app.state.limiter.clear(key)
        return _clear_cookies(Response(status_code=204), request)
    finally:
        connection.close()


@router.get("/account/devices")
def list_devices(request: Request):
    connection = connect(request.app.state.db_path)
    try:
        connection.execute("BEGIN")
        user = require_session(connection, request)
        rows = connection.execute(
            """SELECT g.id,g.device_name,g.created_at,g.legacy,
                      MAX(s.last_seen_at) AS last_seen_at,MAX(s.expires_at) AS expires_at
               FROM session_groups g JOIN sessions s ON s.group_id=g.id AND s.user_id=g.user_id
               WHERE g.user_id=? AND g.revoked_at IS NULL AND s.revoked_at IS NULL AND s.expires_at>?
               GROUP BY g.id ORDER BY g.created_at DESC,g.id""", (user["id"], now_iso()),
        ).fetchall()
        return {"devices": [{"id": row["id"], "device_name": row["device_name"], "created_at": row["created_at"],
                             "last_seen_at": row["last_seen_at"], "expires_at": row["expires_at"],
                             "current": row["id"] == user["group_id"], "legacy": bool(row["legacy"])} for row in rows]}
    finally:
        connection.close()


@router.delete("/account/devices/{group_id}")
def delete_device(group_id: str, request: Request):
    connection = connect(request.app.state.db_path)
    try:
        connection.execute("BEGIN IMMEDIATE")
        user = require_session(connection, request)
        group = connection.execute("SELECT id FROM session_groups WHERE id=? AND user_id=?", (group_id, user["id"])).fetchone()
        if not group:
            return error(404, "device_not_found", "设备不存在")
        revoke_group(connection, group_id)
        connection.commit()
        current_revoked = user["group_id"] == group_id
        response = JSONResponse(content={"current_revoked": current_revoked})
        return _clear_cookies(response, request) if current_revoked else response
    finally:
        connection.close()


@router.post("/account/logout-all")
def logout_all(request: Request):
    connection = connect(request.app.state.db_path)
    try:
        connection.execute("BEGIN IMMEDIATE")
        user = require_session(connection, request)
        revoke_all_sessions(connection, user["id"])
        connection.commit()
        return _clear_cookies(Response(status_code=204), request)
    finally:
        connection.close()


@router.get("/household/members")
def list_members(request: Request):
    connection = connect(request.app.state.db_path)
    try:
        connection.execute("BEGIN")
        user = require_session(connection, request, owner=True)
        rows = connection.execute(
            "SELECT id,username,display_name,role,created_at FROM users WHERE household_id=? AND disabled_at IS NULL ORDER BY role,created_at,id",
            (user["household_id"],),
        ).fetchall()
        return {"members": [dict(row) for row in rows]}
    finally:
        connection.close()


@router.delete("/household/members/{member_id}")
def remove_member(member_id: str, request: Request):
    connection = connect(request.app.state.db_path)
    try:
        connection.execute("BEGIN IMMEDIATE")
        user = require_session(connection, request, owner=True)
        member = connection.execute("SELECT * FROM users WHERE id=? AND household_id=?", (member_id, user["household_id"])).fetchone()
        if not member:
            return error(404, "member_not_found", "成员不存在")
        if member_id == user["id"] or member["role"] != "member":
            return error(403, "member_removal_forbidden", "不能移除自己或家庭管理员")
        connection.execute("UPDATE users SET disabled_at=COALESCE(disabled_at,?) WHERE id=?", (now_iso(), member_id))
        revoke_all_sessions(connection, member_id)
        connection.commit()
        return Response(status_code=204)
    finally:
        connection.close()


@router.get("/household/invites")
def list_invites(request: Request):
    connection = connect(request.app.state.db_path)
    try:
        connection.execute("BEGIN")
        user = require_session(connection, request, owner=True)
        rows = connection.execute("SELECT * FROM household_invites WHERE household_id=? ORDER BY created_at DESC,id", (user["household_id"],)).fetchall()
        return {"invites": [_invite_payload(row) for row in rows]}
    finally:
        connection.close()


@router.post("/household/invites")
def create_invite(request: Request):
    connection = connect(request.app.state.db_path)
    try:
        connection.execute("BEGIN IMMEDIATE")
        user = require_session(connection, request, owner=True)
        invite_id, code = str(uuid.uuid4()), new_token()
        created = datetime.now(timezone.utc).replace(microsecond=0)
        connection.execute(
            "INSERT INTO household_invites(id,household_id,created_by,code_hash,created_at,expires_at) VALUES (?,?,?,?,?,?)",
            (invite_id, user["household_id"], user["id"], token_hash(code), created.isoformat(), (created + timedelta(days=7)).isoformat()),
        )
        row = connection.execute("SELECT * FROM household_invites WHERE id=?", (invite_id,)).fetchone()
        connection.commit()
        return JSONResponse(status_code=201, content={"invite": _invite_payload(row), "code": code}, headers={"Cache-Control": "no-store"})
    finally:
        connection.close()


@router.delete("/household/invites/{invite_id}")
def revoke_invite(invite_id: str, request: Request):
    connection = connect(request.app.state.db_path)
    try:
        connection.execute("BEGIN IMMEDIATE")
        user = require_session(connection, request, owner=True)
        row = connection.execute("SELECT * FROM household_invites WHERE id=? AND household_id=?", (invite_id, user["household_id"])).fetchone()
        if not row:
            return error(404, "invite_not_found", "邀请不存在")
        connection.execute("UPDATE household_invites SET revoked_at=COALESCE(revoked_at,?) WHERE id=?", (now_iso(), invite_id))
        connection.commit()
        return Response(status_code=204)
    finally:
        connection.close()


@router.post("/auth/join")
def join_household(payload: JoinHousehold, request: Request):
    # request.client is populated by the trusted ASGI proxy configuration;
    # do not trust a caller-supplied X-Forwarded-For header here.
    key = "join:" + (request.client.host if request.client else "unknown")
    blocked = _rate_limit(request, key)
    if blocked:
        return blocked
    connection = connect(request.app.state.db_path)
    try:
        connection.execute("BEGIN IMMEDIATE")
        current, _, _ = session_from_connection(connection, request)
        if current:
            return error(409, "already_authenticated", "请先退出当前账号，再加入家庭")
        blocked = _rate_limit(request, key)
        if blocked:
            return blocked
        invite = connection.execute(
            """SELECT inv.*,h.name AS household_name FROM household_invites inv
               JOIN households h ON h.id=inv.household_id WHERE inv.code_hash=?""", (token_hash(payload.code),),
        ).fetchone()
        if (not invite or invite["used_at"] or invite["revoked_at"]
                or datetime.fromisoformat(invite["expires_at"]) <= datetime.now(timezone.utc)):
            request.app.state.limiter.record_failure(key)
            return error(400, "invalid_invite", "邀请码无效或已失效")
        duplicate = connection.execute("SELECT id FROM users WHERE username=? COLLATE NOCASE", (payload.username,)).fetchone()
        if duplicate:
            request.app.state.limiter.record_failure(key)
            return error(409, "username_taken", "用户名已被使用")
        user_id, created = str(uuid.uuid4()), now_iso()
        connection.execute(
            """INSERT INTO users(id,household_id,username,password_hash,display_name,role,created_at)
               VALUES (?,?,?,?,?,'member',?)""",
            (user_id, invite["household_id"], payload.username, hash_password(payload.password), payload.display_name, created),
        )
        connection.execute("UPDATE household_invites SET used_at=?,used_by=? WHERE id=?", (created, user_id, invite["id"]))
        session_token, device_token = create_login_tokens(connection, user_id, request.app.state.settings, payload.remember, payload.device_name)
        user = connection.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
        connection.commit()
        request.app.state.limiter.clear(key)
        response = JSONResponse(status_code=201, content={"user": _user_payload(user), "household": {"id": invite["household_id"], "name": invite["household_name"]}})
        apply_login_cookies(response, request.app.state.settings, session_token, device_token)
        return response
    finally:
        connection.close()
