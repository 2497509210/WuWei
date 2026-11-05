import pathlib
import sys

import pytest
from fastapi.testclient import TestClient

WORKSPACE = pathlib.Path(__file__).resolve().parents[2]
BACKEND = WORKSPACE / "backend"
sys.path.insert(0, str(BACKEND))

from app.config import Settings  # noqa: E402
from app.main import create_app  # noqa: E402


@pytest.fixture
def client(tmp_path):
    static = tmp_path / "dist"
    static.mkdir()
    (static / "index.html").write_text("<!doctype html><title>wuw ei</title><div id=root></div>", encoding="utf-8")
    settings = Settings(
        data_dir=tmp_path / "data",
        static_dir=static,
        base_path="",
        secure_cookies=False,
        allowed_origins=("http://testserver",),
    )
    app = create_app(settings)
    with TestClient(app) as test_client:
        yield test_client


def read_setup_token(client):
    return (client.app.state.settings.data_dir / "setup-token").read_text(encoding="utf-8").strip()


def setup_household(client, username="owner", password="password123", household="我家"):
    token = read_setup_token(client)
    response = client.post(
        "/api/setup",
        json={
            "token": token,
            "household_name": household,
            "username": username,
            "password": password,
        },
    )
    assert response.status_code == 201, response.text
    return response


@pytest.fixture
def setup_client(client):
    setup_household(client)
    return client
