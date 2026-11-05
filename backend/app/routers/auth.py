from __future__ import annotations

import secrets
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse

from ..db import connect, now_iso
from ..schemas import LoginIn, SetupIn
from ..security import (
    clear_auth_cookie,
    client_ip,
    hash_password,
    new_token,
    set_auth_cookie,
    token_hash,
    verify_password,
)
from ..session import (
    DEVICE_COOKIE,
    SESSION_COOKIE,
    revoke_group,
    session_from_connection,
)

router = APIRouter(prefix="/api")


def error(status_code: int, code: str, message: str, headers: dict | None = None) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={"error": {"code": code, "message": message}},
        headers=headers,
    )


def _db(request: Request):
    return connect(request.app.state.db_path)


def _user_payload(row) -> dict:
    return {
        "id": row["id"],
        "username": row["username"],
        "display_name": row["display_name"],
        "role": row["role"],
    }


def _household_payload(row) -> dict:
    return {"id": row["household_id"], "name": row["household_name"]}


def _expires(days: int) -> str:
    return (datetime.now(timezone.utc) + timedelta(days=days)).isoformat(timespec="seconds")


def _create_session(connection, user_id: str, kind: str, device_name: str | None, days: int, group_id: str) -> str:
    token = new_token()
    connection.execute(
        """
        INSERT INTO sessions (id, user_id, token_hash, kind, device_name, last_seen_at, expires_at, created_at, group_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            str(uuid.uuid4()),
            user_id,
            token_hash(token),
            kind,
            device_name,
            now_iso(),
            _expires(days),
            now_iso(),
            group_id,
        ),
    )
    return token


def create_login_tokens(connection, user_id: str, settings, remember: bool, device_name: str | None):
    group_id = str(uuid.uuid4())
    name = (device_name or "未命名设备").strip()[:60] or "未命名设备"
    connection.execute("INSERT INTO session_groups(id,user_id,device_name,created_at) VALUES (?,?,?,?)",
                       (group_id, user_id, name, now_iso()))
    session_token = _create_session(connection, user_id, "session", name, settings.session_days, group_id)
    device_token = _create_session(connection, user_id, "device", name, settings.device_days, group_id) if remember else None
    return session_token, device_token


def apply_login_cookies(response, settings, session_token: str, device_token: str | None):
    set_auth_cookie(response, SESSION_COOKIE, session_token, settings.session_days * 86400, settings)
    if device_token:
        set_auth_cookie(response, DEVICE_COOKIE, device_token, settings.device_days * 86400, settings)
    else:
        clear_auth_cookie(response, DEVICE_COOKIE, settings)


@router.get("/setup/status")
def setup_status(request: Request):
    connection = _db(request)
    try:
        count = connection.execute("SELECT COUNT(*) AS n FROM users").fetchone()["n"]
    finally:
        connection.close()
    return {"needed": count == 0}


@router.post("/setup")
def setup(payload: SetupIn, request: Request):
    settings = request.app.state.settings
    token_path: Path = settings.data_dir / "setup-token"

    connection = _db(request)
    try:
        connection.execute("BEGIN IMMEDIATE")
        count = connection.execute("SELECT COUNT(*) AS n FROM users").fetchone()["n"]
        if count > 0:
            return error(409, "setup_already_done", "这个实例已经初始化过了")

        expected = token_path.read_text(encoding="utf-8").strip() if token_path.exists() else ""
        if not expected or not secrets.compare_digest(expected, payload.token.strip()):
            return error(403, "setup_token_invalid", "初始化令牌不正确")

        household_id = str(uuid.uuid4())
        user_id = str(uuid.uuid4())
        created = now_iso()
        connection.execute(
            "INSERT INTO households (id, name, created_at) VALUES (?, ?, ?)",
            (household_id, payload.household_name.strip(), created),
        )
        connection.execute(
            """
            INSERT INTO users (id, household_id, username, password_hash, display_name, role, created_at)
            VALUES (?, ?, ?, ?, ?, 'owner', ?)
            """,
            (user_id, household_id, payload.username.strip(), hash_password(payload.password), payload.username.strip(), created),
        )
        token, _ = create_login_tokens(connection, user_id, settings, False, None)
        connection.commit()

        try:
            token_path.unlink()
        except FileNotFoundError:
            pass

        response = JSONResponse(
            status_code=201,
            content={
                "user": {
                    "id": user_id,
                    "username": payload.username.strip(),
                    "display_name": payload.username.strip(),
                    "role": "owner",
                },
                "household": {"id": household_id, "name": payload.household_name.strip()},
            },
        )
        set_auth_cookie(response, SESSION_COOKIE, token, settings.session_days * 86400, settings)
        return response
    finally:
        connection.close()


@router.post("/auth/login")
def login(payload: LoginIn, request: Request):
    settings = request.app.state.settings
    limiter = request.app.state.limiter
    key = f"{client_ip(request)}|{payload.username.strip().lower()}"

    retry_after = limiter.retry_after(key)
    if retry_after is not None:
        return error(
            429,
            "too_many_attempts",
            "登录尝试过多，请稍后再试",
            headers={"Retry-After": str(retry_after)},
        )

    connection = _db(request)
    try:
        connection.execute("BEGIN IMMEDIATE")
        retry_after = limiter.retry_after(key)
        if retry_after is not None:
            return error(429, "too_many_attempts", "登录尝试过多，请稍后再试", headers={"Retry-After": str(retry_after)})
        row = connection.execute(
            "SELECT id, username, password_hash, display_name, role, household_id FROM users WHERE username = ? COLLATE NOCASE AND disabled_at IS NULL",
            (payload.username.strip(),),
        ).fetchone()
        if not row or not verify_password(row["password_hash"], payload.password):
            limiter.record_failure(key)
            return error(401, "invalid_credentials", "用户名或密码不正确")

        limiter.clear(key)
        session_token, device_token = create_login_tokens(connection, row["id"], settings, payload.remember, payload.device_name)
        connection.commit()

        user = {
            "id": row["id"],
            "username": row["username"],
            "display_name": row["display_name"],
            "role": row["role"],
        }
        response = JSONResponse(status_code=200, content={"user": user})
        apply_login_cookies(response, settings, session_token, device_token)
        return response
    finally:
        connection.close()


@router.get("/me")
def me(request: Request, response: Response):
    settings = request.app.state.settings
    connection = _db(request)
    try:
        connection.execute("BEGIN IMMEDIATE")
        row, _, token = session_from_connection(connection, request)
        if not row:
            return error(401, "not_authenticated", "请先登录")
        if row["kind"] == "device":
            new_expiry = _expires(settings.device_days)
            connection.execute(
                "UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?",
                (now_iso(), new_expiry, row["session_id"]),
            )
            connection.commit()
            set_auth_cookie(response, DEVICE_COOKIE, token, settings.device_days * 86400, settings)
        else:
            connection.execute(
                "UPDATE sessions SET last_seen_at = ? WHERE id = ?", (now_iso(), row["session_id"])
            )
            connection.commit()
        return {"user": _user_payload(row), "household": _household_payload(row)}
    finally:
        connection.close()


@router.post("/auth/logout")
def logout(request: Request):
    settings = request.app.state.settings
    connection = _db(request)
    try:
        connection.execute("BEGIN IMMEDIATE")
        for cookie_name in (SESSION_COOKIE, DEVICE_COOKIE):
            token = request.cookies.get(cookie_name)
            if token:
                row = connection.execute("SELECT group_id FROM sessions WHERE token_hash=?", (token_hash(token),)).fetchone()
                if row and row["group_id"]:
                    revoke_group(connection, row["group_id"])
        connection.commit()
    finally:
        connection.close()

    response = Response(status_code=204)
    clear_auth_cookie(response, SESSION_COOKIE, settings)
    clear_auth_cookie(response, DEVICE_COOKIE, settings)
    return response
