"""Push: write changes back to Notion. Dry run by default."""

import time
from dataclasses import dataclass
from typing import Optional

from ..runtime import Log, with_retry
from .models import Album

PAUSE = 0.35  # Notion allows ~3 requests/second
DRY_RUN_LINES = 10


@dataclass
class Change:
    page_id: str
    label: str  # for logs, e.g. "'Blue' by Joni Mitchell"
    rank: Optional[str] = None  # new zero-padded "Alex Top"
    title: Optional[str] = None  # new "Album" name
    cover: Optional[str] = None
    icon: Optional[str] = None
    status: Optional[str] = None  # new "Status", e.g. In progress -> Listened once it is ranked

    @classmethod
    def of(cls, album: Album, **fields) -> "Change":
        return cls(album.page_id, f"'{album.name}' by {album.artist}", **fields)

    @property
    def fields(self) -> list[str]:
        return [k for k in ("rank", "title", "status", "cover", "icon") if getattr(self, k)]

    def payload(self) -> dict:
        payload: dict = {}
        properties: dict = {}
        if self.rank:
            properties["Alex Top"] = {"select": {"name": self.rank}}
        if self.status:
            properties["Status"] = {"status": {"name": self.status}}
        if self.title:
            properties["Album"] = {"title": [{"type": "text", "text": {"content": self.title}}]}
        if properties:
            payload["properties"] = properties
        if self.cover:
            payload["cover"] = {"type": "external", "external": {"url": self.cover}}
        if self.icon:
            payload["icon"] = {"type": "external", "external": {"url": self.icon}}
        return payload


def push(notion, change: Change) -> None:
    """Write one change (raises if Notion refuses)."""
    with_retry(lambda: notion.pages.update(change.page_id, **change.payload()))


def apply_changes(notion, changes: list[Change], log: Log, dry_run: bool = True) -> tuple[int, int]:
    """Write each change to its page. Returns (written, failed); a dry run writes nothing."""
    written = failed = 0
    for i, change in enumerate(changes):
        if dry_run:
            if i < DRY_RUN_LINES:
                log(f"  would set {', '.join(change.fields)} on {change.label}")
            elif i == DRY_RUN_LINES:
                log(f"  ...and {len(changes) - DRY_RUN_LINES} more")
            continue
        try:
            push(notion, change)
            written += 1
        except Exception as e:  # keep going: one bad page shouldn't stop the rest
            failed += 1
            log(f"  failed to update {change.label}: {e}")
        time.sleep(PAUSE)
    if not dry_run:
        log(f"Updated {written} pages in Notion ({failed} failed)")
    return written, failed
