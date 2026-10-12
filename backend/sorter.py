"""Album sorter (owner only): the ranked albums to run playoffs on, and writing the decided order."""

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from musicbox import config
from musicbox.library import showcase
from musicbox.library.models import IN_PROGRESS, LISTENED
from musicbox.library.sink import Change, apply_changes
from musicbox.library.source import NEEDS, fetch_albums, notion_client
from musicbox.library.transform import place_album, rank_listened
from musicbox.runtime import RunLog

from .auth import require_owner

router = APIRouter(prefix="/api/sorter", dependencies=[Depends(require_owner)])


def _need() -> None:
    missing = config.missing(NEEDS)
    if missing:
        raise HTTPException(503, "Missing settings: " + ", ".join(missing))


class ApplyBody(BaseModel):
    tiebreak: list[str] = Field(default_factory=list, max_length=5000)  # page ids, the playoff result
    compact: bool = True  # renumber 1..N without gaps (what the album sorter always asks for)


@router.get("/albums")
def albums():
    """Every listened (or in progress) album that has an "Alex Top" rank; the playoffs and the preview run on these."""
    _need()
    return {
        "albums": [
            {"id": a.page_id, "name": a.name, "artist": a.artist, "cover": a.cover if a.has_art else None,
             "rank": a.rank, "rank_text": a.rank_text}
            for a in fetch_albums()
            if a.is_rankable and a.rank is not None
        ]
    }


class PlaceBody(BaseModel):
    id: str  # page id of the album to rank (today's Album of the Day)
    rank: int = Field(ge=1, le=100000)  # the rank number to give it; the albums in its way move down


@router.post("/place")
def place(body: PlaceBody):
    """Give one album a rank and write only the pages that change: it, and the albums it pushes down.

    Unlike /apply this never renumbers the rest or settles ties: those are decided in Purgatory.
    """
    _need()
    notion = notion_client()
    albums = fetch_albums(notion)
    try:
        changed = place_album(albums, body.id, body.rank)
    except ValueError as e:
        raise HTTPException(422, str(e))
    # ranking an album I was still listening to means I have listened to it
    target = next(a for a in albums if a.page_id == body.id)
    flip = {body.id} if target.status == IN_PROGRESS else set()
    changes = [Change.of(a, rank=text, status=LISTENED if a.page_id in flip else None) for a, text in changed]
    if flip and all(c.page_id != body.id for c in changes):  # it already held that rank: only its status changes
        changes.insert(0, Change.of(target, status=LISTENED))
    log = RunLog()
    written, failed = apply_changes(notion, changes, log, dry_run=False)
    if written:
        showcase.clear_cache()
    return {
        "written": written, "failed": failed, "log": log.lines,
        "ranks": {a.page_id: text for a, text in changed}, "listened": sorted(flip),
    }


@router.post("/apply")
def apply(body: ApplyBody):
    """Rank from fresh Notion data with the playoff order, and write the pages whose rank changes."""
    _need()
    notion = notion_client()
    ranked = rank_listened(fetch_albums(notion), compact=body.compact, tiebreak=body.tiebreak)
    changes = [Change.of(a, rank=rank) for a, rank in ranked if rank != a.rank_text]
    log = RunLog()
    written, failed = apply_changes(notion, changes, log, dry_run=False)
    if written:
        showcase.clear_cache()  # the public wall is ordered by rank
    return {"written": written, "failed": failed, "log": log.lines}
