import json
import logging
import re

from fastapi import Request
from fastapi.testclient import TestClient


def records(caplog):
    return [json.loads(record.message) for record in caplog.records if record.message.startswith('{"event":"request"')]


def test_request_id_survives_error_and_logging_excludes_user_input(client, caplog):
    caplog.set_level(logging.INFO, logger="uvicorn.error")
    request_id = "1a" * 16
    response = client.get("/api/items/private-item-id?q=private-search", headers={"X-Request-ID": request_id, "Cookie": "private-cookie"})
    assert response.status_code == 401
    assert response.headers.get("x-request-id") == request_id
    assert "app;dur=" in response.headers.get("server-timing", "")
    rows = records(caplog)
    assert len(rows) == 1
    assert rows[0]["route"] == "/api/items/{item_id}"
    assert rows[0]["status"] == 401 and rows[0]["request_id"] == request_id
    assert rows[0]["elapsed_ms"] >= 0
    assert all(secret not in caplog.text for secret in ("private-item-id", "private-search", "private-cookie"))


def test_invalid_client_id_replaced_and_early_origin_error_has_id(client, caplog):
    caplog.set_level(logging.INFO, logger="uvicorn.error")
    response = client.post("/api/items/secret-value", json={"notes": "private-note"}, headers={"Origin": "https://outside.test", "X-Request-ID": "untrusted-secret-id"})
    assert response.status_code == 403
    assert re.fullmatch(r"[0-9a-f]{32}", response.headers.get("x-request-id", ""))
    assert "untrusted-secret-id" not in caplog.text and "private-note" not in caplog.text
    assert records(caplog)[0]["route"] == "unmatched"


def test_unhandled_failure_has_safe_response_and_correlated_log(client, caplog):
    @client.app.post("/api/fail-diagnostic")
    def fails():
        raise RuntimeError("secret-from-database")

    caplog.set_level(logging.INFO, logger="uvicorn.error")
    # An application exception must become a bounded generic JSON error, not leak its message.
    with TestClient(client.app, raise_server_exceptions=False) as browser:
        response = browser.post("/api/fail-diagnostic")
    assert response.status_code == 500
    assert response.json()["error"]["code"] == "internal_error"
    request_id = response.headers["x-request-id"]
    row = records(caplog)[0]
    assert row["request_id"] == request_id and row["error_type"] == "RuntimeError"
    assert "secret-from-database" not in response.text + caplog.text


def test_body_receiving_diagnostics_do_not_consume_request_body(client, caplog):
    @client.app.post("/api/diagnostic-echo")
    async def echo(request: Request):
        body = await request.json()
        return {"length": len(body["secret"])}

    caplog.set_level(logging.INFO, logger="uvicorn.error")
    response = client.post("/api/diagnostic-echo", json={"secret": "not-for-log"})
    assert response.json() == {"length": 11}
    row = records(caplog)[0]
    assert row["body_receive_ms"] >= 0 and row["after_body_ms"] >= 0
    assert "not-for-log" not in caplog.text
