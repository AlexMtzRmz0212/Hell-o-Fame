from collections import Counter

from ..library.covers import is_spotify_image
from ..library.sink import Change, apply_changes
from ..library.source import NEEDS, fetch_albums, notion_client

META = {
    "id": "album_icons",
    "category": "Library",
    "order": 40,
    "title": "Album covers as page icons",
    "description": (
        "Gives every album page that has a Spotify cover and no icon yet (or only Notion's default album icon) "
        "that cover as its Notion icon. Icons someone set by hand are kept unless you tick the second option."
    ),
    "needs": NEEDS,
    "writes": True,
    "params": [
        {"name": "dry_run", "label": "Dry run (list what would change, don't write to Notion)", "type": "bool", "default": True},
        {
            "name": "replace_chosen",
            "label": "Also replace icons set by hand (emoji, uploaded images, other Notion icons)",
            "type": "bool",
            "default": False,
        },
    ],
}

NOT_CHOSEN = {None, "placeholder"}  # no icon, or the one Notion gives every new page
CHOSEN = {"emoji", "upload", "native"}  # set by hand. An image link ("external") is already a picture: left alone


def run(params, log):
    albums = fetch_albums()
    replaceable = NOT_CHOSEN | (CHOSEN if params.get("replace_chosen") else set())
    # Only Spotify's CDN links last. A cover uploaded to Notion is a signed link that expires within the hour.
    todo = [a for a in albums if a.icon_kind in replaceable and not a.is_untitled and is_spotify_image(a.cover)]
    by_kind = Counter(a.icon_kind or "none" for a in todo)
    detail = ", ".join(f"{n} with {kind}" for kind, n in sorted(by_kind.items()))
    log(f"{len(albums)} pages: {len(todo)} get their cover as the icon" + (f" ({detail})" if todo else "") + ", the rest are untouched")
    changes = [Change.of(a, icon=a.cover) for a in todo]
    written, failed = apply_changes(notion_client(), changes, log, dry_run=params["dry_run"])
    rows = [{"album": a.name, "artist": a.artist, "was": a.icon_kind or "none", "icon": a.cover} for a in todo[:25]]
    return {"would_write": len(todo) if params["dry_run"] else 0, "written": written, "failed": failed, "rows": rows}
