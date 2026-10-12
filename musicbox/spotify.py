"""Spotify Web API, client-credentials flow (no user login, public catalogue only)."""

import time

import requests

from . import config

_token: dict = {"value": "", "expires": 0.0}


def get_token() -> str:
    if _token["value"] and time.time() < _token["expires"]:
        return _token["value"]
    client_id = config.get("SPOTIFY_CLIENT_ID")
    client_secret = config.get("SPOTIFY_CLIENT_SECRET")
    if not client_id or not client_secret:
        raise ValueError("SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET must be set")
    response = requests.post(
        "https://accounts.spotify.com/api/token",
        data={"grant_type": "client_credentials", "client_id": client_id, "client_secret": client_secret},
        timeout=20,
    )
    if response.status_code != 200:
        raise RuntimeError(f"Spotify auth failed ({response.status_code})")
    body = response.json()
    _token["value"] = body["access_token"]
    _token["expires"] = time.time() + body.get("expires_in", 3600) - 60
    return _token["value"]


def search(query: str, kind: str = "album", limit: int = 10) -> list[dict]:
    """Search the catalogue. `kind` is 'album', 'artist' or 'track'; returns the raw items."""
    response = requests.get(
        "https://api.spotify.com/v1/search",
        headers={"Authorization": f"Bearer {get_token()}"},
        params={"q": query, "type": kind, "limit": limit},
        timeout=20,
    )
    if response.status_code != 200:
        raise RuntimeError(f"Spotify search failed ({response.status_code})")
    return response.json()[f"{kind}s"]["items"]


def album_tracks(album_id: str) -> list[dict]:
    """The tracks of one album, in order: [{n, name, seconds, explicit}]."""
    tracks: list[dict] = []
    url = f"https://api.spotify.com/v1/albums/{album_id}/tracks"
    params: dict | None = {"limit": 50}
    while url:
        response = requests.get(url, headers={"Authorization": f"Bearer {get_token()}"}, params=params, timeout=20)
        if response.status_code != 200:
            raise RuntimeError(f"Spotify album tracks failed ({response.status_code})")
        body = response.json()
        for item in body["items"]:
            tracks.append({
                "n": item.get("track_number"),
                "disc": item.get("disc_number", 1),
                "name": item.get("name", ""),
                "seconds": round((item.get("duration_ms") or 0) / 1000),
                "explicit": bool(item.get("explicit")),
            })
        url, params = body.get("next"), None  # `next` already carries its own query
    return tracks


def _get(url: str) -> dict:
    response = requests.get(url, headers={"Authorization": f"Bearer {get_token()}"}, timeout=20)
    if response.status_code != 200:
        raise RuntimeError(f"Spotify lookup failed ({response.status_code})")
    return response.json()


def get_album(album_id: str) -> dict:
    """One album by Spotify id (the raw object: name, artists, images, release_date, total_tracks...)."""
    return _get(f"https://api.spotify.com/v1/albums/{album_id}")


def artist_genres(artist_id: str) -> list[str]:
    """Spotify's genre tags for an artist (lower case); empty when it has none."""
    return list(_get(f"https://api.spotify.com/v1/artists/{artist_id}").get("genres") or [])
