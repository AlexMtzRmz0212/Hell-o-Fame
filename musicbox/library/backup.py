"""The Purgatory backup: every ranked album's rank, kept in frontend/src/demo/sorterSnapshot.js.

The public demo plays on that file, so it doubles as a copy of the ranking to go back to. Albums are matched by title
and artist (no Notion page ids in a public repo). No I/O except reading and writing that one file.
"""

import json
from collections import Counter
from datetime import date
from pathlib import Path
from typing import Optional

from .models import Album

SNAPSHOT = Path(__file__).resolve().parents[2] / "frontend" / "src" / "demo" / "sorterSnapshot.js"
COVER_BASE = "https://i.scdn.co/image/"
_START = "export const SORTER_SNAPSHOT = ["


def rows_from(albums: list[Album]) -> list[list]:
    """[rank, album, artist, Spotify image id or None] for every album that takes part in the ranking, best first."""
    ranked = sorted((a for a in albums if a.is_rankable and a.rank is not None), key=lambda a: a.rank)
    return [
        [a.rank, a.name, a.artist, a.cover[len(COVER_BASE):] if a.has_art and a.cover.startswith(COVER_BASE) else None]
        for a in ranked
    ]


def render(rows: list[list], day: Optional[str] = None) -> str:
    body = ",\n".join("  " + json.dumps(row, ensure_ascii=False) for row in rows)
    return f"""// A copy of the owner's Purgatory (listened albums with an "Alex Top" rank, ties included) as of {day or date.today().isoformat()},
// so the public demo plays on the real thing, and so there is a ranking to go back to. [rank, album, artist, Spotify
// image id or null]. It is only data: the demo never writes anywhere. The "Back up Purgatory" tool rewrites this file
// and "Restore Purgatory from the backup" writes it back to Notion.
export const COVER_BASE = "{COVER_BASE}";

export const SORTER_SNAPSHOT = [
{body},
];
"""


def parse(text: str) -> list[list]:
    if _START not in text:
        raise ValueError("That isn't a Purgatory backup file")
    body = text.split(_START, 1)[1].rsplit("];", 1)[0].strip().rstrip(",")
    return json.loads("[" + body + "]")


def read() -> list[list]:
    if not SNAPSHOT.exists():
        raise ValueError("The backup file isn't here. Run this from the local copy of the project, not from the deployed site")
    return parse(SNAPSHOT.read_text(encoding="utf-8"))


def write(rows: list[list]) -> None:
    SNAPSHOT.write_text(render(rows), encoding="utf-8", newline="\n")


def _key(row: list) -> tuple:
    return (row[1], row[2])


def compare(old: list[list], new: list[list]) -> dict:
    """What changed between two backups: albums added, removed, with another rank, and how many ranks are shared."""
    before = {_key(r): r[0] for r in old}
    after = {_key(r): r[0] for r in new}
    return {
        "added": sorted(set(after) - set(before)),
        "removed": sorted(set(before) - set(after)),
        "moved": sorted((k, before[k], after[k]) for k in before.keys() & after.keys() if before[k] != after[k]),
        "ties": sum(1 for n in Counter(after.values()).values() if n > 1),
    }


def restore_plan(albums: list[Album], rows: list[list]) -> tuple[list[tuple[Album, str]], list[str]]:
    """The rank writes that put Notion back to the backup: ([(album, new rank text)], notes about what was skipped).

    Only albums whose rank text differs are returned. Albums that aren't in the backup are left as they are.
    """
    pages: dict[tuple, list[Album]] = {}
    for a in albums:
        pages.setdefault((a.name, a.artist), []).append(a)
    width = max([2, len(str(max((r[0] for r in rows), default=0))), *(len(a.rank_text or "") for a in albums)])
    changes: list[tuple[Album, str]] = []
    notes: list[str] = []
    for row in rows:
        found = pages.get(_key(row), [])
        if len(found) != 1:
            notes.append(f"skipped '{row[1]}' by {row[2]}: " + ("not in the library any more" if not found else "several pages share that title and artist"))
            continue
        text = f"{row[0]:0{width}d}"
        if found[0].rank_text != text:
            changes.append((found[0], text))
    backed_up = {_key(r) for r in rows}
    newer = [a for a in albums if a.rank is not None and (a.name, a.artist) not in backed_up]
    if newer:
        notes.append(f"{len(newer)} ranked album(s) aren't in the backup and keep their rank: " + ", ".join(a.name for a in newer[:5]) + ("…" if len(newer) > 5 else ""))
    return changes, notes
