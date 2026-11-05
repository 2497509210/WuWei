from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


def test_health_reports_ok(client):
    response = client.get("/api/health")
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["db"] == "ok"
    assert body["version"]


def test_static_index_and_spa_fallback(client):
    root = client.get("/")
    assert root.status_code == 200
    assert "wuw ei" in root.text

    deep_link = client.get("/settings")
    assert deep_link.status_code == 200
    assert "wuw ei" in deep_link.text


def test_unknown_api_is_json_404(client):
    response = client.get("/api/does-not-exist")
    assert response.status_code == 404
    assert response.headers["content-type"].startswith("application/json")
    assert response.json()["error"]["code"] == "not_found"


def test_assets_work_when_app_is_mounted_under_base_path(tmp_path):
    static = tmp_path / "dist"
    (static / "assets").mkdir(parents=True)
    (static / "assets" / "app.js").write_text("console.log('wuwei')", encoding="utf-8")
    (static / "index.html").write_text("<!doctype html><div id=root></div>", encoding="utf-8")
    settings = Settings(
        data_dir=tmp_path / "data",
        static_dir=static,
        base_path="/wuwei",
        secure_cookies=False,
        allowed_origins=("http://testserver",),
    )
    with TestClient(create_app(settings)) as client:
        response = client.get("/wuwei/assets/app.js")
        assert response.status_code == 200
        assert "wuwei" in response.text


def test_large_static_asset_is_gzipped(tmp_path):
    static = tmp_path / "dist"
    (static / "assets").mkdir(parents=True)
    (static / "assets" / "big.js").write_text("const x = 1;\n" * 500, encoding="utf-8")
    (static / "index.html").write_text("<!doctype html><div id=root></div>", encoding="utf-8")
    settings = Settings(data_dir=tmp_path / "data", static_dir=static)
    with TestClient(create_app(settings)) as client:
        response = client.get("/assets/big.js", headers={"Accept-Encoding": "gzip"})
        assert response.status_code == 200
        assert response.headers.get("content-encoding") == "gzip"
