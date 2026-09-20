import pytest

from bot.config import Config
from bot.dashboard import create_app
from bot.storage import data_path


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setenv("MOA_ENV", "production")
    monkeypatch.setenv("DASHBOARD_USERNAME", "owner")
    monkeypatch.setenv("DASHBOARD_PASSWORD", "test-password-long-enough")
    monkeypatch.setenv("DASHBOARD_SESSION_SECRET", "test-session-secret-that-is-long-enough")
    monkeypatch.setattr("bot.dashboard.SETTINGS_PATH", tmp_path / "settings.json")
    monkeypatch.setattr("bot.dashboard.DAILY_USAGE_PATH", tmp_path / "usage.json")
    return create_app(Config("fake", "fake", "12345678", "01", True)).test_client()


def login(client, username="owner", password="test-password-long-enough", next_url="/"):
    with client.session_transaction() as browser_session:
        browser_session["login_csrf"] = "test-csrf-token"
    return client.post(
        "/login",
        data={
            "username": username,
            "password": password,
            "csrf_token": "test-csrf-token",
            "next": next_url,
        },
    )


@pytest.mark.parametrize("path", ["/", "/api/status", "/api/events"])
def test_private_routes_require_login(client, path):
    response = client.get(path)
    if path.startswith("/api/"):
        assert response.status_code == 401
        assert response.json == {"error": "로그인이 필요합니다."}
    else:
        assert response.status_code == 302
        assert response.headers["Location"].startswith("/login?next=")

    assert login(client).status_code == 302
    response = client.get(path)
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "no-store"


def test_login_page_and_static_assets_are_public(client):
    assert client.get("/login").status_code == 200
    assert client.get("/static/dashboard.css").status_code == 200


def test_login_rejects_wrong_credentials_and_external_redirect(client):
    response = login(client, password="wrong")
    assert response.status_code == 401
    assert "아이디 또는 비밀번호" in response.get_data(as_text=True)

    response = login(client, next_url="https://example.com/steal")
    assert response.headers["Location"] == "/"


def test_login_rejects_missing_csrf_token(client):
    response = client.post(
        "/login",
        data={"username": "owner", "password": "test-password-long-enough"},
    )
    assert response.status_code == 400
    assert client.get("/api/status").status_code == 401


def test_healthcheck_is_public_and_minimal(client):
    assert client.get("/healthz").json == {"ok": True}


@pytest.mark.parametrize("path,method", [("/api/start", "POST"), ("/api/stop", "POST"), ("/api/settings", "PUT")])
def test_unauthorized_or_cross_site_mutations_blocked(client, path, method):
    assert client.open(path, method=method).status_code == 401
    login(client)
    assert client.open(path, method=method).status_code == 403
    headers = {"X-Moa-Request": "dashboard", "Sec-Fetch-Site": "cross-site"}
    assert client.open(path, method=method, headers=headers).status_code == 403


def test_authenticated_settings_survive_app_restart(client):
    login(client)
    headers = {"X-Moa-Request": "dashboard"}
    response = client.put("/api/settings", json={"watchlist": ["000660"]}, headers=headers)
    assert response.status_code == 200
    restarted = create_app(Config("fake", "fake", "12345678", "01", True)).test_client()
    login(restarted)
    state = restarted.get("/api/status").json
    assert state["settings"]["watchlist"] == ["000660"]
    assert state["running"] is False


def test_logout_ends_session(client):
    login(client)
    response = client.post("/logout", headers={"X-Moa-Request": "dashboard"})
    assert response.json == {"ok": True}
    assert client.get("/api/status").status_code == 401


@pytest.mark.parametrize("password", ["", "short"])
def test_production_fails_closed_without_strong_credentials(monkeypatch, password):
    monkeypatch.setenv("MOA_ENV", "production")
    monkeypatch.setenv("DASHBOARD_USERNAME", "owner")
    monkeypatch.setenv("DASHBOARD_PASSWORD", password)
    with pytest.raises(ValueError, match="DASHBOARD_PASSWORD"):
        create_app(Config("fake", "fake", "12345678", "01", True))


def test_production_requires_session_secret(monkeypatch):
    monkeypatch.setenv("MOA_ENV", "production")
    monkeypatch.setenv("DASHBOARD_USERNAME", "owner")
    monkeypatch.setenv("DASHBOARD_PASSWORD", "test-password-long-enough")
    monkeypatch.delenv("DASHBOARD_SESSION_SECRET", raising=False)
    with pytest.raises(ValueError, match="DASHBOARD_SESSION_SECRET"):
        create_app(Config("fake", "fake", "12345678", "01", True))


def test_data_directory_is_created(monkeypatch, tmp_path):
    directory = tmp_path / "persistent" / "moa"
    monkeypatch.setenv("MOA_DATA_DIR", str(directory))
    assert data_path("usage.json") == directory / "usage.json"
    assert directory.is_dir()
