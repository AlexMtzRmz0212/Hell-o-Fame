import { useEffect, useRef, useState } from "react";
import { ArrowLeftIcon, DiceFiveIcon, MagnifyingGlassIcon, XIcon } from "@phosphor-icons/react";
import { pickApi } from "../api";
import { longDay } from "../day";
import { Cover, Tile } from "./Showcase";

// Owner only: picks today's Album of the Day, opened from the Hall once the current one is listened to and ranked.
// Three places to choose from:
//   Waiting     albums already in the library that aren't listened to yet.
//   Artists     library pages that only have an artist ("no album yet"): pick the artist, then one of their albums.
//   Spotify     a free search for any album. A new one is added to the library.
// Choosing gives the album a day as its Album of the Day (today, or one to come) and marks it In progress; the Hall
// shows it on that day.

const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const year = (iso) => (iso ? iso.slice(0, 4) : "");

// `today` and `defaultDay` are days (YYYY-MM-DD); `taken` maps a day to the album that already has it; `onPicked` runs
// after the album is chosen, so the Hall can reload.
export default function PickDialog({ today, defaultDay, taken, onPicked, onClose }) {
  const dialog = useRef(null);
  const [options, setOptions] = useState(null); // { queued, artists, can_search }
  const [tab, setTab] = useState("waiting"); // waiting | artists | search
  const [query, setQuery] = useState("");
  const [results, setResults] = useState(null); // Spotify albums for the last search
  const [forPage, setForPage] = useState(null); // an artist page that the chosen album will fill
  const [choice, setChoice] = useState(null); // { id, spotifyId, name, artist, cover, note }
  const [day, setDay] = useState(defaultDay); // the day it becomes the Album of the Day
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dayOk = /^\d{4}-\d{2}-\d{2}$/.test(day) && day >= today;
  const clash = dayOk ? taken[day] : null; // the album that already has that day
  const isToday = day === today;

  useEffect(() => {
    const el = dialog.current;
    if (el && !el.open) el.showModal();
  }, []);
  useEffect(() => {
    let live = true;
    pickApi
      .options()
      .then((o) => live && setOptions(o))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, []);

  const close = () => {
    dialog.current?.close();
    onClose();
  };

  const search = async (text) => {
    const q = text.trim();
    if (!q) return;
    setBusy(true);
    setError("");
    setResults(null);
    try {
      setResults((await pickApi.search(q)).results);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const chooseArtist = (artist) => {
    setForPage(artist);
    setTab("search");
    setQuery(artist.artist);
    search(artist.artist);
  };
  const chooseQueued = (album) =>
    setChoice({ id: album.id, name: album.name, artist: album.artist, cover: album.cover, note: "It is already in your library: only its date and status change." });
  const chooseResult = (r) => {
    const known = r.library && r.library.status !== "Listened";
    setChoice({
      id: forPage?.id ?? (known ? r.library.id : null),
      spotifyId: r.spotify_id,
      name: r.name,
      artist: r.artist,
      cover: r.cover,
      note: forPage
        ? `It fills ${forPage.artist}’s page in your library: title, cover, release date and genres.`
        : known
          ? "It is already in your library: only its date and status change."
          : "It is new: a page is added to your library with its cover, release date and genres, marked as picked by you.",
    });
  };
  const surprise = () => {
    const list = options?.queued ?? [];
    if (list.length) chooseQueued(list[Math.floor(Math.random() * list.length)]);
  };

  const confirm = async () => {
    setBusy(true);
    setError("");
    try {
      await pickApi.choose({ id: choice.id, spotifyId: choice.spotifyId, day });
      onPicked();
      close();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const queued = options?.queued ?? [];
  const artists = options?.artists ?? [];
  const tabs = [
    ["waiting", `Waiting (${queued.length})`],
    ["artists", `Artists (${artists.length})`],
    ["search", "Search Spotify"],
  ];

  return (
    <dialog
      ref={dialog}
      className="sc-detail rank-dialog pick-dialog"
      aria-label="Pick today's Album of the Day"
      onClose={onClose}
      onClick={(e) => e.target === dialog.current && close()}
    >
      <div className="rank-body">
        <button className="icon-btn sc-x" onClick={close} aria-label="Close">
          <XIcon aria-hidden="true" />
        </button>
        <header>
          <span className="sc-kicker">{dayOk ? longDay(day) : "Choose a day"}</span>
          <h2 className="pick-title">{isToday ? "Pick today’s Album of the Day" : "Pick the Album of the Day"}</h2>
          <label className="pick-day">
            <span>For</span>
            <input type="date" value={day} min={today} onChange={(e) => setDay(e.target.value)} />
            {!isToday && dayOk && !clash && <span className="as-dim">It appears in the Hall on that day.</span>}
            {clash && (
              <span className="error" role="alert">
                That day already has {clash}. Choose another day.
              </span>
            )}
            {!dayOk && <span className="error">Choose today or a day to come.</span>}
          </label>
        </header>

        {choice ? (
          <div className="rank-step">
            <div className="pick-choice">
              <span className="sc-cover pick-choice-cover">
                <Cover album={{ name: choice.name, artist: choice.artist, cover: choice.cover }} eager />
              </span>
              <span className="pick-choice-text">
                <strong>{choice.name}</strong>
                <span>{choice.artist}</span>
                <span className="as-dim">
                  {choice.note} {longDay(day)} becomes its Album of the Day, and it is marked In progress.
                </span>
              </span>
            </div>
            <div className="as-match-actions">
              <button onClick={confirm} disabled={busy || !dayOk || Boolean(clash)}>
                {busy ? "Saving…" : isToday ? "Make it today’s Album of the Day" : `Make it the Album of the Day for ${longDay(day)}`}
              </button>
              <button className="ghost" onClick={() => setChoice(null)} disabled={busy}>
                <ArrowLeftIcon aria-hidden="true" />
                Back
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="seg" role="group" aria-label="Where to pick from">
              {tabs.map(([id, label]) => (
                <button key={id} aria-pressed={tab === id} onClick={() => setTab(id)}>
                  {label}
                </button>
              ))}
            </div>

            {!options && !error && (
              <p className="note" role="status">
                Loading your library…
              </p>
            )}

            {options && tab === "waiting" && (
              <div className="rank-step">
                <p className="as-dim">
                  {queued.length
                    ? `${plural(queued.length, "album")} waiting to be listened to in your library.`
                    : "Nothing is waiting in your library. Pick an artist, or search Spotify."}
                </p>
                {queued.length > 0 && (
                  <button className="ghost" onClick={surprise}>
                    <DiceFiveIcon aria-hidden="true" />
                    Surprise me
                  </button>
                )}
                <ul className="sc-grid pick-grid">
                  {queued.map((a) => (
                    <li key={a.id}>
                      <Tile album={{ ...a, rank: null }} onOpen={() => chooseQueued(a)} />
                      {a.picked_by && <span className="as-dim pick-by">Picked by {a.picked_by}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {options && tab === "artists" && (
              <div className="rank-step">
                <p className="as-dim">
                  {plural(artists.length, "artist")} in your library with no album chosen yet. Pick one, then choose which of their albums
                  to listen to.
                </p>
                <ul className="pick-artists">
                  {artists.map((a) => (
                    <li key={a.id}>
                      <button className="chip" onClick={() => chooseArtist(a)} disabled={!options.can_search}>
                        {a.artist}
                        {a.picked_by && <span className="as-dim"> · {a.picked_by}</span>}
                      </button>
                    </li>
                  ))}
                </ul>
                {!options.can_search && <p className="error">Spotify isn’t set up, so albums can’t be looked up.</p>}
              </div>
            )}

            {options && tab === "search" && (
              <div className="rank-step">
                {forPage && (
                  <p className="rank-locked">
                    Choosing an album for <strong>{forPage.artist}</strong>{" "}
                    <button className="link" onClick={() => setForPage(null)}>
                      Search for anything instead
                    </button>
                  </p>
                )}
                {options.can_search ? (
                  <form
                    className="pick-search"
                    onSubmit={(e) => {
                      e.preventDefault();
                      search(query);
                    }}
                  >
                    <label className="field">
                      <span>Album or artist</span>
                      <span className="input-icon">
                        <MagnifyingGlassIcon aria-hidden="true" />
                        <input
                          type="search"
                          autoComplete="off"
                          spellCheck={false}
                          placeholder="Search Spotify…"
                          value={query}
                          onChange={(e) => setQuery(e.target.value)}
                          autoFocus={!forPage}
                        />
                      </span>
                    </label>
                    <button type="submit" disabled={busy || !query.trim()}>
                      {busy ? "Searching…" : "Search"}
                    </button>
                  </form>
                ) : (
                  <p className="error">Spotify isn’t set up, so albums can’t be searched.</p>
                )}
                {results && results.length === 0 && <p className="note">Spotify found nothing for that. Try another search.</p>}
                {results && results.length > 0 && (
                  <ul className="pick-results">
                    {results.map((r) => {
                      const listened = r.library?.status === "Listened";
                      return (
                        <li key={r.spotify_id}>
                          <button className="pick-result" onClick={() => chooseResult(r)} disabled={listened}>
                            <span className="sc-cover pick-thumb">
                              <Cover album={{ name: r.name, artist: r.artist, cover: r.cover }} />
                            </span>
                            <span className="pick-result-text">
                              <strong>{r.name}</strong>
                              <span>{r.artist}</span>
                              <span className="as-dim">
                                {[year(r.release_date), r.total_tracks ? plural(r.total_tracks, "track") : "", r.album_type !== "album" ? r.album_type : ""]
                                  .filter(Boolean)
                                  .join(" · ")}
                              </span>
                            </span>
                            <span className={`pick-badge${listened ? " done" : ""}`}>
                              {listened
                                ? `Listened${r.library.rank ? `, No. ${Number(r.library.rank)}` : ""}`
                                : r.library
                                  ? "In your library"
                                  : forPage
                                    ? "Fills the page"
                                    : "New"}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            )}
          </>
        )}

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
    </dialog>
  );
}
