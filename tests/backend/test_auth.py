import sqlite3
from datetime import datetime, timezone

import pytest

from conftest import read_setup_token, setup_household


def test_setup_status_starts_needed(client):
    response = client.get("/api/setup/status")
    assert response.status_code == 200
    assert response.json() == {"needed": True}


def test_setup_rejects_wrong_token(client):
    response = client.post(
        "/api/setup",
        json={
            "token": "wrong",
            "household_name": "我家",
            "username": "owner",
            "password": "password123",
        },
    )
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "setup_token_invalid"


def test_setup_creates_owner_and_session(client):
    token = read_setup_token(client)
    response = client.post(
        "/api/setup",
        json={
            "token": token,
            "household_name": "我家",
            "username": "owner",
            "password": "password123",
        },
    )
    assert response.status_code == 201
    body = response.json()
    assert body["user"]["username"] == "owner"
    assert body["user"]["role"] == "owner"
    assert body["household"]["name"] == "我家"

    set_cookie = response.headers["set-cookie"]
    assert "wuwei_session=" in set_cookie
    assert "HttpOnly" in set_cookie
    assert "SameSite=lax" in set_cookie

    me = client.get("/api/me")
    assert me.status_code == 200
    assert me.json()["user"]["username"] == "owner"

    assert client.get("/api/setup/status").json() == {"needed": False}
    assert not (client.app.state.settings.data_dir / "setup-token").exists()

    second = client.post(
        "/api/setup",
        json={
            "token": token,
            "household_name": "第二个家",
            "username": "other",
            "password": "password123",
        },
    )
    assert second.status_code == 409
    assert second.json()["error"]["code"] == "setup_already_done"


def test_password_is_hashed(client):
    setup_household(client)
    db_path = client.app.state.settings.data_dir / "wuwei.db"
    with sqlite3.connect(db_path) as connection:
        row = connection.execute("SELECT password_hash FROM users").fetchone()
    assert row is not None
    assert row[0] != "password123"
    assert row[0].startswith("$argon2id$")


def test_login_logout_flow(client):
    setup_household(client)
    assert client.post("/api/auth/logout").status_code == 204
    assert client.get("/api/me").status_code == 401

    wrong = client.post("/api/auth/login", json={"username": "owner", "password": "nope"})
    assert wrong.status_code == 401
    assert wrong.json()["error"]["code"] == "invalid_credentials"

    ok = client.post("/api/auth/login", json={"username": "owner", "password": "password123"})
    assert ok.status_code == 200
    assert ok.json()["user"]["username"] == "owner"
    assert "wuwei_session=" in ok.headers["set-cookie"]

    assert client.get("/api/me").status_code == 200
    assert client.post("/api/auth/logout").status_code == 204
    assert client.get("/api/me").status_code == 401


def test_remember_device_cookie_survives_session_cookie(client):
    setup_household(client)
    client.post("/api/auth/logout")

    response = client.post(
        "/api/auth/login",
        json={"username": "owner", "password": "password123", "remember": True, "device_name": "Pixel 9"},
    )
    assert response.status_code == 200
    set_cookie = response.headers["set-cookie"]
    assert "wuwei_device=" in set_cookie
    assert "Max-Age=31536000" in set_cookie

    client.cookies.pop("wuwei_session", None)
    me = client.get("/api/me")
    assert me.status_code == 200

    db_path = client.app.state.settings.data_dir / "wuwei.db"
    with sqlite3.connect(db_path) as connection:
        kind, device_name, expires_at = connection.execute(
            "SELECT kind, device_name, expires_at FROM sessions WHERE kind = 'device'"
        ).fetchone()
    assert kind == "device"
    assert device_name == "Pixel 9"
    expires = datetime.fromisoformat(expires_at)
    assert (expires - datetime.now(timezone.utc)).days > 300


def test_origin_guard_blocks_cross_site_writes(client):
    setup_household(client)
    client.post("/api/auth/logout")

    blocked = client.post(
        "/api/auth/login",
        json={"username": "owner", "password": "password123"},
        headers={"Origin": "https://evil.example"},
    )
    assert blocked.status_code == 403
    assert blocked.json()["error"]["code"] == "origin_not_allowed"

    allowed = client.post(
        "/api/auth/login",
        json={"username": "owner", "password": "password123"},
        headers={"Origin": "http://testserver"},
    )
    assert allowed.status_code == 200


def test_login_rate_limit_locks_after_ten_failures(client):
    setup_household(client)
    client.post("/api/auth/logout")

    for _ in range(10):
        response = client.post("/api/auth/login", json={"username": "owner", "password": "wrong"})
        assert response.status_code == 401

    locked = client.post("/api/auth/login", json={"username": "owner", "password": "password123"})
    assert locked.status_code == 429
    assert locked.json()["error"]["code"] == "too_many_attempts"


def test_weak_password_is_rejected(client):
    token = read_setup_token(client)
    response = client.post(
        "/api/setup",
        json={"token": token, "household_name": "我家", "username": "owner", "password": "short"},
    )
    assert response.status_code == 422


def test_login_whitespace_cannot_bypass_lock(client):
    setup_household(client)
    client.post("/api/auth/logout")
    for _ in range(10):
        assert client.post("/api/auth/login", json={"username": "owner", "password": "wrong"}).status_code == 401
    response = client.post("/api/auth/login", json={"username": " Owner ", "password": "password123"})
    assert response.status_code == 429


def test_login_forwarded_header_cannot_bypass_lock(client):
    setup_household(client)
    client.post("/api/auth/logout")
    for index in range(10):
        result = client.post("/api/auth/login", json={"username": "owner", "password": "wrong"}, headers={"X-Forwarded-For": f"198.51.100.{index}"})
        assert result.status_code == 401
    blocked = client.post("/api/auth/login", json={"username": "owner", "password": "password123"}, headers={"X-Forwarded-For": "203.0.113.42"})
    assert blocked.status_code == 429
