from ..library import backup, showcase
from ..library.sink import Change, apply_changes
from ..library.source import NEEDS, fetch_albums, notion_client

META = {
    "id": "purgatory_restore",
    "category": "Library",
    "order": 42,
    "title": "Restore Purgatory from the backup",
    "description": (
        "Writes the ranks saved in the backup file back to Notion, ties and gaps included, for when the ranking got "
        "damaged. Albums that aren't in the backup keep their rank. Dry run first to see what would change."
    ),
    "needs": NEEDS,
    "writes": True,
    "params": [
        {"name": "dry_run", "label": "Dry run (list what would change, don't write to Notion)", "type": "bool", "default": True},
    ],
}


def run(params, log):
    rows = backup.read()
    changes, notes = backup.restore_plan(fetch_albums(), rows)
    for note in notes:
        log(note)
    log(f"The backup has {len(rows)} ranked albums: {len(changes)} would get another rank in Notion")
    written, failed = apply_changes(notion_client(), [Change.of(a, rank=text) for a, text in changes], log, dry_run=params["dry_run"])
    if written:
        showcase.clear_cache()
    table = [{"album": a.name, "artist": a.artist, "notion now": a.rank_text, "backup": text} for a, text in changes[:25]]
    return {"would_write": len(changes) if params["dry_run"] else 0, "written": written, "failed": failed, "rows": table}
