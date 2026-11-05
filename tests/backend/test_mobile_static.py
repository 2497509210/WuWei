import io
import json

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.config import Settings
from app.main import create_app


@pytest.mark.parametrize('prefix', ['', '/wuwei'])
def test_mobile_manifest_and_icons_are_served_as_files_not_spa_html(tmp_path, prefix):
    static = tmp_path / 'dist'
    icons = static / 'app-icons'
    icons.mkdir(parents=True)
    (static / 'index.html').write_text('<div id="root"></div>', encoding='utf8')
    manifest = {'name': '物位', 'start_url': './find', 'scope': './', 'display': 'standalone'}
    (static / 'manifest.webmanifest').write_text(json.dumps(manifest), encoding='utf8')
    data = io.BytesIO()
    Image.new('RGB', (192, 192), '#33312b').save(data, format='PNG')
    (icons / 'icon-192.png').write_bytes(data.getvalue())
    with TestClient(create_app(Settings(data_dir=tmp_path/'data', static_dir=static, base_path=prefix))) as client:
        response = client.get(prefix + '/manifest.webmanifest')
        assert response.status_code == 200
        assert response.headers['content-type'].startswith('application/manifest+json')
        assert response.json() == manifest
        icon = client.get(prefix + '/app-icons/icon-192.png')
        assert icon.status_code == 200 and icon.headers['content-type'].startswith('image/png')
        assert icon.content == data.getvalue()
        assert client.get(prefix + '/app-icons/missing.png').status_code == 404


def test_missing_manifest_returns_404_instead_of_installable_html(client):
    assert client.get('/manifest.webmanifest').status_code == 404
