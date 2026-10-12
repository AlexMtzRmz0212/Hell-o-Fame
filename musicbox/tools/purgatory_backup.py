from ..library import backup
from ..library.source import NEEDS, fetch_albums

META = {
    "id": "purgatory_backup",
    "category": "Library",
    "order": 41,
    "title": "Back up Purgatory",
    "description": (
        "Saves every ranked album's rank (ties included) into the backup file the public page plays on. "
        "It only writes that file on this computer, never Notion. Deploy the project afterwards to update the public page."
    ),
    "needs": NEEDS,
    "writes": False,
    "params": [],
}

MIN_SHARE = 0.5  # a read with less than half of the backed-up albums is a Notion hiccup, not a ranking


def run(params, log):
    old = backup.read() if backup.SNAPSHOT.exists() else []
    new = backup.rows_from(fetch_albums())
    if old and len(new) < len(old) * MIN_SHARE:
        raise ValueError(f"Notion has only {len(new)} ranked albums and the backup has {len(old)}: not overwriting the backup")
    diff = backup.compare(old, new)
    log(f"Notion has {len(new)} ranked albums ({diff['ties']} ranks shared by several); the backup had {len(old)}")
    log(f"{len(diff['added'])} added, {len(diff['removed'])} removed, {len(diff['moved'])} with another rank")
    backup.write(new)
    log(f"Saved {backup.SNAPSHOT.name}. Commit and deploy it to update the public page.")
    rows = [{"album": k[0], "artist": k[1], "was": was, "now": now} for k, was, now in diff["moved"][:25]]
    rows += [{"album": k[0], "artist": k[1], "was": "", "now": "new"} for k in diff["added"][:10]]
    return {"albums": len(new), "ties": diff["ties"], "changed": len(diff["moved"]) + len(diff["added"]) + len(diff["removed"]), "rows": rows}
