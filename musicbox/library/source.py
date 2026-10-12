"""Pull: read the Notion album library into Album objects."""

from typing import Optional

from notion_client import Client

from .. import config
from ..runtime import fetch_all_pages
from .models import Album

NEEDS = ["NOTION_ALBUMS_SECRET", "ALBUMS_LIBRARY_DB_ID"]

# Everything page_to_album reads. Passed to Notion so the formulas, buttons and
# friends' columns are never even downloaded.
PROPERTIES = [
    "Album", "Artist", "Genre", "Release Date", "Decade", "Alex Top",
    "Status", "Album of the Day", "Picked by",
]


def _text(prop: dict) -> Optional[str]:
    parts = prop.get("title") or prop.get("rich_text") or []
    return "".join(p.get("plain_text", "") for p in parts).strip() or None


def _select(prop: dict) -> Optional[str]:
    option = prop.get("select") or prop.get("status")
    return option.get("name") if option else None


def _date(prop: dict) -> Optional[str]:
    date = prop.get("date")
    return date.get("start") if date else None


def _formula(prop: dict) -> Optional[str]:
    value = prop.get("formula") or {}
    result = value.get(value.get("type", ""))
    return str(result) if result not in (None, "") else None


def _image(value: Optional[dict]) -> Optional[str]:
    if not value:
        return None
    kind = value.get("type")
    if kind in ("external", "file"):
        return (value.get(kind) or {}).get("url")
    return None


def _icon_kind(icon: Optional[dict]) -> Optional[str]:
    if not icon:
        return None
    kind = icon.get("type")
    if kind == "icon":
        return "placeholder" if (icon.get("icon") or {}).get("name") == "music-album" else "native"
    return {"emoji": "emoji", "file": "upload", "external": "external"}.get(kind, "native")


def page_to_album(page: dict) -> Album:
    """Pure mapper from a Notion page to an Album."""
    props = page.get("properties", {})
    rank = _select(props.get("Alex Top", {}))
    return Album(
        page_id=page["id"],
        name=_text(props.get("Album", {})) or "Untitled",
        artist=_select(props.get("Artist", {})) or "Unknown",
        genres=[o["name"] for o in props.get("Genre", {}).get("multi_select", [])],
        release_date=_date(props.get("Release Date", {})),
        decade=_formula(props.get("Decade", {})),
        rank=int(rank) if rank and rank.isdigit() else None,
        rank_text=rank,
        status=_select(props.get("Status", {})) or "Unknown",
        album_of_day=_date(props.get("Album of the Day", {})),
        picked_by=_select(props.get("Picked by", {})),
        cover=_image(page.get("cover")),
        has_icon=bool(page.get("icon")),
        icon_kind=_icon_kind(page.get("icon")),
    )


def notion_client() -> Client:
    """Notion client for the album library; raises ValueError if it isn't configured."""
    missing = config.missing(NEEDS)
    if missing:
        raise ValueError("Missing settings: " + ", ".join(missing))
    return Client(auth=config.get("NOTION_ALBUMS_SECRET"))


def fetch_albums(notion: Optional[Client] = None, db_id: Optional[str] = None) -> list[Album]:
    notion = notion or notion_client()
    db_id = db_id or config.get("ALBUMS_LIBRARY_DB_ID")
    return [page_to_album(p) for p in fetch_all_pages(notion, db_id, filter_properties=PROPERTIES)]
