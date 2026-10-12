from fastapi.testclient import TestClient

from backend.main import app
from musicbox.tools import TOOLS, list_tools

client = TestClient(app)

EXPECTED = {
    "streams_songs", "streams_albums", "spotify_search", "setlistfm", "genius_lyrics", "album_icons",
    "purgatory_backup", "purgatory_restore",
}


def test_registry_has_every_tool():
    assert set(TOOLS) == EXPECTED
    for meta in list_tools():
        assert meta["title"] and meta["description"] and isinstance(meta["params"], list)


def test_protected_routes_need_login(monkeypatch):
    monkeypatch.setenv("OWNER_PASSWORD", "secret")
    assert client.get("/api/tools").status_code == 401
    assert client.post("/api/tools/spotify_search/run", json={}).status_code == 401
    assert client.post("/api/auth/login", json={"password": "nope"}).status_code == 401


def test_login_then_run(monkeypatch):
    monkeypatch.setenv("OWNER_PASSWORD", "secret")
    monkeypatch.setattr("musicbox.tools.spotify_search.spotify.search", lambda q, kind, limit: [
        {"name": "Blurryface", "artists": [{"name": "Twenty One Pilots"}], "release_date": "2015-05-17",
         "external_urls": {"spotify": "https://open.spotify.com/album/x"}}])
    monkeypatch.setenv("SPOTIFY_CLIENT_ID", "id")
    monkeypatch.setenv("SPOTIFY_CLIENT_SECRET", "s")
    assert client.post("/api/auth/login", json={"password": "secret"}).status_code == 204
    body = client.post("/api/tools/spotify_search/run", json={"params": {"query": "x"}}).json()
    assert body["ok"] and body["result"]["rows"][0]["name"] == "Blurryface"
    assert client.post("/api/tools/nope/run", json={}).status_code == 404


def test_missing_settings_is_a_result_not_a_crash(monkeypatch):
    monkeypatch.delenv("OWNER_PASSWORD", raising=False)  # local dev: auth off
    monkeypatch.setattr("musicbox.config.get", lambda name, default="": "")
    body = client.post("/api/tools/genius_lyrics/run", json={}).json()
    assert not body["ok"] and "GENIUS_TOKEN" in body["error"]

