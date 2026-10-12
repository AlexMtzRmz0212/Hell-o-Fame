"""Cover and title review (owner only): list albums that need attention, propose Spotify's version, write the confirmed one."""

import re

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from musicbox import config, spotify
from musicbox.library import showcase
from musicbox.library.covers import compare, find_issues, is_spotify_image, library_view, suggest
from musicbox.library.sink import Change, push
from musicbox.library.source import NEEDS, fetch_albums, notion_client

from .auth import require_owner

router = APIRouter(prefix="/api/covers", dependencies=[Depends(require_owner)])

SPOTIFY = ["SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET"]


def _need(names: list[str]) -> None:
    missing = config.missing(names)
    if missing:
        raise HTTPException(503, "Missing settings: " + ", ".join(missing))


class SuggestBody(BaseModel):
    name: str = Field(min_length=1)
    artist: str = ""
    current: str | None = None  # the album's cover now, to tell which Spotify release it came from


class ApplyBody(BaseModel):
    id: str = Field(min_length=1)
    cover: str | None = None
    icon: str | None = None
    title: str | None = Field(default=None, max_length=300)


@router.get("/queue")
def queue():
    _need(NEEDS)
    albums = fetch_albums()
    return {
        "issues": [i.to_dict() for i in find_issues(albums)],
        "albums": library_view(albums),
        "can_suggest": not config.missing(SPOTIFY),
    }


@router.post("/suggest")
def propose(body: SuggestBody):
    _need(SPOTIFY)
    try:
        match = suggest(body.name, body.artist, body.current)
        return {"match": match, **compare(match)}
    except Exception as e:
        raise HTTPException(502, f"Spotify lookup failed: {e}")


@router.post("/album-tracks")
def album_tracks(body: SuggestBody):
    """Track list of a library album, found on Spotify by name and artist (the edition its cover belongs to if any)."""
    _need(SPOTIFY)
    try:
        match = suggest(body.name, body.artist, body.current)
        if not match:
            return {"found": False, "edition": None, "tracks": []}
        pick = next((o for o in match["options"] if o["is_current"]), match["options"][0])
        return {"found": True, "edition": pick["name"], "tracks": spotify.album_tracks(pick["id"])}
    except Exception as e:
        raise HTTPException(502, f"Spotify lookup failed: {e}")


@router.get("/tracks/{album_id}")
def tracks(album_id: str):
    """Track list of one Spotify album, so two editions can be compared side by side."""
    _need(SPOTIFY)
    if not re.fullmatch(r"[A-Za-z0-9]{22}", album_id):
        raise HTTPException(400, "Not a Spotify album id")
    try:
        return {"tracks": spotify.album_tracks(album_id)}
    except Exception as e:
        raise HTTPException(502, f"Spotify lookup failed: {e}")


@router.post("/apply")
def apply(body: ApplyBody):
    _need(NEEDS)
    title = (body.title or "").strip() or None
    if not body.cover and not title:
        raise HTTPException(400, "Nothing to change")
    if (body.cover and not is_spotify_image(body.cover)) or (body.icon and not is_spotify_image(body.icon)):
        raise HTTPException(400, "Only Spotify cover images can be written")
    try:
        push(notion_client(), Change(body.id, body.id, title=title, cover=body.cover, icon=body.icon))
    except Exception as e:
        raise HTTPException(502, f"Notion refused the update: {e}")
    showcase.clear_cache()  # the public wall should show the new cover right away
    return {"ok": True}
