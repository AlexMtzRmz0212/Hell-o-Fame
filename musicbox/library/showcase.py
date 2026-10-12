"""The public, read-only view of the album library."""

from datetime import datetime, timezone

from .cache import TTLCache
from .source import fetch_albums

# Covers uploaded to Notion are signed links that expire after an hour. Server (20 min) +
# CDN (15 min, see backend/showcase.py) + browser (5 min) must add up to less than that.
CACHE_SECONDS = 20 * 60

_cache: TTLCache[dict] = TTLCache(CACHE_SECONDS)


def _load() -> dict:
    albums = fetch_albums()
    return {
        "albums": [a.to_public() for a in albums],
        "updated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }


def get_showcase() -> dict:
    return _cache.get(_load)


def refresh_showcase() -> dict:
    """Read the library from Notion now (instead of waiting for the cache to run out). Raises if Notion can't be read."""
    return _cache.refresh(_load)


def clear_cache() -> None:
    _cache.clear()
