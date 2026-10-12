"""Pick the Album of the Day (owner only): what is waiting to be listened to, a Spotify search for anything else,
and choosing one, which sets today's date on its library page (creating the page when the album is new)."""

import re
from datetime import date, datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from musicbox import config, spotify
from musicbox.library import showcase
from musicbox.library.models import LISTENED
from musicbox.library.pick import (
    PICKED_BY, album_properties, choose_properties, find_in_library, images, matching_genres, primary_artist, waiting,
)
from musicbox.library.source import NEEDS, fetch_albums, notion_client
from musicbox.library.transform import pick_images
from musicbox.runtime import with_retry

from .auth import require_owner

router = APIRouter(prefix="/api/pick", dependencies=[Depends(require_owner)])

SPOTIFY = ["SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET"]
DAY = re.compile(r"\d{4}-\d{2}-\d{2}")


def _need(names: list[str]) -> None:
    missing = config.missing(names)
    if missing:
        raise HTTPException(503, "Missing settings: " + ", ".join(missing))


class SearchBody(BaseModel):
    query: str = Field(min_length=1, max_length=200)


class ChooseBody(BaseModel):
    id: Optional[str] = None  # a library page: a queued album, or an "artist, no album yet" page
    spotify_id: Optional[str] = Field(default=None, pattern=r"^[A-Za-z0-9]{22}$")  # the Spotify album to use
    date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")  # the day it is the Album of the Day: today or a day to come


@router.get("/options")
def options():
    _need(NEEDS)
    return {**waiting(fetch_albums()), "can_search": not config.missing(SPOTIFY)}


@router.post("/search")
def search(body: SearchBody):
    """Spotify albums for a free-text search, each with what the library already knows about it."""
    _need(NEEDS + SPOTIFY)
    albums = fetch_albums()
    try:
        items = spotify.search(body.query.strip(), "album", limit=10)
    except Exception as e:
        raise HTTPException(502, f"Spotify lookup failed: {e}")
    results = []
    for item in items:
        cover, _ = pick_images(item)
        artist = primary_artist(item)
        page = find_in_library(albums, item.get("name", ""), artist)
        results.append({
            "spotify_id": item["id"],
            "name": item.get("name", ""),
            "artist": ", ".join(a["name"] for a in item.get("artists", [])),
            "cover": cover,
            "release_date": item.get("release_date"),
            "total_tracks": item.get("total_tracks"),
            "album_type": item.get("album_type"),
            "library": page and {"id": page.page_id, "status": page.status, "rank": page.rank_text},
        })
    return {"results": results}


def _check_day(day: str) -> None:
    try:
        chosen = date.fromisoformat(day)
    except ValueError:
        raise HTTPException(400, "Not a date")
    days_ahead = (chosen - datetime.now(timezone.utc).date()).days
    if days_ahead < -2:  # a browser's today is at most a day off UTC's
        raise HTTPException(400, "That day has already passed")
    if days_ahead > 400:
        raise HTTPException(400, "That is too far ahead")


@router.post("/choose")
def choose(body: ChooseBody):
    """Make an album the Album of the Day for a day (today, or one to come): its page gets that date and In progress.

    A queued album only needs its page. A Spotify album that is already in the library uses that page; one that
    isn't gets a new page, or fills the "artist, no album yet" page it was chosen for.
    """
    if not body.id and not body.spotify_id:
        raise HTTPException(400, "Choose an album")
    _check_day(body.date)
    _need(NEEDS + (SPOTIFY if body.spotify_id else []))
    notion = notion_client()
    albums = fetch_albums(notion)

    page = next((a for a in albums if a.page_id == body.id), None) if body.id else None
    if body.id and page is None:
        raise HTTPException(404, "That album isn't in the library any more")
    sp = None
    if body.spotify_id:
        try:
            sp = spotify.get_album(body.spotify_id)
        except Exception as e:
            raise HTTPException(502, f"Spotify lookup failed: {e}")
        if page is None:
            page = find_in_library(albums, sp.get("name", ""), primary_artist(sp))
    if page is not None and page.status == LISTENED:
        where = f" (No. {page.rank})" if page.rank else ""
        raise HTTPException(409, f"You have already listened to {page.name}{where}")

    properties = choose_properties(body.date)
    extras: dict = {}
    create = page is None
    if sp and (create or page.is_untitled):  # a new page, or an artist page that gets its album now
        try:
            genres = matching_genres(
                spotify.artist_genres(sp["artists"][0]["id"]),
                [o["name"] for o in notion.databases.retrieve(config.get("ALBUMS_LIBRARY_DB_ID"))["properties"]["Genre"]["multi_select"]["options"]],
            )
        except Exception:  # genres are a nicety: the pick works without them
            genres = []
        properties.update(album_properties(sp, genres, with_artist=create))
        extras = images(sp)
        if create:
            properties["Picked by"] = {"select": {"name": PICKED_BY}}
    elif sp and not page.has_art:
        extras = images(sp)

    if create:
        created = with_retry(lambda: notion.pages.create(
            parent={"database_id": config.get("ALBUMS_LIBRARY_DB_ID")}, properties=properties, **extras))
        page_id = created["id"]
    else:
        page_id = page.page_id
        with_retry(lambda: notion.pages.update(page_id, properties=properties, **extras))
    showcase.clear_cache()  # the Hall should show the new Album of the Day right away
    return {
        "id": page_id,
        "name": (sp or {}).get("name") if (create or (page and page.is_untitled)) else page.name,
        "created": create,
    }
