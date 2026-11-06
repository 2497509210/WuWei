"""Request correlation without recording submitted values, URLs or credentials."""
from __future__ import annotations

import json
import logging
import re
import secrets
from time import perf_counter

from starlette.responses import JSONResponse

logger = logging.getLogger("uvicorn.error")


class RequestDiagnostics:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        supplied = dict(scope.get("headers", [])).get(b"x-request-id", b"")
        request_id = supplied.decode("ascii") if re.fullmatch(rb"[0-9a-f]{32}", supplied) else secrets.token_hex(16)
        scope.setdefault("state", {})["request_id"] = request_id
        start = perf_counter()
        received_at = None
        response_at = None
        started = False
        status = 500
        error_type = None

        async def measured_receive():
            nonlocal received_at
            message = await receive()
            if message["type"] == "http.request" and not message.get("more_body", False):
                received_at = perf_counter()
            return message

        async def measured_send(message):
            nonlocal started, status, response_at
            if message["type"] == "http.response.start":
                started = True
                status = message["status"]
                response_at = perf_counter()
                headers = [(name, value) for name, value in message.get("headers", []) if name.lower() not in (b"x-request-id", b"server-timing")]
                headers.extend([(b"x-request-id", request_id.encode("ascii")),
                                (b"server-timing", f"app;dur={(response_at - start) * 1000:.2f}".encode("ascii"))])
                message = {**message, "headers": headers}
            await send(message)

        try:
            await self.app(scope, measured_receive, measured_send)
        except Exception as exc:
            error_type = type(exc).__name__
            if not started:
                response = JSONResponse({"error": {"code": "internal_error", "message": "服务器处理失败，请稍后重试"}}, status_code=500,
                                        headers={"X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Cache-Control": "no-store"})
                await response(scope, measured_receive, measured_send)
            else:
                # The connection already has response headers; it must terminate
                # rather than pretending a partially sent response succeeded.
                raise
        finally:
            route = getattr(scope.get("route"), "path", "unmatched")
            if route == "/{full_path:path}":
                route = "unmatched"
            row = {"event": "request", "request_id": request_id, "method": scope.get("method", ""),
                   "route": route, "status": status, "elapsed_ms": round((perf_counter() - start) * 1000, 2)}
            if received_at is not None:
                row["body_receive_ms"] = round((received_at - start) * 1000, 2)
                row["after_body_ms"] = round(max(0, (response_at or perf_counter()) - received_at) * 1000, 2)
            if error_type:
                row["error_type"] = error_type
            logger.log(logging.ERROR if error_type else logging.INFO, json.dumps(row, separators=(",", ":")))
