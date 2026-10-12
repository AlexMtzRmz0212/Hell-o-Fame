"""Modify: pure functions over Album lists. No I/O in here."""

from typing import Optional

from .models import Album


def rank_listened(
    albums: list[Album], compact: bool = False, tiebreak: Optional[list[str]] = None
) -> list[tuple[Album, str]]:
    """Unique, zero-padded "Alex Top" ranks for every listened (or in progress) album that already has one.

    Albums sharing a rank are ordered by their position in `tiebreak` (page ids, the playoff result), then by
    Notion order; the rest of the list is bumped down to make room. Unranked albums are left out.
    With `compact` the ranks are renumbered 1..N without gaps.
    """
    position = {page_id: i for i, page_id in enumerate(tiebreak or [])}
    rated = sorted(
        (a for a in albums if a.is_rankable and a.rank is not None),
        key=lambda a: (a.rank, position.get(a.page_id, len(position))),
    )

    ordered: list[tuple[Album, int]] = []
    last = 0
    for album in rated:
        last = album.rank if album.rank > last else last + 1
        ordered.append((album, last))

    if compact:
        ordered = [(album, i) for i, (album, _) in enumerate(ordered, 1)]
    width = 3 if ordered and (ordered[-1][1] > 99 or len(ordered) > 99) else 2
    return [(album, f"{rank:0{width}d}") for album, rank in ordered]


def place_album(albums: list[Album], page_id: str, rank: int) -> list[tuple[Album, str]]:
    """Give one album the "Alex Top" rank `rank` and move down only the albums that are in its way.

    Nothing else is touched: ties stay ties and gaps stay gaps. The albums holding `rank`, `rank` + 1... up to the
    first free number each move down one place (a tie moves together), and everything below that stays put.
    `rank` is clamped to 1..(last rank + 1). Works for an unranked album and for moving a ranked one.
    Returns only the albums whose rank text changes, as (album, new text); the first is the placed album.
    Raises ValueError when the album isn't there or isn't one you listen to.
    """
    target = next((a for a in albums if a.page_id == page_id), None)
    if target is None:
        raise ValueError("That album isn't in the library any more")
    if not target.is_rankable:
        raise ValueError("Only albums you have listened to (or are listening to) can be ranked")
    others = [a for a in albums if a.page_id != page_id and a.is_rankable and a.rank is not None]
    rank = max(1, min(rank, max((a.rank for a in others), default=0) + 1))

    taken = {a.rank for a in others}
    free = rank
    while free in taken:
        free += 1  # the first number nobody holds: the albums before it make room, the ones after it don't move
    moved = [a for a in others if rank <= a.rank < free]
    width = max([2, len(str(free)), *(len(a.rank_text or "") for a in others)])

    changes = [(target, f"{rank:0{width}d}")] + [(a, f"{a.rank + 1:0{width}d}") for a in sorted(moved, key=lambda a: a.rank)]
    return [(a, text) for a, text in changes if text != a.rank_text]


def pick_images(spotify_album: dict) -> tuple[Optional[str], Optional[str]]:
    """(cover, icon) from a Spotify album: the largest image and the smallest one."""
    images = spotify_album.get("images") or []
    return (images[0]["url"], images[-1]["url"]) if images else (None, None)
