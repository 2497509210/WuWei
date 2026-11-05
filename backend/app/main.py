from __future__ import annotations

import os
import secrets
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.gzip import GZipMiddleware

from .config import Settings
from .db import connect, init_db
from .routers import accounts, auth, bulk_items, compartments, containers, exports, health, items, rooms
from .security import LoginLimiter, origin_allowed


def ensure_setup_token(settings: Settings) -> None:
    data_dir = settings.data_dir
    token_path = data_dir / "setup-token"
    connection = connect(data_dir / "wuwei.db")
    try:
        count = connection.execute("SELECT COUNT(*) AS n FROM users").fetchone()["n"]
    finally:
        connection.close()

    if count == 0:
        if not token_path.exists():
            token_path.write_text(secrets.token_urlsafe(24) + "\n", encoding="utf-8")
            try:
                os.chmod(token_path, 0o600)
            except OSError:
                pass
    else:
        try:
            token_path.unlink()
        except FileNotFoundError:
            pass


class StripBasePathMiddleware:
    """Support both /api and /wuwei/api when mounted behind a path proxy."""

    def __init__(self, app, base_path: str) -> None:
        self.app = app
        self.base_path = (base_path or "").rstrip("/")

    async def __call__(self, scope, receive, send):
        if scope["type"] in ("http", "websocket") and self.base_path:
            path = scope.get("path", "")
            if path == self.base_path:
                scope["path"] = "/"
            elif path.startswith(self.base_path + "/"):
                scope["path"] = path[len(self.base_path) :]
        await self.app(scope, receive, send)


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        db_path = init_db(settings.data_dir)
        app.state.db_path = db_path
        ensure_setup_token(settings)
        yield

    app = FastAPI(title="物位", version=settings.version, lifespan=lifespan)
    app.state.settings = settings
    app.state.limiter = LoginLimiter(
        settings.login_max_attempts,
        settings.login_window_seconds,
        settings.login_lock_seconds,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.allowed_origins),
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.add_middleware(GZipMiddleware, minimum_size=1024)
    app.add_middleware(StripBasePathMiddleware, base_path=settings.base_path)

    @app.middleware("http")
    async def origin_guard(request: Request, call_next):
        if request.method in {"POST", "PUT", "PATCH", "DELETE"}:
            origin = request.headers.get("origin")
            if origin and not origin_allowed(origin, settings):
                return JSONResponse(
                    status_code=403,
                    content={
                        "error": {
                            "code": "origin_not_allowed",
                            "message": "请求来源不被允许",
                        }
                    },
                )
        return await call_next(request)

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Referrer-Policy", "same-origin")
        response.headers.setdefault("Permissions-Policy", "geolocation=(), microphone=(), camera=()")
        response.headers.setdefault(
            "Content-Security-Policy",
            "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; "
            "script-src 'self'; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; "
            "frame-ancestors 'none'",
        )
        if settings.secure_cookies:
            response.headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
        return response

    @app.exception_handler(StarletteHTTPException)
    async def http_exception_handler(request: Request, exc: StarletteHTTPException):
        detail = exc.detail
        if isinstance(detail, dict) and "code" in detail:
            content = {"error": detail}
        else:
            content = {"error": {"code": "http_error", "message": str(detail)}}
        return JSONResponse(status_code=exc.status_code, content=content)

    app.include_router(health.router)
    app.include_router(auth.router)
    app.include_router(accounts.router)
    app.include_router(rooms.router)
    app.include_router(containers.router)
    app.include_router(compartments.router)
    app.include_router(bulk_items.router)
    app.include_router(exports.router)
    app.include_router(items.router)

    static_dir: Path | None = settings.static_dir
    if static_dir and static_dir.exists():
        assets = static_dir / "assets"
        if assets.exists():
            app.mount("/assets", StaticFiles(directory=assets), name="assets")
        icons = static_dir / "app-icons"
        if icons.exists():
            app.mount("/app-icons", StaticFiles(directory=icons), name="app-icons")

    @app.get("/manifest.webmanifest")
    def manifest():
        source = static_dir / "manifest.webmanifest" if static_dir else None
        if source and source.is_file():
            return FileResponse(source, media_type="application/manifest+json", headers={"Cache-Control": "no-cache"})
        return JSONResponse(status_code=404, content={"error": {"code": "not_found", "message": "资源不存在"}})

    def index_response() -> HTMLResponse | FileResponse:
        if static_dir:
            index = static_dir / "index.html"
            if index.exists():
                return FileResponse(index)
        return HTMLResponse(
            "<!doctype html><meta charset='utf-8'><title>物位</title>"
            "<body style='font-family:system-ui;padding:40px'>前端尚未构建：请先在 frontend 执行 <code>npm run build</code>。</body>"
        )

    @app.get("/")
    def index():
        return index_response()

    @app.get("/{full_path:path}")
    def spa_fallback(full_path: str):
        if full_path.startswith(("api/", "media/", "app-icons/")):
            return JSONResponse(
                status_code=404,
                content={"error": {"code": "not_found", "message": "接口不存在"}},
            )
        return index_response()

    return app


app = create_app()
