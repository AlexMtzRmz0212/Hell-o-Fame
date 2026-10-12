import pytest
from fastapi.testclient import TestClient

from backend.main import app
from musicbox.library import showcase
from musicbox.library.cache import TTLCache
from musicbox.library.models import Album
from musicbox.library.covers import compare, cover_source, find_issues, is_spotify_image, library_view, placeholder_path, suggest
from musicbox.library.sink import Change, apply_changes
from musicbox.library.source import page_to_album
from musicbox.library import backup
from musicbox.library.transform import pick_images, place_album, rank_listened

client = TestClient(app)


def _page(**over):
    props = {
        "Album": {"title": [{"plain_text": "Blue"}]},
        "Artist": {"select": {"name": "Joni Mitchell"}},
        "Genre": {"multi_select": [{"name": "Folk"}, {"name": "Singer-songwriter"}]},
        "Release Date": {"date": {"start": "1971-06-22"}},
        "Decade": {"formula": {"type": "string", "string": "1970s"}},
        "Alex Top": {"select": {"name": "07"}},
        "Status": {"status": {"name": "Listened"}},
        "Alex Listening": {"date": {"start": "2026-08-26"}},  # old column: must be ignored
        "Album of the Day": {"date": {"start": "2026-08-27"}},
        "Carlos' Top": {"select": {"name": "99"}},
    }
    page = {"id": "p1", "properties": props,
            "cover": {"type": "external", "external": {"url": "https://i.scdn.co/cover"}},
            "icon": {"type": "emoji", "emoji": "💿"}}
    page.update(over)
    return page


def test_page_to_album_maps_every_field():
    a = page_to_album(_page())
    assert (a.name, a.artist, a.genres) == ("Blue", "Joni Mitchell", ["Folk", "Singer-songwriter"])
    assert (a.release_date, a.decade, a.rank, a.rank_text) == ("1971-06-22", "1970s", 7, "07")
    assert (a.status, a.album_of_day) == ("Listened", "2026-08-27")
    assert "2026-08-26" not in str(a)  # "Alex Listening" is no longer read
    assert a.cover == "https://i.scdn.co/cover" and a.has_icon  # emoji icon still counts as an icon


def test_page_to_album_survives_empty_pages():
    a = page_to_album({"id": "p2", "properties": {}, "cover": None, "icon": None})
    assert (a.name, a.artist, a.status, a.rank, a.cover, a.has_icon) == ("Untitled", "Unknown", "Unknown", None, None, False)


def test_only_notions_default_album_icon_counts_as_a_placeholder():
    native = lambda name: {"type": "icon", "icon": {"name": name, "color": "gray"}}
    assert page_to_album(_page(icon=native("music-album"))).placeholder_icon
    assert not page_to_album(_page(icon=native("heart"))).placeholder_icon
    assert not page_to_album(_page()).placeholder_icon  # an emoji was chosen by hand
    assert not page_to_album(_page(icon={"type": "file", "file": {"url": "https://s3/x.png"}})).placeholder_icon
    assert not page_to_album(_page(icon=None)).placeholder_icon


def test_album_icons_tool_replaces_placeholders_but_never_a_chosen_icon(monkeypatch):
    from musicbox.tools import album_icons

    spotify = "https://i.scdn.co/image/c"
    albums = [
        Album(page_id="none", name="A", cover=spotify),
        Album(page_id="default", name="B", cover=spotify, has_icon=True, icon_kind="placeholder"),
        Album(page_id="chosen", name="C", cover=spotify, has_icon=True, icon_kind="emoji"),
        Album(page_id="photo", name="F", cover=spotify, has_icon=True, icon_kind="upload"),
        Album(page_id="link", name="G", cover=spotify, has_icon=True, icon_kind="external"),
        Album(page_id="nocover", name="D"),
        Album(page_id="uploaded", name="E", cover="https://prod-files-secure.s3.us-west-2.amazonaws.com/x.png"),
        Album(page_id="empty", name="Untitled", cover=spotify),
    ]
    notion = FakeNotion()
    monkeypatch.setattr("musicbox.library.sink.PAUSE", 0)
    monkeypatch.setattr(album_icons, "fetch_albums", lambda: albums)
    monkeypatch.setattr(album_icons, "notion_client", lambda: notion)

    dry = album_icons.run({"dry_run": True}, lambda m: None)
    assert dry["would_write"] == 2 and notion.updates == []
    done = album_icons.run({"dry_run": False}, lambda m: None)
    assert (done["written"], done["failed"]) == (2, 0)
    assert [(p, u["icon"]["external"]["url"]) for p, u in notion.updates] == [("none", spotify), ("default", spotify)]

    notion.updates.clear()  # the extra option also replaces icons set by hand, but never an image link
    more = album_icons.run({"dry_run": False, "replace_chosen": True}, lambda m: None)
    assert more["written"] == 4 and [p for p, _ in notion.updates] == ["none", "default", "chosen", "photo"]


def test_notion_hosted_cover_is_read():
    a = page_to_album(_page(cover={"type": "file", "file": {"url": "https://s3/x.png"}}))
    assert a.cover == "https://s3/x.png"


def test_stock_notion_photo_is_not_album_art():
    stock = page_to_album(_page(cover={"type": "external", "external": {"url": "https://images.unsplash.com/photo-1?q=85"}}))
    assert stock.cover and not stock.has_art  # still recorded, but never counted or shown as art
    assert stock.to_public()["cover"] is None
    assert page_to_album(_page()).has_art
    assert not page_to_album(_page(cover=None)).has_art


def test_public_view_has_no_private_fields():
    public = page_to_album(_page()).to_public()
    assert set(public) == {"id", "name", "artist", "genres", "release_date", "decade", "rank",
                           "status", "album_of_day", "cover"}
    assert "99" not in str(public)


def _album(name, rank, status="Listened"):
    return Album(page_id=name, name=name, rank=rank, status=status)


def test_rank_listened_is_unique_padded_and_skips_unlistened_and_unranked():
    ranked = rank_listened([_album("a", 1), _album("b", 1), _album("c", None), _album("d", 5, "Not listened")])
    assert [(a.name, r) for a, r in ranked] == [("a", "01"), ("b", "02")]


def test_rank_listened_orders_ties_by_the_playoff_and_bumps_the_rest():
    albums = [_album("a", 5), _album("b", 5), _album("c", 5), _album("d", 6), _album("e", 9), _album("top", 1)]
    ranked = rank_listened(albums, tiebreak=["c", "a"])  # b wasn't decided: after the decided ones
    assert [(a.name, r) for a, r in ranked] == [
        ("top", "01"), ("c", "05"), ("a", "06"), ("b", "07"), ("d", "08"), ("e", "09")]


def test_rank_listened_compact_and_widths():
    ranked = rank_listened([_album("a", 10), _album("b", 40)], compact=True)
    assert [r for _, r in ranked] == ["01", "02"]
    big = rank_listened([_album(str(i), i) for i in range(1, 101)])
    assert big[0][1] == "001" and big[-1][1] == "100"


def _stored(name, rank, status="Listened"):
    """An album the way Notion has it: the rank is stored as zero-padded text."""
    album = _album(name, rank, status)
    album.rank_text = f"{rank:03d}" if rank else None
    return album


def _placed(albums, page_id, rank):
    return [(a.name, text) for a, text in place_album(albums, page_id, rank)]


def test_place_album_moves_down_only_what_is_in_its_way_and_keeps_ties_and_gaps():
    # 2 is shared by b and c, 4 is free: placing at 2 pushes 2, 2 and 3 down one place; 5 and everything after stay put
    albums = [_stored("a", 1), _stored("b", 2), _stored("c", 2), _stored("d", 3), _stored("e", 5), _stored("f", 6), _stored("new", None)]
    assert _placed(albums, "new", 2) == [("new", "002"), ("b", "003"), ("c", "003"), ("d", "004")]


def test_place_album_into_a_gap_changes_nothing_else():
    albums = [_stored("a", 1), _stored("b", 2), _stored("c", 5), _stored("new", None)]
    assert _placed(albums, "new", 3) == [("new", "003")]
    assert _placed(albums, "new", 4) == [("new", "004")]


def test_place_album_first_last_and_out_of_range():
    albums = [_stored("a", 1), _stored("b", 2), _stored("c", 5), _stored("new", None)]
    assert _placed(albums, "new", 1) == [("new", "001"), ("a", "002"), ("b", "003")]
    assert _placed(albums, "new", 99) == [("new", "006")]  # after the last rank
    assert _placed(albums, "new", 0) == _placed(albums, "new", 1)


def test_place_album_keeps_the_stored_width_and_ignores_unranked_and_unlistened_albums():
    albums = [_stored("a", 1), _stored("b", 2), _stored("skip", None), _stored("later", 2, "Not listened"), _stored("new", None)]
    assert _placed(albums, "new", 2) == [("new", "002"), ("b", "003")]
    two = [_album("a", 1), _album("new", None)]
    two[0].rank_text = "01"
    assert _placed(two, "new", 1) == [("new", "01"), ("a", "02")]


def test_an_album_in_progress_can_be_ranked_and_takes_part_in_the_ranking():
    albums = [_stored("a", 1), _stored("b", 2, "In progress"), _stored("new", None, "In progress")]
    assert _placed(albums, "new", 2) == [("new", "002"), ("b", "003")]
    assert [a.name for a, _ in rank_listened(albums)] == ["a", "b"]  # "new" has no rank yet


def test_place_album_can_move_a_ranked_one_and_rejects_bad_requests():
    albums = [_stored("a", 1), _stored("b", 2), _stored("c", 3)]
    assert _placed(albums, "c", 1) == [("c", "001"), ("a", "002"), ("b", "003")]
    assert _placed(albums, "a", 1) == []  # already there
    with pytest.raises(ValueError):
        place_album(albums, "nope", 1)
    with pytest.raises(ValueError):
        place_album([_stored("a", 1), _stored("u", None, "Not listened")], "u", 1)


def test_pick_images_takes_largest_and_smallest():
    assert pick_images({"images": [{"url": "big"}, {"url": "mid"}, {"url": "small"}]}) == ("big", "small")
    assert pick_images({}) == (None, None)


class FakeNotion:
    def __init__(self, fail_on=None):
        self.updates, self.fail_on = [], fail_on
        self.pages = self

    def update(self, page_id, **payload):
        if page_id == self.fail_on:
            raise RuntimeError("boom")
        self.updates.append((page_id, payload))


def test_apply_changes_dry_run_writes_nothing():
    notion, lines = FakeNotion(), []
    changes = [Change.of(_album("a", None), rank="01")]
    assert apply_changes(notion, changes, lines.append, dry_run=True) == (0, 0)
    assert notion.updates == [] and "would set rank" in lines[0]


def test_apply_changes_writes_and_keeps_going_after_a_failure(monkeypatch):
    monkeypatch.setattr("musicbox.library.sink.PAUSE", 0)
    notion = FakeNotion(fail_on="bad")
    changes = [Change.of(_album("bad", None), rank="01"), Change.of(_album("ok", None), rank="02", cover="c", icon="i")]
    assert apply_changes(notion, changes, lambda m: None, dry_run=False) == (1, 1)
    page_id, payload = notion.updates[0]
    assert page_id == "ok"
    assert payload["properties"] == {"Alex Top": {"select": {"name": "02"}}}
    assert payload["cover"]["external"]["url"] == "c" and payload["icon"]["external"]["url"] == "i"


def test_ttl_cache_serves_stale_when_refresh_fails():
    cache, calls = TTLCache(ttl=0), []

    def load():
        calls.append(1)
        if len(calls) > 1:
            raise RuntimeError("notion down")
        return "v1"

    assert cache.get(load) == "v1"
    assert cache.get(load) == "v1" and len(calls) == 2  # ttl=0 forces a refresh; it failed, stale served


def test_ttl_cache_raises_when_nothing_cached():
    with pytest.raises(RuntimeError):
        TTLCache(ttl=60).get(lambda: (_ for _ in ()).throw(RuntimeError("x")))


# --- public route ---

def _configure(monkeypatch):
    monkeypatch.setenv("NOTION_ALBUMS_SECRET", "secret-token")
    monkeypatch.setenv("ALBUMS_LIBRARY_DB_ID", "db")
    showcase.clear_cache()


def test_showcase_is_public_even_when_owner_password_is_set(monkeypatch):
    _configure(monkeypatch)
    monkeypatch.setenv("OWNER_PASSWORD", "secret")
    monkeypatch.setattr("musicbox.library.showcase.fetch_albums", lambda: [page_to_album(_page())])
    res = client.get("/api/showcase/albums")  # no login cookie
    assert res.status_code == 200
    assert res.json()["albums"][0]["name"] == "Blue" and "updated_at" in res.json()
    assert "s-maxage" in res.headers["cache-control"]


def test_showcase_is_cached(monkeypatch):
    _configure(monkeypatch)
    calls = []
    monkeypatch.setattr("musicbox.library.showcase.fetch_albums", lambda: calls.append(1) or [])
    client.get("/api/showcase/albums")
    client.get("/api/showcase/albums")
    assert len(calls) == 1


def test_showcase_unconfigured_is_503(monkeypatch):
    monkeypatch.setattr("musicbox.config.get", lambda name, default="": "")
    showcase.clear_cache()
    assert client.get("/api/showcase/albums").status_code == 503


def test_showcase_hides_notion_errors(monkeypatch):
    _configure(monkeypatch)

    def boom():
        raise RuntimeError("Authorization: secret-token")

    monkeypatch.setattr("musicbox.library.showcase.fetch_albums", boom)
    res = client.get("/api/showcase/albums")
    assert res.status_code == 502 and "secret-token" not in res.text


# --- cover review ---

def _cover_album(name, cover, artist="x"):
    return Album(page_id=name, name=name, artist=artist, cover=cover)


def test_find_issues_flags_missing_stock_and_duplicate_covers():
    albums = [
        _cover_album("ok", "https://i.scdn.co/ok"),
        _cover_album("none", None),
        _cover_album("stock", "https://images.unsplash.com/photo-1"),
        _cover_album("dup1", "https://i.scdn.co/same", "a"),
        _cover_album("dup2", "https://i.scdn.co/same", "b"),
        _cover_album("Untitled", None),  # placeholder pages are never reviewed
    ]
    issues = {i.album.name: i for i in find_issues(albums)}
    assert set(issues) == {"none", "stock", "dup1", "dup2"}
    assert [issues[n].reason for n in ("none", "stock", "dup1")] == ["none", "stock", "duplicate"]
    assert issues["dup1"].shared_with == ["dup2 (b)"]


def test_only_spotify_images_may_be_written():
    assert is_spotify_image("https://i.scdn.co/image/abc")
    assert not is_spotify_image("https://evil.example/scdn.co")
    assert not is_spotify_image("https://notscdn.co/x") and not is_spotify_image(None)




def _configure_owner(monkeypatch):
    monkeypatch.setenv("NOTION_ALBUMS_SECRET", "t")
    monkeypatch.setenv("ALBUMS_LIBRARY_DB_ID", "db")
    monkeypatch.setenv("SPOTIFY_CLIENT_ID", "i")
    monkeypatch.setenv("SPOTIFY_CLIENT_SECRET", "s")
    monkeypatch.setenv("OWNER_PASSWORD", "secret")


def test_cover_routes_need_login(monkeypatch):
    _configure_owner(monkeypatch)
    anonymous = TestClient(app)  # the shared client may already hold a login cookie from another test
    assert anonymous.get("/api/covers/queue").status_code == 401
    assert anonymous.post("/api/covers/suggest", json={"name": "x"}).status_code == 401
    assert anonymous.post("/api/covers/apply", json={"id": "p", "cover": "https://i.scdn.co/x"}).status_code == 401


def test_cover_queue_suggest_and_apply(monkeypatch):
    _configure_owner(monkeypatch)
    monkeypatch.setattr("backend.covers.fetch_albums", lambda: [_cover_album("none", None), _cover_album("ok", "https://i.scdn.co/ok")])
    pushed = []
    monkeypatch.setattr("backend.covers.notion_client", lambda: object())
    monkeypatch.setattr("backend.covers.push", lambda notion, change: pushed.append(change))
    monkeypatch.setattr("backend.covers.suggest", lambda name, artist, current=None: {"cover": "https://i.scdn.co/new", "name": name, "artist": artist, "exact": True})
    assert client.post("/api/auth/login", json={"password": "secret"}).status_code == 204

    issues = client.get("/api/covers/queue").json()["issues"]
    assert [i["name"] for i in issues] == ["none"]
    assert client.post("/api/covers/suggest", json={"name": "none", "artist": "x"}).json()["match"]["cover"].endswith("/new")

    bad = client.post("/api/covers/apply", json={"id": "none", "cover": "https://evil.example/c.png"})
    assert bad.status_code == 400 and pushed == []
    ok = client.post("/api/covers/apply", json={"id": "none", "cover": "https://i.scdn.co/new", "icon": "https://i.scdn.co/ic"})
    assert ok.status_code == 200 and pushed[0].page_id == "none" and pushed[0].cover.endswith("/new")


def _m(name, artist):
    return {"name": name, "artist": artist}






def test_cover_source_and_library_view():
    assert [cover_source(u) for u in (None, "https://images.unsplash.com/a", "https://i.scdn.co/a",
                                      "https://prod-files-secure.s3.us-west-2.amazonaws.com/a", "https://example.com/a")] ==         ["none", "stock", "spotify", "upload", "other"]
    view = library_view([_cover_album("A", "https://i.scdn.co/a"), _cover_album("Untitled", None)])
    assert [v["name"] for v in view] == ["A"] and view[0]["source"] == "spotify"


def test_title_change_payload():
    change = Change("p", "p", title="Fuzzybrain", cover="c")
    assert change.payload()["properties"] == {"Album": {"title": [{"type": "text", "text": {"content": "Fuzzybrain"}}]}}
    assert change.payload()["cover"]["external"]["url"] == "c"
    both = Change("p", "p", rank="01", title="T").payload()["properties"]
    assert set(both) == {"Alex Top", "Album"}


def test_apply_accepts_title_only_and_rejects_empty(monkeypatch):
    _configure_owner(monkeypatch)
    pushed = []
    monkeypatch.setattr("backend.covers.notion_client", lambda: object())
    monkeypatch.setattr("backend.covers.push", lambda notion, change: pushed.append(change))
    client.post("/api/auth/login", json={"password": "secret"})
    assert client.post("/api/covers/apply", json={"id": "p"}).status_code == 400
    assert client.post("/api/covers/apply", json={"id": "p", "title": "   "}).status_code == 400
    ok = client.post("/api/covers/apply", json={"id": "p", "title": " Fuzzybrain "})
    assert ok.status_code == 200 and pushed[0].title == "Fuzzybrain" and pushed[0].cover is None



# --- matching rules (none of them specific to an album) ---

def _sp(id, name, artist, date="2020-01-01", kind="album", img="x"):
    return {"id": id, "name": name, "artists": [{"name": a} for a in artist.split(", ")], "release_date": date,
            "album_type": kind, "images": [{"url": f"https://i.scdn.co/image/{img}-640"}, {"url": f"https://i.scdn.co/image/{img}-64"}],
            "external_urls": {"spotify": f"https://open.spotify.com/album/{id}"}}


def _search(monkeypatch, results):
    monkeypatch.setattr("musicbox.library.covers.spotify.search", lambda q, kind, limit: results)


def test_the_artist_must_be_exactly_ours(monkeypatch):
    # a covers album "by" an artist whose name merely contains ours is not the artist's album
    _search(monkeypatch, [_sp("1", "Harry's House", "Harry Styles - Piano Covers"), _sp("2", "Harry's House", "Harry Styles", "2022-05-20")])
    assert suggest("Harry's House", "Harry Styles")["artist"] == "Harry Styles"
    _search(monkeypatch, [_sp("1", "Harry's House", "Harry Styles - Piano Covers")])
    assert suggest("Harry's House", "Harry Styles") is None


def test_an_unrelated_title_by_the_same_artist_is_no_match(monkeypatch):
    _search(monkeypatch, [_sp("1", "Trench", "Twenty One Pilots"), _sp("2", "Blurryface", "Twenty One Pilots")])
    assert suggest("Regional at Best", "Twenty One Pilots") is None


def test_the_standard_edition_beats_deluxe_even_when_ranked_lower(monkeypatch):
    _search(monkeypatch, [
        _sp("deluxe", "Slippery When Wet (Deluxe Edition)", "Bon Jovi", "2010-01-01", img="d"),
        _sp("standard", "Slippery When Wet", "Bon Jovi", "1986-08-16", img="s"),
        _sp("remaster", "Slippery When Wet (Remastered)", "Bon Jovi", "2014-01-01", img="r"),
    ])
    match = suggest("Slippery When Wet", "Bon Jovi")
    assert match["name"] == "Slippery When Wet" and match["exact"] and match["cover"].endswith("s-640")


def test_an_edition_in_our_own_title_is_respected(monkeypatch):
    _search(monkeypatch, [_sp("a", "4", "Foreigner", "1981-07-02"), _sp("b", "4 (Expanded)", "Foreigner", "2002-01-01")])
    assert suggest("4 (Expanded)", "Foreigner")["name"] == "4 (Expanded)"


def test_the_exact_title_beats_a_higher_ranked_other_album(monkeypatch):
    _search(monkeypatch, [_sp("fool", "Elvis (Fool)", "Elvis Presley", "1973-01-01"), _sp("first", "Elvis Presley", "Elvis Presley", "1956-03-23")])
    assert suggest("Elvis Presley", "Elvis Presley")["release_date"] == "1956-03-23"


def test_a_plain_album_beats_a_compilation_and_the_original_beats_the_reissue(monkeypatch):
    _search(monkeypatch, [_sp("c", "Rumours", "Fleetwood Mac", "1977-02-04", kind="compilation"),
                          _sp("re", "Rumours", "Fleetwood Mac", "2004-01-01"), _sp("o", "Rumours", "Fleetwood Mac", "1977-02-04")])
    assert suggest("Rumours", "Fleetwood Mac")["url"].endswith("/o")


def test_a_near_miss_title_is_a_rename_proposal_and_exact_is_not(monkeypatch):
    _search(monkeypatch, [_sp("1", "Fuzzybrain", "Dayglow")])
    match = suggest("Fuzzbrain", "Dayglow")
    assert match["exact"] is False and compare(match) == {"artist_match": True, "new_title": "Fuzzybrain"}
    _search(monkeypatch, [_sp("1", "Hozier (Expanded Edition)", "Hozier")])
    match = suggest("Hozier", "Hozier")
    assert match["exact"] is True and compare(match)["new_title"] is None  # an edition suffix isn't a rename
    assert compare(None) == {"artist_match": False, "new_title": None}


def test_suggest_says_which_release_the_current_cover_belongs_to(monkeypatch):
    _search(monkeypatch, [_sp("covers", "Harry's House (Piano Covers)", "Harry Styles", img="piano"),
                          _sp("real", "Harry's House", "Harry Styles", "2022-05-20", img="real")])
    match = suggest("Harry's House", "Harry Styles", current="https://i.scdn.co/image/piano-640")
    assert match["name"] == "Harry's House" and match["current_release"] == "Harry's House (Piano Covers)"
    assert suggest("Harry's House", "Harry Styles", current="https://example.com/mine.png")["current_release"] is None


def test_pictures_and_cover_ids_ignore_notion_signatures():
    up = lambda sig: f"https://prod-files-secure.s3.us-west-2.amazonaws.com/ws/file/banner.png?X-Amz-Signature={sig}"
    albums = [Album(page_id=f"o{i}", name="Untitled", cover=up(i)) for i in range(3)]
    assert placeholder_path(albums).endswith("/ws/file/banner.png")
    assert placeholder_path(albums[:2]) is None  # two pages don't make a convention
    assert cover_source(up("zzz"), placeholder_path(albums)) == "placeholder"


def test_find_issues_flags_the_no_album_yet_placeholder_on_a_titled_album_only():
    up = lambda sig: f"https://prod-files-secure.s3.us-west-2.amazonaws.com/ws/file/banner.png?X-Amz-Signature={sig}"
    albums = [Album(page_id=f"o{i}", name="Untitled", artist=f"a{i}", cover=up(i)) for i in range(3)]
    albums.append(Album(page_id="t", name="Harry Styles", artist="Harry Styles", cover=up("t")))
    issues = find_issues(albums)
    assert [(i.album.name, i.reason) for i in issues] == [("Harry Styles", "placeholder")]


def test_only_edition_labels_are_ignored_other_releases_are_different_albums(monkeypatch):
    # "(Taylor's Version)" and remixes/live sets are different releases, not editions of "Red" / "Settle"
    _search(monkeypatch, [_sp("tv", "Red (Taylor's Version)", "Taylor Swift", "2021-11-12"), _sp("red", "Red", "Taylor Swift", "2012-10-22")])
    assert suggest("Red", "Taylor Swift")["name"] == "Red"
    assert suggest("Red (Taylor’s Version)", "Taylor Swift")["name"] == "Red (Taylor's Version)"  # curly vs straight apostrophe
    _search(monkeypatch, [_sp("r", "Settle (The Remixes)", "Disclosure"), _sp("l", "Hotel California (Live From The Forum)", "Disclosure")])
    assert suggest("Settle", "Disclosure") is None and suggest("Hotel California", "Disclosure") is None


def test_the_same_release_listed_twice_is_not_a_cover_correction(monkeypatch):
    _search(monkeypatch, [_sp("a", "The Heist", "Macklemore", img="one"), _sp("b", "The Heist", "Macklemore", "2012-10-09", img="two")])
    same = suggest("The Heist", "Macklemore", current="https://i.scdn.co/image/two-640")
    assert same["cover_ok"] is True and same["current_release"] == "The Heist"
    other = suggest("The Heist", "Macklemore", current="https://example.com/mine.png")
    assert other["cover_ok"] is False


def test_every_edition_is_offered_standard_first_and_yours_is_marked(monkeypatch):
    _search(monkeypatch, [
        _sp("dlx", "Waking Up (Deluxe)", "OneRepublic", "2009-01-01", img="dlx"),
        _sp("std", "Waking Up", "OneRepublic", "2009-01-01", img="std"),
        _sp("exp", "Waking Up (Expanded Edition)", "OneRepublic", "2010-01-01", img="exp"),
        _sp("rmx", "Waking Up (The Remixes)", "OneRepublic", "2010-01-01", img="rmx"),  # another release, not an edition
    ])
    match = suggest("Waking Up", "OneRepublic", current="https://i.scdn.co/image/exp-640")
    assert [o["name"] for o in match["options"]] == ["Waking Up", "Waking Up (Deluxe)", "Waking Up (Expanded Edition)"]
    assert match["name"] == "Waking Up" and match["cover"].endswith("std-640")  # the default is the standard release
    assert [o["is_current"] for o in match["options"]] == [False, False, True]
    assert match["cover_ok"] is True  # the cover already is one of the editions: your choice, not an error


def test_a_cover_that_is_no_edition_of_the_album_is_not_ok_and_offers_every_edition(monkeypatch):
    _search(monkeypatch, [_sp("std", "Waking Up", "OneRepublic", img="std"), _sp("dlx", "Waking Up (Deluxe)", "OneRepublic", img="dlx")])
    match = suggest("Waking Up", "OneRepublic", current="https://example.com/mine.png")
    assert match["cover_ok"] is False and len(match["options"]) == 2
    assert not any(o["is_current"] for o in match["options"])


def test_a_release_listed_twice_is_one_option_and_options_are_capped(monkeypatch):
    twice = [_sp("a", "The Heist", "Macklemore", "2012-10-09", img="one"), _sp("b", "The Heist", "Macklemore", "2012-10-09", img="two")]
    for item in twice:
        item["total_tracks"] = 15
    _search(monkeypatch, twice)
    match = suggest("The Heist", "Macklemore", current="https://i.scdn.co/image/two-640")
    assert len(match["options"]) == 1 and match["cover_ok"] is True
    many = [_sp(str(n), f"Album (Edition {n})", "Band", f"20{10 + n}-01-01", img=f"i{n}") for n in range(9)]
    _search(monkeypatch, many)
    assert len(suggest("Album", "Band")["options"]) == 6


def test_a_near_miss_title_only_offers_near_misses(monkeypatch):
    _search(monkeypatch, [_sp("1", "Fuzzybrain", "Dayglow"), _sp("2", "Fuzzybrain (Deluxe)", "Dayglow", img="d")])
    match = suggest("Fuzzbrain", "Dayglow")
    assert match["exact"] is False and all(not o["exact"] for o in match["options"])


# --- track lists for comparing editions ---

def test_album_tracks_follows_pagination(monkeypatch):
    from musicbox import spotify

    pages = [
        {"items": [{"track_number": 1, "disc_number": 1, "name": "A", "duration_ms": 61000, "explicit": False}],
         "next": "https://api.spotify.com/v1/albums/x/tracks?offset=1"},
        {"items": [{"track_number": 2, "disc_number": 1, "name": "B", "duration_ms": 120000, "explicit": True}], "next": None},
    ]
    calls = []

    class Reply:
        status_code = 200

        def __init__(self, body):
            self.body = body

        def json(self):
            return self.body

    def fake_get(url, headers=None, params=None, timeout=None):
        calls.append((url, params))
        return Reply(pages[len(calls) - 1])

    monkeypatch.setattr(spotify.requests, "get", fake_get)
    monkeypatch.setattr(spotify, "get_token", lambda: "t")
    tracks = spotify.album_tracks("x")
    assert [(t["n"], t["name"], t["seconds"], t["explicit"]) for t in tracks] == [(1, "A", 61, False), (2, "B", 120, True)]
    assert calls[0][1] == {"limit": 50} and calls[1][1] is None  # the `next` link carries its own query


def test_tracks_route_is_owner_only_and_validates_the_id(monkeypatch):
    _configure_owner(monkeypatch)
    good = "2NnilgZ9YwkKQIoKUHdJSm"
    assert TestClient(app).get(f"/api/covers/tracks/{good}").status_code == 401  # a client with no cookie
    monkeypatch.setattr("backend.covers.spotify.album_tracks", lambda album_id: [{"n": 1, "name": album_id}])
    client.post("/api/auth/login", json={"password": "secret"})
    assert client.get("/api/covers/tracks/not-an-id").status_code == 400
    assert client.get(f"/api/covers/tracks/{good}").json() == {"tracks": [{"n": 1, "name": good}]}



def test_sorter_routes_need_login(monkeypatch):
    _configure_owner(monkeypatch)
    anonymous = TestClient(app)
    assert anonymous.get("/api/sorter/albums").status_code == 401
    assert anonymous.post("/api/sorter/apply", json={"tiebreak": []}).status_code == 401
    assert anonymous.post("/api/sorter/place", json={"id": "a"}).status_code == 401


def test_sorter_place_writes_the_new_rank_and_those_it_pushes_down(monkeypatch):
    _configure_owner(monkeypatch)
    monkeypatch.setattr("musicbox.library.sink.PAUSE", 0)
    albums = [_stored("a", 1), _stored("b", 2), _stored("c", 2), _stored("d", 3), _stored("e", 5), _stored("new", None)]
    notion = FakeNotion()
    monkeypatch.setattr("backend.sorter.fetch_albums", lambda *args: albums)
    monkeypatch.setattr("backend.sorter.notion_client", lambda: notion)
    client.post("/api/auth/login", json={"password": "secret"})

    body = client.post("/api/sorter/place", json={"id": "new", "rank": 2}).json()
    assert (body["written"], body["failed"]) == (4, 0)
    assert body["ranks"] == {"new": "002", "b": "003", "c": "003", "d": "004"}  # the tie moves together; "a" and "e" stay
    assert sorted(page_id for page_id, _ in notion.updates) == ["b", "c", "d", "new"]
    assert body["listened"] == [] and all("Status" not in u.get("properties", {}) for _, u in notion.updates)
    assert client.post("/api/sorter/place", json={"id": "gone", "rank": 2}).status_code == 422
    assert client.post("/api/sorter/place", json={"id": "new", "rank": 0}).status_code == 422


def test_sorter_lists_ranked_albums_and_writes_only_changed_ranks(monkeypatch):
    _configure_owner(monkeypatch)
    monkeypatch.setattr("musicbox.library.sink.PAUSE", 0)
    albums = [_album("a", 5), _album("b", 5), _album("c", 7), _album("d", None), _album("e", 3, "Not listened"), _album("f", 9, "In progress")]
    for a in albums:
        a.rank_text = f"{a.rank:02d}" if a.rank else None
    notion = FakeNotion()
    monkeypatch.setattr("backend.sorter.fetch_albums", lambda *args: albums)
    monkeypatch.setattr("backend.sorter.notion_client", lambda: notion)
    assert client.post("/api/auth/login", json={"password": "secret"}).status_code == 204

    listed = client.get("/api/sorter/albums").json()["albums"]
    assert [a["id"] for a in listed] == ["a", "b", "c", "f"]  # "f" is in progress: it counts

    body = client.post("/api/sorter/apply", json={"tiebreak": ["b", "a"]}).json()
    assert body["written"] == 4 and body["failed"] == 0  # 05, 05, 07, 09 become 01..04: no gaps
    assert [(p, u["properties"]["Alex Top"]["select"]["name"]) for p, u in notion.updates] == [("b", "01"), ("a", "02"), ("c", "03"), ("f", "04")]


def test_sorter_place_turns_an_in_progress_album_into_listened(monkeypatch):
    _configure_owner(monkeypatch)
    monkeypatch.setattr("musicbox.library.sink.PAUSE", 0)
    albums = [_stored("a", 1), _stored("b", 2), _stored("new", None, "In progress")]
    notion = FakeNotion()
    monkeypatch.setattr("backend.sorter.fetch_albums", lambda *args: albums)
    monkeypatch.setattr("backend.sorter.notion_client", lambda: notion)
    client.post("/api/auth/login", json={"password": "secret"})

    body = client.post("/api/sorter/place", json={"id": "new", "rank": 2}).json()
    assert body["listened"] == ["new"]
    written = dict(notion.updates)
    assert written["new"]["properties"] == {"Alex Top": {"select": {"name": "002"}}, "Status": {"status": {"name": "Listened"}}}
    assert "Status" not in written["b"]["properties"]  # only the album that was ranked changes status


def test_album_tracks_finds_the_edition_the_cover_belongs_to(monkeypatch):
    _configure_owner(monkeypatch)
    seen = []
    match = {"options": [{"id": "std", "name": "Waking Up", "is_current": False},
                         {"id": "dlx", "name": "Waking Up (Deluxe)", "is_current": True}]}
    monkeypatch.setattr("backend.covers.suggest", lambda name, artist, current=None: match if name == "Waking Up" else None)
    monkeypatch.setattr("backend.covers.spotify.album_tracks", lambda album_id: seen.append(album_id) or [{"n": 1, "name": album_id}])
    assert TestClient(app).post("/api/covers/album-tracks", json={"name": "x"}).status_code == 401
    client.post("/api/auth/login", json={"password": "secret"})

    body = client.post("/api/covers/album-tracks", json={"name": "Waking Up", "artist": "OneRepublic", "current": "c"}).json()
    assert body == {"found": True, "edition": "Waking Up (Deluxe)", "tracks": [{"n": 1, "name": "dlx"}]}
    assert seen == ["dlx"]
    assert client.post("/api/covers/album-tracks", json={"name": "Nothing"}).json() == {"found": False, "edition": None, "tracks": []}


# --- picking the Album of the Day ---

class PickNotion(FakeNotion):
    def __init__(self):
        super().__init__()
        self.created = []
        self.databases = self

    def create(self, **payload):
        self.created.append(payload)
        return {"id": "new-page"}

    def retrieve(self, db_id):
        return {"properties": {"Genre": {"multi_select": {"options": [{"name": "Alternative rock"}, {"name": "Folk"}]}}}}


SPOTIFY_ALBUM = {
    "id": "A" * 22, "name": "Wasting Light", "release_date": "2011-04-12", "total_tracks": 11,
    "artists": [{"id": "B" * 22, "name": "Foo Fighters"}],
    "images": [{"url": "https://i.scdn.co/image/big"}, {"url": "https://i.scdn.co/image/small"}],
}


def _pick_setup(monkeypatch, albums):
    from datetime import datetime, timezone

    _configure_owner(monkeypatch)
    notion = PickNotion()
    monkeypatch.setattr("musicbox.library.sink.PAUSE", 0)
    monkeypatch.setattr("backend.pick.fetch_albums", lambda *args: albums)
    monkeypatch.setattr("backend.pick.notion_client", lambda: notion)
    monkeypatch.setattr("backend.pick.spotify.get_album", lambda album_id: SPOTIFY_ALBUM)
    monkeypatch.setattr("backend.pick.spotify.artist_genres", lambda artist_id: ["alternative rock", "post-grunge", "ALTERNATIVE ROCK"])
    client.post("/api/auth/login", json={"password": "secret"})
    return notion, datetime.now(timezone.utc).date().isoformat()


def _waiting_album(name, artist, status="Not listened", **extra):
    return Album(page_id=f"id-{name or artist}", name=name or "Untitled", artist=artist, status=status, **extra)


def test_pick_options_lists_queued_albums_and_artists_without_an_album(monkeypatch):
    albums = [
        _waiting_album("Zebra", "Z", cover="https://i.scdn.co/z", picked_by="Selina"),
        _waiting_album("Apple", "A", picked_by="Alex"),
        _waiting_album("", "Dayglow", picked_by="Alex"),
        _waiting_album("Heard", "H", "Listened"),
        _waiting_album("", "Unknown"),  # a placeholder with no artist is nothing to pick
    ]
    _pick_setup(monkeypatch, albums)
    body = client.get("/api/pick/options").json()
    assert [a["name"] for a in body["queued"]] == ["Apple", "Zebra"]
    assert body["queued"][1]["picked_by"] == "Selina" and body["queued"][1]["cover"].endswith("/z")
    assert body["queued"][0]["picked_by"] is None and body["artists"][0]["picked_by"] is None  # "Alex" isn't a recommendation
    assert [a["artist"] for a in body["artists"]] == ["Dayglow"] and body["can_search"] is True
    assert TestClient(app).get("/api/pick/options").status_code == 401


def test_choosing_a_queued_album_only_sets_today_and_in_progress(monkeypatch):
    notion, today = _pick_setup(monkeypatch, [_waiting_album("Apple", "A", cover="https://i.scdn.co/a")])
    body = client.post("/api/pick/choose", json={"id": "id-Apple", "date": today}).json()
    assert body == {"id": "id-Apple", "name": "Apple", "created": False}
    assert notion.updates == [("id-Apple", {"properties": {
        "Album of the Day": {"date": {"start": today}}, "Status": {"status": {"name": "In progress"}}}})]


def test_choosing_a_new_spotify_album_creates_its_page(monkeypatch):
    notion, today = _pick_setup(monkeypatch, [])
    body = client.post("/api/pick/choose", json={"spotify_id": "A" * 22, "date": today}).json()
    assert body == {"id": "new-page", "name": "Wasting Light", "created": True}
    made = notion.created[0]
    props = made["properties"]
    assert made["parent"] == {"database_id": "db"}
    assert props["Album"]["title"][0]["text"]["content"] == "Wasting Light"
    assert props["Artist"] == {"select": {"name": "Foo Fighters"}} and props["Picked by"] == {"select": {"name": "Alex"}}
    assert props["Release Date"] == {"date": {"start": "2011-04-12"}}
    assert props["Genre"] == {"multi_select": [{"name": "Alternative rock"}]}  # only genres the library already has
    assert props["Status"]["status"]["name"] == "In progress" and props["Album of the Day"]["date"]["start"] == today
    assert made["cover"]["external"]["url"].endswith("/big") and made["icon"]["external"]["url"].endswith("/small")


def test_choosing_a_spotify_album_that_is_already_queued_uses_that_page(monkeypatch):
    notion, today = _pick_setup(monkeypatch, [_waiting_album("Wasting Light", "Foo Fighters", cover="https://i.scdn.co/mine")])
    body = client.post("/api/pick/choose", json={"spotify_id": "A" * 22, "date": today}).json()
    assert body["created"] is False and notion.created == []
    assert list(notion.updates[0][1]) == ["properties"]  # it already has art: nothing but the date and status


def test_choosing_an_album_for_an_artist_page_fills_that_page(monkeypatch):
    notion, today = _pick_setup(monkeypatch, [_waiting_album("", "Foo Fighters")])
    body = client.post("/api/pick/choose", json={"id": "id-Foo Fighters", "spotify_id": "A" * 22, "date": today}).json()
    assert body == {"id": "id-Foo Fighters", "name": "Wasting Light", "created": False}
    page_id, payload = notion.updates[0]
    assert page_id == "id-Foo Fighters" and notion.created == []
    assert payload["properties"]["Album"]["title"][0]["text"]["content"] == "Wasting Light"
    assert "Artist" not in payload["properties"] and "cover" in payload  # the artist is already on the page


def test_a_listened_album_cannot_be_picked_again_and_the_day_is_checked(monkeypatch):
    notion, today = _pick_setup(monkeypatch, [_waiting_album("Wasting Light", "Foo Fighters", "Listened", rank_text="012", rank=12)])
    again = client.post("/api/pick/choose", json={"spotify_id": "A" * 22, "date": today})
    assert again.status_code == 409 and "No. 12" in again.json()["detail"] and notion.updates == []
    assert client.post("/api/pick/choose", json={"date": today}).status_code == 400  # nothing chosen
    assert client.post("/api/pick/choose", json={"id": "id-x", "date": "2020-01-01"}).status_code == 400  # long gone
    assert client.post("/api/pick/choose", json={"id": "id-x", "date": "2099-01-01"}).status_code == 400  # too far ahead
    assert client.post("/api/pick/choose", json={"id": "nope", "date": today}).status_code == 404
    assert client.post("/api/pick/choose", json={"id": "x", "spotify_id": "short", "date": today}).status_code == 422


def test_pick_search_marks_what_the_library_already_has(monkeypatch):
    albums = [_waiting_album("Wasting Light", "Foo Fighters", "Listened", rank_text="012", rank=12)]
    _pick_setup(monkeypatch, albums)
    monkeypatch.setattr("backend.pick.spotify.search", lambda q, kind, limit: [SPOTIFY_ALBUM, {**SPOTIFY_ALBUM, "id": "C" * 22, "name": "Other"}])
    results = client.post("/api/pick/search", json={"query": "foo"}).json()["results"]
    assert [r["name"] for r in results] == ["Wasting Light", "Other"]
    assert results[0]["library"] == {"id": "id-Wasting Light", "status": "Listened", "rank": "012"} and results[1]["library"] is None
    assert results[0]["cover"].endswith("/big")


def test_pick_helpers():
    from musicbox.library.pick import matching_genres, release_day

    assert [release_day(d) for d in ("2018", "2018-02", "2018-02-14", "", None, "2018-13")] == ["2018-01-01", "2018-02-01", "2018-02-14", None, None, None]
    assert matching_genres(["indie rock", "Folk", "folk", "x"], ["Folk", "Indie Rock"]) == ["Indie Rock", "Folk"]


def test_choosing_an_album_for_a_day_to_come(monkeypatch):
    from datetime import date, timedelta

    notion, today = _pick_setup(monkeypatch, [_waiting_album("Apple", "A", cover="https://i.scdn.co/a")])
    tomorrow = (date.fromisoformat(today) + timedelta(days=1)).isoformat()
    assert client.post("/api/pick/choose", json={"id": "id-Apple", "date": tomorrow}).status_code == 200
    assert notion.updates[0][1]["properties"]["Album of the Day"] == {"date": {"start": tomorrow}}


# --- the Purgatory backup ---

def _ranked(name, rank, artist="x", **kw):
    album = Album(page_id=name, name=name, artist=artist, rank=rank, status="Listened", **kw)
    album.rank_text = f"{rank:03d}"
    return album


def test_backup_file_round_trips_and_keeps_ties_and_covers():
    albums = [_ranked("B", 2, cover="https://i.scdn.co/image/abc"), _ranked("A", 1), _ranked("C", 2), _album("none", None),
              Album(page_id="n", name="N", rank=3, status="Not listened")]
    rows = backup.rows_from(albums)
    assert rows == [[1, "A", "x", None], [2, "B", "x", "abc"], [2, "C", "x", None]]  # ranked ones, best first, ties kept
    assert backup.parse(backup.render(rows, "2026-10-12")) == rows
    assert "as of 2026-10-12" in backup.render(rows, "2026-10-12")
    with pytest.raises(ValueError):
        backup.parse("nothing here")


def test_backup_compare_reports_what_changed():
    old = [[1, "A", "x", None], [2, "B", "x", None], [3, "C", "x", None]]
    new = [[1, "A", "x", None], [3, "B", "x", None], [3, "D", "x", None]]
    diff = backup.compare(old, new)
    assert diff["added"] == [("D", "x")] and diff["removed"] == [("C", "x")]
    assert diff["moved"] == [(("B", "x"), 2, 3)] and diff["ties"] == 1


def test_restore_plan_writes_back_only_what_differs_and_skips_what_it_cannot_match():
    rows = [[1, "A", "x", None], [2, "B", "x", None], [2, "C", "x", None], [4, "Gone", "x", None], [5, "Twin", "x", None]]
    albums = [_ranked("A", 1), _ranked("B", 3), _ranked("C", 3), _ranked("Twin", 9), _ranked("Twin", 9), _ranked("Newer", 7)]
    for a in albums:
        a.page_id = f"{a.name}-{id(a)}"
    changes, notes = backup.restore_plan(albums, rows)
    assert [(a.name, text) for a, text in changes] == [("B", "002"), ("C", "002")]  # A already matches
    assert any("Gone" in n for n in notes) and any("share that title" in n for n in notes) and any("Newer" in n for n in notes)


def test_backup_tool_refuses_to_overwrite_with_a_partial_read(monkeypatch, tmp_path):
    from musicbox.tools import purgatory_backup

    monkeypatch.setattr(backup, "SNAPSHOT", tmp_path / "snapshot.js")
    backup.write([[i, f"A{i}", "x", None] for i in range(1, 11)])
    monkeypatch.setattr(purgatory_backup, "fetch_albums", lambda: [_ranked("A1", 1)])  # Notion answered with one album
    with pytest.raises(ValueError, match="not overwriting"):
        purgatory_backup.run({}, lambda m: None)
    assert len(backup.read()) == 10  # the backup is untouched
    monkeypatch.setattr(purgatory_backup, "fetch_albums", lambda: [_ranked(f"A{i}", i) for i in range(1, 9)])
    result = purgatory_backup.run({}, lambda m: None)
    assert result["albums"] == 8 and len(backup.read()) == 8


# --- refreshing the Hall from Notion ---

def test_refresh_reads_notion_now_and_is_owner_only(monkeypatch):
    _configure_owner(monkeypatch)
    showcase.clear_cache()
    version = {"n": 1}
    monkeypatch.setattr("musicbox.library.showcase.fetch_albums", lambda: [_ranked(f"v{version['n']}", 1)])
    assert TestClient(app).post("/api/showcase/refresh").status_code == 401
    client.post("/api/auth/login", json={"password": "secret"})

    assert client.get("/api/showcase/albums").json()["albums"][0]["name"] == "v1"
    version["n"] = 2  # changed in Notion: the cache still holds v1
    assert client.get("/api/showcase/albums").json()["albums"][0]["name"] == "v1"
    assert client.post("/api/showcase/refresh").json()["albums"] == 1
    assert client.get("/api/showcase/albums").json()["albums"][0]["name"] == "v2"


def test_a_failed_refresh_keeps_the_last_copy(monkeypatch):
    _configure_owner(monkeypatch)
    showcase.clear_cache()
    monkeypatch.setattr("musicbox.library.showcase.fetch_albums", lambda: [_ranked("kept", 1)])
    client.post("/api/auth/login", json={"password": "secret"})
    assert client.get("/api/showcase/albums").json()["albums"][0]["name"] == "kept"

    def down():
        raise RuntimeError("Authorization: secret-token")

    monkeypatch.setattr("musicbox.library.showcase.fetch_albums", down)
    failed = client.post("/api/showcase/refresh")
    assert failed.status_code == 502 and "secret-token" not in failed.text
    assert client.get("/api/showcase/albums").json()["albums"][0]["name"] == "kept"  # still there
