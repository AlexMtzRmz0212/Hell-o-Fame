"""Pick the Album of the Day: what is waiting to be listened to, and the Notion fields for choosing one.

Pure functions, no I/O. backend/pick.py reads Notion and Spotify and writes the result.
"""

import re
from datetime import date
from typing import Optional

from .models import IN_PROGRESS, Album
from .transform import pick_images

NOT_LISTENED = "Not listened"
PICKED_BY = "Alex"  # who picks an album through the hub


def _norm(text: Optional[str]) -> str:
    return re.sub(r"\W+", "", (text or "").casefold())


def _recommender(album: Album) -> Optional[str]:
    """Who recommended it, when that isn't me: my own name on everything says nothing."""
    return album.picked_by if album.picked_by != PICKED_BY else None


def waiting(albums: list[Album]) -> dict:
    """What can be picked from the library itself.

    `queued` are albums with a title that aren't listened to yet. `artists` are the pages that only have an artist
    (an option to listen to, no album chosen yet): choosing one means finding an album of theirs on Spotify.
    """
    pending = [a for a in albums if a.status == NOT_LISTENED]
    queued = sorted((a for a in pending if not a.is_untitled), key=lambda a: (a.name.casefold(), a.artist.casefold()))
    artists = sorted((a for a in pending if a.is_untitled and a.artist != "Unknown"), key=lambda a: a.artist.casefold())
    return {
        "queued": [
            {"id": a.page_id, "name": a.name, "artist": a.artist, "cover": a.cover if a.has_art else None,
             "genres": a.genres, "release_date": a.release_date, "picked_by": _recommender(a)}
            for a in queued
        ],
        "artists": [{"id": a.page_id, "artist": a.artist, "picked_by": _recommender(a)} for a in artists],
    }


def find_in_library(albums: list[Album], name: str, artist: str) -> Optional[Album]:
    """The library page of an album with this title and artist (case, accents' marks and punctuation ignored)."""
    return next(
        (a for a in albums if not a.is_untitled and _norm(a.name) == _norm(name) and _norm(a.artist) == _norm(artist)),
        None,
    )


def release_day(raw: Optional[str]) -> Optional[str]:
    """Spotify's release date as a full ISO day: "2018" and "2018-02" only know the year or the month."""
    if not raw:
        return None
    parts = raw.split("-")
    try:
        return date(int(parts[0]), int(parts[1]) if len(parts) > 1 else 1, int(parts[2]) if len(parts) > 2 else 1).isoformat()
    except ValueError:
        return None


def primary_artist(spotify_album: dict) -> str:
    # a select option can't hold a comma in Notion
    artists = spotify_album.get("artists") or [{}]
    return (artists[0].get("name") or "Unknown").replace(",", "").strip() or "Unknown"


def matching_genres(artist_genres: list[str], library_genres: list[str], limit: int = 4) -> list[str]:
    """The artist's genres that the library already has as a Genre option (compared ignoring case), in the library's spelling."""
    known = {g.casefold(): g for g in library_genres}
    found: list[str] = []
    for genre in artist_genres:
        name = known.get(genre.casefold())
        if name and name not in found:
            found.append(name)
    return found[:limit]


def choose_properties(day: str) -> dict:
    """What choosing an album means: today's date as its Album of the Day, and it is being listened to."""
    return {"Album of the Day": {"date": {"start": day}}, "Status": {"status": {"name": IN_PROGRESS}}}


def album_properties(spotify_album: dict, genres: list[str], with_artist: bool) -> dict:
    """Title, release date, genres (and the artist) of a Spotify album, as Notion properties."""
    properties: dict = {"Album": {"title": [{"type": "text", "text": {"content": spotify_album.get("name", "")}}]}}
    if with_artist:
        properties["Artist"] = {"select": {"name": primary_artist(spotify_album)}}
    day = release_day(spotify_album.get("release_date"))
    if day:
        properties["Release Date"] = {"date": {"start": day}}
    if genres:
        properties["Genre"] = {"multi_select": [{"name": g} for g in genres]}
    return properties


def images(spotify_album: dict) -> dict:
    """The page cover and icon for a Spotify album (its largest and smallest image); empty when it has none."""
    cover, icon = pick_images(spotify_album)
    out: dict = {}
    if cover:
        out["cover"] = {"type": "external", "external": {"url": cover}}
    if icon:
        out["icon"] = {"type": "external", "external": {"url": icon}}
    return out
