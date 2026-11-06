from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import sqlite3
import threading

import pytest
from fastapi.testclient import TestClient

from test_items import db


def login_browser(client, *, username="owner", password="password123", remember=True, name="手机"):
    browser = TestClient(client.app)
    response = browser.post("/api/auth/login", json={"username": username, "password": password, "remember": remember, "device_name": name})
    assert response.status_code == 200, response.text
    return browser


def create_invite(client):
    response = client.post("/api/household/invites")
    assert response.status_code == 201, response.text
    return response.json()


def join_payload(code, username="member"):
    return {"code": code, "username": username, "display_name": " 家人 ", "password": "member-password", "remember": True, "device_name": "家人的手机"}


def join_member(owner, username="member"):
    invite = create_invite(owner)
    browser = TestClient(owner.app)
    response = browser.post("/api/auth/join", json=join_payload(invite["code"], username))
    assert response.status_code == 201, response.text
    return browser, response.json()["user"]


def test_profile_trims_display_name_without_changing_username_or_role(setup_client):
    response = setup_client.patch("/api/account/profile", json={"display_name": " 管理员 ", "role": "member", "username": "different"})
    assert response.status_code == 200, response.text
    assert response.json()["user"]["display_name"] == "管理员"
    assert response.json()["user"]["username"] == "owner"
    assert response.json()["user"]["role"] == "owner"
    assert setup_client.get("/api/me").json()["user"]["display_name"] == "管理员"
    assert setup_client.patch("/api/account/profile", json={"display_name": "  "}).status_code == 422


def test_device_groups_hide_secrets_and_revoke_both_tokens(setup_client):
    browser = login_browser(setup_client)
    short, remembered = browser.cookies.get("wuwei_session"), browser.cookies.get("wuwei_device")
    devices = setup_client.get("/api/account/devices")
    assert devices.status_code == 200, devices.text
    rows = devices.json()["devices"]
    assert len(rows) == 2
    assert sum(row["current"] for row in rows) == 1
    phone = next(row for row in rows if row["device_name"] == "手机")
    assert phone["legacy"] is False and phone["current"] is False
    assert set(phone) == {"id", "device_name", "created_at", "last_seen_at", "expires_at", "current", "legacy"}
    assert short not in devices.text and remembered not in devices.text
    response = setup_client.delete(f"/api/account/devices/{phone['id']}")
    assert response.status_code == 200 and response.json() == {"current_revoked": False}
    assert browser.get("/api/me").status_code == 401
    browser.cookies.pop("wuwei_session")
    assert browser.get("/api/me").status_code == 401
    assert setup_client.get("/api/me").status_code == 200


def test_revoke_current_group_clears_cookies_and_remember_fallback(setup_client):
    browser = login_browser(setup_client)
    remembered = browser.cookies.get("wuwei_device")
    browser.cookies.pop("wuwei_session")
    devices = browser.get("/api/account/devices").json()["devices"]
    current = next(row for row in devices if row["current"])
    response = browser.delete(f"/api/account/devices/{current['id']}")
    assert response.status_code == 200 and response.json()["current_revoked"] is True
    assert "wuwei_device" not in browser.cookies and "wuwei_session" not in browser.cookies
    browser.cookies.set("wuwei_device", remembered)
    assert browser.get("/api/me").status_code == 401


def test_normal_logout_revokes_whole_group_even_without_device_cookie(setup_client):
    browser = login_browser(setup_client)
    remembered = browser.cookies.pop("wuwei_device")
    assert browser.post("/api/auth/logout").status_code == 204
    browser.cookies.set("wuwei_device", remembered)
    assert browser.get("/api/me").status_code == 401


def test_logout_all_invalidates_every_login(setup_client):
    browser = login_browser(setup_client)
    response = setup_client.post("/api/account/logout-all")
    assert response.status_code == 204
    assert not setup_client.cookies
    assert browser.get("/api/me").status_code == 401
    browser.cookies.pop("wuwei_session")
    assert browser.get("/api/me").status_code == 401


def test_password_change_verifies_current_and_revokes_all_devices(setup_client):
    browser = login_browser(setup_client)
    wrong = setup_client.post("/api/account/password", json={"current_password": "incorrect", "new_password": "new-password"})
    assert wrong.status_code == 400
    assert browser.get("/api/me").status_code == 200
    changed = setup_client.post("/api/account/password", json={"current_password": "password123", "new_password": "new-password"})
    assert changed.status_code == 204 and not setup_client.cookies
    assert browser.get("/api/me").status_code == 401
    browser.cookies.pop("wuwei_session")
    assert browser.get("/api/me").status_code == 401
    assert setup_client.post("/api/auth/login", json={"username": "owner", "password": "password123"}).status_code == 401
    assert setup_client.post("/api/auth/login", json={"username": "owner", "password": "new-password"}).status_code == 200


def test_password_change_throttles_failures_across_sessions(setup_client):
    browser = login_browser(setup_client)
    for _ in range(10):
        assert setup_client.post("/api/account/password", json={"current_password": "wrong", "new_password": "new-password"}).status_code == 400
    blocked = browser.post("/api/account/password", json={"current_password": "password123", "new_password": "new-password"})
    assert blocked.status_code == 429 and int(blocked.headers["Retry-After"]) > 0
    assert browser.get("/api/me").status_code == 200


def test_invite_is_hashed_single_use_and_creates_member_with_grouped_cookies(setup_client):
    invitation = create_invite(setup_client)
    code, invite = invitation["code"], invitation["invite"]
    created, expiry = datetime.fromisoformat(invite["created_at"]), datetime.fromisoformat(invite["expires_at"])
    assert (expiry - created).total_seconds() == 7 * 86400
    listed = setup_client.get("/api/household/invites")
    assert listed.status_code == 200 and code not in listed.text
    with db(setup_client) as connection:
        stored = connection.execute("SELECT code_hash FROM household_invites WHERE id=?", (invite["id"],)).fetchone()[0]
    assert stored == hashlib.sha256(code.encode()).hexdigest()
    browser = TestClient(setup_client.app)
    result = browser.post("/api/auth/join", json={**join_payload(code), "role": "owner"})
    assert result.status_code == 201, result.text
    assert result.json()["user"]["role"] == "member" and result.json()["user"]["display_name"] == "家人"
    assert result.json()["household"]["id"] == setup_client.get("/api/me").json()["household"]["id"]
    assert "wuwei_session" in browser.cookies and "wuwei_device" in browser.cookies
    assert len(browser.get("/api/account/devices").json()["devices"]) == 1
    retry = TestClient(setup_client.app).post("/api/auth/join", json=join_payload(code, "second"))
    assert retry.status_code == 400 and retry.json()["error"]["code"] == "invalid_invite"
    assert setup_client.get("/api/household/invites").json()["invites"][0]["used_at"]


@pytest.mark.parametrize("mode", ["revoked", "expired", "invalid"])
def test_unusable_invite_has_uniform_error_and_creates_nothing(setup_client, mode):
    invitation = create_invite(setup_client)
    if mode == "revoked":
        assert setup_client.delete(f"/api/household/invites/{invitation['invite']['id']}").status_code == 204
        assert setup_client.delete(f"/api/household/invites/{invitation['invite']['id']}").status_code == 204
    elif mode == "expired":
        with db(setup_client) as connection:
            connection.execute("UPDATE household_invites SET expires_at='2020-01-01T00:00:00+00:00'")
    code = invitation["code"] if mode != "invalid" else "invalid-code"
    result = TestClient(setup_client.app).post("/api/auth/join", json=join_payload(code))
    assert result.status_code == 400 and result.json() == {"error": {"code": "invalid_invite", "message": "邀请码无效或已失效"}}
    assert len(setup_client.get("/api/household/members").json()["members"]) == 1


def test_failed_registration_does_not_consume_invite(setup_client):
    invitation = create_invite(setup_client)
    browser = TestClient(setup_client.app)
    invalid = browser.post("/api/auth/join", json={**join_payload(invitation["code"]), "password": "short"})
    assert invalid.status_code == 422
    duplicate = browser.post("/api/auth/join", json=join_payload(invitation["code"], "OWNER"))
    assert duplicate.status_code == 409
    result = browser.post("/api/auth/join", json=join_payload(invitation["code"], "new-member"))
    assert result.status_code == 201


def test_logged_in_join_rejected_without_switching_identity(setup_client):
    invitation = create_invite(setup_client)
    result = setup_client.post("/api/auth/join", json=join_payload(invitation["code"]))
    assert result.status_code == 409
    assert setup_client.get("/api/me").json()["user"]["username"] == "owner"
    assert setup_client.get("/api/household/invites").json()["invites"][0]["used_at"] is None


def test_join_throttle_cannot_be_bypassed_by_rotating_codes_or_usernames(setup_client):
    browser = TestClient(setup_client.app)
    for index in range(10):
        assert browser.post("/api/auth/join", json=join_payload(f"wrong-{index}", f"name{index}")).status_code == 400
    invitation = create_invite(setup_client)
    result = browser.post("/api/auth/join", json=join_payload(invitation["code"]))
    assert result.status_code == 429 and "Retry-After" in result.headers


def test_member_permissions_and_owner_removal_protection(setup_client):
    member, user = join_member(setup_client)
    owner_id = setup_client.get("/api/me").json()["user"]["id"]
    for method, url in [("get", "/api/household/members"), ("get", "/api/household/invites"), ("post", "/api/household/invites"), ("delete", f"/api/household/members/{owner_id}")]:
        assert getattr(member, method)(url).status_code == 403
    assert setup_client.delete(f"/api/household/members/{owner_id}").status_code == 403
    own_group = setup_client.get("/api/account/devices").json()["devices"][0]["id"]
    assert member.delete(f"/api/account/devices/{own_group}").status_code == 404
    assert setup_client.get("/api/me").status_code == 200


def test_soft_disabled_member_loses_every_token_and_history_identity_remains(setup_client):
    member, user = join_member(setup_client)
    from test_items import add_items, item_location
    _, _, slot = item_location(setup_client)
    item = add_items(member, slot["id"]).json()["items"][0]
    remembered = member.cookies.get("wuwei_device")
    removed = setup_client.delete(f"/api/household/members/{user['id']}")
    assert removed.status_code == 204
    assert member.get("/api/me").status_code == 401
    member.cookies.pop("wuwei_session")
    assert member.get("/api/me").status_code == 401
    assert member.post("/api/auth/login", json={"username": "member", "password": "member-password"}).status_code == 401
    assert [row["id"] for row in setup_client.get("/api/household/members").json()["members"]] != [user["id"]]
    assert setup_client.get(f"/api/items/{item['id']}/events").json()["events"][0]["actor_name"] == "家人"
    with db(setup_client) as connection:
        assert connection.execute("SELECT disabled_at FROM users WHERE id=?", (user["id"],)).fetchone()[0]
        assert connection.execute("SELECT created_by FROM items WHERE id=?", (item["id"],)).fetchone()[0] == user["id"]
    invite = create_invite(setup_client)
    assert TestClient(setup_client.app).post("/api/auth/join", json=join_payload(invite["code"])).status_code == 409


def test_foreign_household_invite_and_member_ids_are_hidden(setup_client):
    with db(setup_client) as connection:
        connection.execute("INSERT INTO households(id,name,created_at) VALUES ('foreign','other','2020')")
        connection.execute("INSERT INTO users(id,household_id,username,password_hash,display_name,role,created_at) VALUES ('foreign-user','foreign','foreign','unused','other','member','2020')")
        connection.execute("INSERT INTO household_invites(id,household_id,created_by,code_hash,created_at,expires_at) VALUES ('foreign-invite','foreign','foreign-user','unused','2020','2099')")
    assert setup_client.delete("/api/household/members/foreign-user").status_code == 404
    assert setup_client.delete("/api/household/invites/foreign-invite").status_code == 404


def test_invite_redemption_and_user_creation_roll_back_together(setup_client):
    invitation = create_invite(setup_client)
    with db(setup_client) as connection:
        connection.execute("CREATE TRIGGER reject_member BEFORE INSERT ON users WHEN NEW.role='member' BEGIN SELECT RAISE(ABORT, 'reject member'); END")
    browser = TestClient(setup_client.app)
    response = browser.post("/api/auth/join", json=join_payload(invitation["code"]))
    assert response.status_code == 500 and response.json()["error"]["code"] == "internal_error"
    with db(setup_client) as connection:
        assert connection.execute("SELECT used_at FROM household_invites WHERE id=?", (invitation["invite"]["id"],)).fetchone()[0] is None
        assert connection.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 1


@pytest.mark.parametrize("revocation", ["session", "role"])
def test_privileged_write_rechecks_auth_after_waiting_for_transaction(setup_client, monkeypatch, revocation):
    # A real competing writer changes authorization before this request obtains its write lock.
    from app.routers import accounts
    from app.db import connect
    attempted = threading.Event()

    class ObservedConnection:
        def __init__(self, connection):
            self.connection = connection

        def execute(self, sql, *args):
            if sql == "BEGIN IMMEDIATE":
                attempted.set()
            return self.connection.execute(sql, *args)

        def __getattr__(self, name):
            return getattr(self.connection, name)

    monkeypatch.setattr(accounts, "connect", lambda path: ObservedConnection(connect(path)))
    connection = sqlite3.connect(setup_client.app.state.db_path)
    connection.execute("BEGIN IMMEDIATE")
    try:
        with ThreadPoolExecutor(max_workers=1) as executor:
            pending = executor.submit(setup_client.post, "/api/household/invites")
            assert attempted.wait(5), "request never attempted its transaction"
            if revocation == "session":
                connection.execute("UPDATE sessions SET revoked_at='2026-01-01'")
            else:
                connection.execute("UPDATE users SET role='member'")
            connection.commit()
            response = pending.result(timeout=5)
        assert response.status_code == (401 if revocation == "session" else 403)
        assert connection.execute("SELECT COUNT(*) FROM household_invites").fetchone()[0] == 0
    finally:
        connection.close()


@pytest.mark.parametrize("method,url,payload", [
    ("get", "/api/account/devices", None), ("get", "/api/household/members", None),
    ("patch", "/api/account/profile", {"display_name": "nobody"}),
    ("post", "/api/account/password", {"current_password": "old", "new_password": "password123"}),
    ("post", "/api/account/logout-all", None), ("post", "/api/household/invites", None),
])
def test_account_endpoints_require_auth(client, method, url, payload):
    result = client.request(method, url, json=payload)
    assert result.status_code == 401


def test_join_rate_limit_is_rechecked_after_queued_requests_acquire_lock(setup_client, monkeypatch):
    from app.routers import accounts
    from app.db import connect
    attempted = threading.Condition()
    waiting = 0

    class QueuedConnection:
        def __init__(self, connection):
            self.connection = connection

        def execute(self, sql, *args):
            nonlocal waiting
            if sql == "BEGIN IMMEDIATE":
                with attempted:
                    waiting += 1
                    attempted.notify_all()
            return self.connection.execute(sql, *args)

        def __getattr__(self, name):
            return getattr(self.connection, name)

    monkeypatch.setattr(accounts, "connect", lambda path: QueuedConnection(connect(path)))
    connection = sqlite3.connect(setup_client.app.state.db_path)
    connection.execute("BEGIN IMMEDIATE")
    try:
        def request(index):
            return TestClient(setup_client.app).post("/api/auth/join", json=join_payload(f"invalid-{index}", f"name{index}")).status_code

        with ThreadPoolExecutor(max_workers=11) as executor:
            results = [executor.submit(request, index) for index in range(11)]
            with attempted:
                all_waiting = attempted.wait_for(lambda: waiting == 11, timeout=5)
            connection.commit()
            assert all_waiting, "requests did not queue at the write lock"
            statuses = [result.result(timeout=5) for result in results]
        assert statuses.count(400) == 10
        assert statuses.count(429) == 1
    finally:
        connection.close()
