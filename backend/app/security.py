from __future__ import annotations

import hashlib
import secrets
import threading
import time
from collections import defaultdict, deque

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerifyMismatchError
from fastapi import Request, Response

from .config import Settings

_hasher = PasswordHasher()


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password_hash: str, password: str) -> bool:
    try:
        return _hasher.verify(password_hash, password)
    except (VerifyMismatchError, InvalidHashError):
        return False


def new_token() -> str:
    return secrets.token_urlsafe(32)


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def client_ip(request: Request) -> str:
    # ASGI proxy middleware applies the trusted-proxy policy before this point.
    # Reading a raw forwarding header here would let callers rotate limiter keys.
    return request.client.host if request.client else "unknown"


def origin_allowed(origin: str, settings: Settings) -> bool:
    return origin in settings.allowed_origins


def set_auth_cookie(response: Response, name: str, token: str, max_age: int, settings: Settings) -> None:
    response.set_cookie(
        key=name,
        value=token,
        max_age=max_age,
        httponly=True,
        secure=settings.secure_cookies,
        samesite="lax",
        path=settings.cookie_path,
    )


def clear_auth_cookie(response: Response, name: str, settings: Settings) -> None:
    response.delete_cookie(key=name, path=settings.cookie_path, httponly=True, samesite="lax")


class LoginLimiter:
    """Small in-process limiter. One process per household, so memory is enough."""

    def __init__(self, max_attempts: int, window_seconds: int, lock_seconds: int) -> None:
        self.max_attempts = max_attempts
        self.window_seconds = window_seconds
        self.lock_seconds = lock_seconds
        self._failures: dict[str, deque[float]] = defaultdict(deque)
        self._locked_until: dict[str, float] = {}
        self._lock = threading.Lock()

    def retry_after(self, key: str) -> int | None:
        now = time.monotonic()
        with self._lock:
            locked_until = self._locked_until.get(key)
            if locked_until and locked_until > now:
                return max(1, int(locked_until - now))
            if locked_until and locked_until <= now:
                self._locked_until.pop(key, None)
                self._failures.pop(key, None)
            return None

    def record_failure(self, key: str) -> None:
        now = time.monotonic()
        with self._lock:
            bucket = self._failures[key]
            bucket.append(now)
            while bucket and bucket[0] < now - self.window_seconds:
                bucket.popleft()
            if len(bucket) >= self.max_attempts:
                self._locked_until[key] = now + self.lock_seconds
                bucket.clear()

    def clear(self, key: str) -> None:
        with self._lock:
            self._failures.pop(key, None)
            self._locked_until.pop(key, None)
