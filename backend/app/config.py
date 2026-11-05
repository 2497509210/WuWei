from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


def _split_origins(value: str) -> tuple[str, ...]:
    return tuple(item.strip() for item in value.split(",") if item.strip())


@dataclass(frozen=True)
class Settings:
    data_dir: Path
    static_dir: Path | None = None
    base_path: str = ""
    secure_cookies: bool = False
    allowed_origins: tuple[str, ...] = field(
        default_factory=lambda: (
            "http://testserver",
            "http://localhost:5173",
            "http://127.0.0.1:5173",
        )
    )
    session_days: int = 30
    device_days: int = 365
    login_max_attempts: int = 10
    login_window_seconds: int = 600
    login_lock_seconds: int = 900
    version: str = "0.1.0"

    def __post_init__(self) -> None:
        base = (self.base_path or "").rstrip("/")
        if base and not base.startswith("/"):
            raise ValueError("base_path must start with '/'")
        object.__setattr__(self, "base_path", base)

    @property
    def cookie_path(self) -> str:
        return self.base_path or "/"

    @classmethod
    def from_env(cls) -> "Settings":
        backend_dir = Path(__file__).resolve().parents[1]
        workspace = backend_dir.parent
        data_dir = Path(os.environ.get("WUWEI_DATA_DIR", str(backend_dir / "data"))).resolve()
        default_static = workspace / "frontend" / "dist"
        static_dir = Path(os.environ.get("WUWEI_STATIC_DIR", str(default_static))).resolve()
        return cls(
            data_dir=data_dir,
            static_dir=static_dir,
            base_path=os.environ.get("WUWEI_BASE_PATH", ""),
            secure_cookies=os.environ.get("WUWEI_SECURE_COOKIES", "0") == "1",
            allowed_origins=_split_origins(
                os.environ.get(
                    "WUWEI_ALLOWED_ORIGINS",
                    "http://testserver,http://localhost:5173,http://127.0.0.1:5173",
                )
            ),
            version=os.environ.get("WUWEI_VERSION", "0.1.0"),
        )
