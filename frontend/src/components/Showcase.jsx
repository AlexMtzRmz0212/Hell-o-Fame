import { useEffect, useMemo, useRef, useState } from "react";
import { CalendarPlusIcon, FeatherIcon, MagnifyingGlassIcon, XIcon } from "@phosphor-icons/react";
import { showcaseApi } from "../api";
import { demoApi } from "../demo/demoApi";
import { addDays, dayOf } from "../day";
import Herald from "./Herald";
import PickDialog from "./PickDialog";
import RankDialog from "./RankDialog";
import Descent from "../descent/Descent";
import AetherSky from "../descent/scenes/AetherSky";
import { WorldProvider } from "../descent/world";

// Read-only view of the Notion album library. Nothing here writes anywhere;
// the filters only change what this page shows. Sorted by my ranking, the albums are laid out as a descent
// from Mount Olympus down to Hades (see ../descent); any other sort shows a plain cover grid.

const byText = (get) => (a, b) => get(a).localeCompare(get(b));
// albums missing the value always sink to the bottom, whatever the direction
const byNumber = (get, dir = 1) => (a, b) => {
  const x = get(a);
  const y = get(b);
  if (x == null && y == null) return 0;
  if (x == null) return 1;
  if (y == null) return -1;
  return (x - y) * dir;
};
const time = (iso) => (iso ? Date.parse(iso) : null);

// statuses of an album I can rank: listened to, or listening to right now
const RANKABLE = ["Listened", "In progress"];

const SORTS = {
  rank: { label: "My ranking", cmp: byNumber((a) => a.rank) },
  recent: { label: "Latest Album of the Day", cmp: byNumber((a) => time(a.album_of_day), -1) },
  released: { label: "Newest release", cmp: byNumber((a) => time(a.release_date), -1) },
  oldest: { label: "Oldest release", cmp: byNumber((a) => time(a.release_date)) },
  artist: { label: "Artist A-Z", cmp: byText((a) => a.artist) },
  name: { label: "Album A-Z", cmp: byText((a) => a.name) },
};

const year = (a) => (a.release_date ? Number(a.release_date.slice(0, 4)) : null);
const decadeOf = (a) => (year(a) ? Math.floor(year(a) / 10) * 10 : null);

export function formatDate(iso) {
  if (!iso) return null;
  const date = new Date(`${iso.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function formatStamp(iso) {
  const date = iso ? new Date(iso) : null;
  if (!date || Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function hue(text) {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

/** Cover art, or a coloured tile with the album's initials when there is none (or its link expired). */
export function Cover({ album, eager = false }) {
  const [failed, setFailed] = useState(false);
  if (album.cover && !failed) {
    return (
      <img
        src={album.cover}
        alt={`${album.name} cover`}
        width={300}
        height={300}
        loading={eager ? "eager" : "lazy"}
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
    );
  }
  const initials = album.name.split(/\s+/).slice(0, 2).map((w) => w[0]).join("");
  return (
    <span className="sc-blank" style={{ "--h": hue(album.name + album.artist) }} role="img" aria-label={`${album.name} (no cover)`}>
      {initials}
    </span>
  );
}

/** One album on the wall. The gods on Olympus are plaques with a big engraved rank. */
export function Tile({ album, big = false, eager = false, onOpen }) {
  return (
    <button className={`tile${big ? " plaque" : ""}`} onClick={() => onOpen(album)}>
      <span className="sc-cover">
        <Cover album={album} eager={eager} />
        {album.rank != null && !big && (
          <span className="sc-rank" aria-label={`Rank ${album.rank}`}>
            {album.rank}
          </span>
        )}
      </span>
      <span className="sc-caption">
        {big && album.rank != null && (
          <span className="sc-numeral" aria-label={`Rank ${album.rank}`}>
            {album.rank}
          </span>
        )}
        <span className="sc-caption-text">
          <span className="sc-name">{album.name}</span>
          <span className="sc-by">{album.artist}</span>
        </span>
      </span>
    </button>
  );
}

function Detail({ album, onClose }) {
  const dialog = useRef(null);
  useEffect(() => {
    const el = dialog.current;
    if (el && !el.open) el.showModal();
  }, []);

  const rows = [
    ["Released", formatDate(album.release_date)],
    ["Decade", album.decade],
    ["My ranking", album.rank != null ? `#${album.rank}` : null],
    ["Status", album.status],
    ["Album of the Day", formatDate(album.album_of_day)],
  ].filter(([, value]) => value);

  return (
    <dialog
      ref={dialog}
      className="sc-detail"
      aria-label={`${album.name} by ${album.artist}`}
      onClose={onClose}
      onClick={(e) => e.target === dialog.current && dialog.current.close()}
    >
      <div className="sc-detail-body">
        <div className="sc-cover">
          <Cover album={album} eager />
        </div>
        <div className="sc-detail-info">
          <button className="icon-btn sc-x" onClick={() => dialog.current.close()} aria-label="Close">
            <XIcon aria-hidden="true" />
          </button>
          {album.rank != null && <p className="sc-detail-rank">No. {album.rank}</p>}
          <h2>{album.name}</h2>
          <p className="sc-artist">{album.artist}</p>
          {album.genres.length > 0 && (
            <p className="sc-genres">
              {album.genres.map((g) => (
                <span key={g}>{g}</span>
              ))}
            </p>
          )}
          <dl>
            {rows.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </dialog>
  );
}

// `onLibraryChanged`: the owner ranked or picked an album, so other tabs showing ranks (Purgatory) should reload.
// `refresh` changes when the owner presses Live: the albums are fetched again.
export default function Showcase({ hidden, owner = false, refresh = 0, onLibraryChanged }) {
  const [data, setData] = useState(null); // { albums, sample, updated }
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("rank");
  const [genre, setGenre] = useState("");
  const [decade, setDecade] = useState(null);
  const [status, setStatus] = useState("");
  const [selected, setSelected] = useState(null);
  const [ranking, setRanking] = useState(false); // the owner's ranker popup for the Album of the Day
  const [picking, setPicking] = useState(false); // the owner's popup to pick a new Album of the Day
  const [reload, setReload] = useState(0); // bumped to fetch the albums again, e.g. after a new Album of the Day is picked

  useEffect(() => {
    let live = true;
    showcaseApi
      .albums(owner)
      .then(({ albums, updated_at }) => live && setData({ albums, sample: false, updated: formatStamp(updated_at) }))
      .catch(async (e) => {
        // Not configured, offline, or Notion is down: show sample albums rather than an empty tab.
        const { albums } = await demoApi.showcase();
        if (!live) return;
        setError(e.status === 503 ? "" : e.message);
        setData({ albums, sample: true });
      });
    return () => {
      live = false;
    };
  }, [owner, reload, refresh]); // signing in or out, or a new pick, reloads it: the owner's copy is always fresh

  const albums = data?.albums;

  // the owner just ranked the Album of the Day: show the new ranks now (the cached public copy catches up later)
  const applyRanks = ({ ranks, listened = [] }) => {
    onLibraryChanged?.();
    setData((d) => ({
      ...d,
      albums: d.albums.map((a) => ({
        ...a,
        ...(ranks[a.id] ? { rank: Number(ranks[a.id]) } : {}),
        ...(listened.includes(a.id) ? { status: "Listened" } : {}),
      })),
    }));
  };

  const facets = useMemo(() => {
    if (!albums) return null;
    const count = (values) => {
      const tally = new Map();
      values.forEach((v) => tally.set(v, (tally.get(v) || 0) + 1));
      return tally;
    };
    const genres = [...count(albums.flatMap((a) => a.genres))].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const decades = [...new Set(albums.map(decadeOf).filter(Boolean))].sort((a, b) => b - a);
    const statuses = [...new Set(albums.map((a) => a.status))].sort();
    const today = dayOf();
    const dated = albums.filter((a) => a.album_of_day);
    const latest = dated
      .filter((a) => a.album_of_day.slice(0, 10) <= today)
      .sort((a, b) => b.album_of_day.localeCompare(a.album_of_day))[0];
    // The banner shows today's album. An older one stays only while it is still unranked (I'm still listening to it),
    // so I can rank it; once it is ranked and its day is over, the banner waits for today's pick.
    const ofTheDay = latest && (latest.album_of_day.slice(0, 10) === today || latest.rank == null) ? latest : null;
    const taken = new Map(dated.map((a) => [a.album_of_day.slice(0, 10), a.name])); // day -> its album
    let nextDay = today; // the first day without an album, from today on
    while (taken.has(nextDay)) nextDay = addDays(nextDay, 1);
    return {
      genres,
      decades,
      statuses,
      ofTheDay,
      latest,
      today,
      taken,
      nextDay,
      listened: albums.filter((a) => a.status === "Listened").length,
      artists: new Set(albums.map((a) => a.artist)).size,
      noCover: albums.filter((a) => !a.cover).length,
    };
  }, [albums]);

  // the owner can rank today's album from its card while it has no rank yet
  const canRank = owner && Boolean(data) && !data.sample && facets?.ofTheDay?.rank == null && RANKABLE.includes(facets?.ofTheDay?.status);

  // once today's album is listened to and ranked, the owner can pick the next one, for a day to come
  const live = owner && Boolean(data) && !data.sample;
  const canPick = live && facets?.ofTheDay?.rank != null; // under today's ranked album: pick one for a day to come

  const filtered = useMemo(() => {
    if (!albums) return [];
    const q = query.trim().toLowerCase();
    return albums
      .filter((a) => !q || `${a.name} ${a.artist}`.toLowerCase().includes(q))
      .filter((a) => !genre || a.genres.includes(genre))
      .filter((a) => !decade || decadeOf(a) === decade)
      .filter((a) => !status || a.status === status)
      .sort(SORTS[sort].cmp);
  }, [albums, query, sort, genre, decade, status]);

  const filtering = Boolean(query || genre || decade || status);
  const descending = sort === "rank"; // ranked: the descent from Olympus to Hades
  const descent = useRef(null);

  const reset = () => {
    setQuery("");
    setGenre("");
    setDecade(null);
    setStatus("");
  };
  // Hermes' "Find it in the descent": clear what could hide it, then let the descent bring it into view
  const findToday = () => {
    const id = facets.ofTheDay.id;
    const hiddenNow = !descending || !filtered.some((a) => a.id === id);
    if (hiddenNow) {
      reset();
      setSort("rank");
    }
    setTimeout(() => descent.current?.find(id), hiddenNow ? 80 : 0);
  };

  return (
    <section className="sc" hidden={hidden} aria-label="Album showcase">
      <WorldProvider active={descending && !hidden && Boolean(data)}>
        {descending && data && <AetherSky />}
        {!data && (
          <p className="note" role="status">
            Loading albums…
          </p>
        )}
        {data?.sample && (
          <p className="note">
            {error ? `Couldn’t load the album library (${error}). ` : "The album library isn’t connected here. "}
            These are sample albums.
          </p>
        )}

        {data && (
          <>
            {!facets.ofTheDay && (
              <Herald
                day={facets.today}
                owner={live}
                waiting={albums.filter((a) => a.status === "Not listened" && a.name !== "Untitled").length}
                latest={facets.latest}
                onPick={() => setPicking(true)}
                onOpenLatest={() => setSelected(facets.latest)}
              />
            )}
            {facets.ofTheDay && (
              <div className="sc-today-wrap">
                <button className="sc-today plaque" onClick={() => (canRank ? setRanking(true) : setSelected(facets.ofTheDay))}>
                  <span className="sc-cover">
                    <Cover album={facets.ofTheDay} eager />
                  </span>
                  <span className="sc-today-text">
                    <span className="sc-kicker">Album of the Day, {formatDate(facets.ofTheDay.album_of_day)}</span>
                    <strong>{facets.ofTheDay.name}</strong>
                    <span className="sc-today-artist">{facets.ofTheDay.artist}</span>
                    {facets.ofTheDay.genres.length > 0 && <span className="sc-dim">{facets.ofTheDay.genres.join(", ")}</span>}
                    {facets.ofTheDay.rank != null && <span className="sc-today-rank">Ranked No. {facets.ofTheDay.rank}</span>}
                    {canRank && <span className="sc-today-rank sc-rank-cta">Not ranked yet. Click to rank it.</span>}
                    <span className="sc-hermes">
                      <FeatherIcon aria-hidden="true" />
                      Delivered by Hermes
                    </span>
                  </span>
                </button>
                <button className="link sc-find" onClick={findToday}>
                  Find it in the descent
                </button>
                {canPick && (
                  <button className="sc-pick" onClick={() => setPicking(true)}>
                    <CalendarPlusIcon aria-hidden="true" />
                    Pick the next Album of the Day
                  </button>
                )}
              </div>
            )}

            <p className="sc-stats">
              {albums.length} albums by {facets.artists} artists, {facets.listened} listened to
              {!data.sample && facets.noCover > 0 ? `, ${facets.noCover} without cover art` : ""}.
              {data.updated && <span className="sc-updated"> Updated {data.updated}.</span>}
            </p>

            <div className="sc-controls">
              <label className="field sc-search">
                <span>Search</span>
                <span className="input-icon">
                  <MagnifyingGlassIcon aria-hidden="true" />
                  <input
                    type="search"
                    name="q"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="Album or artist…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </span>
              </label>
              <label className="field">
                <span>Sort</span>
                <select value={sort} onChange={(e) => setSort(e.target.value)}>
                  {Object.entries(SORTS).map(([key, { label }]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Genre</span>
                <select value={genre} onChange={(e) => setGenre(e.target.value)}>
                  <option value="">All genres</option>
                  {facets.genres.map(([name, n]) => (
                    <option key={name} value={name}>
                      {name} ({n})
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Status</span>
                <select value={status} onChange={(e) => setStatus(e.target.value)}>
                  <option value="">Any status</option>
                  {facets.statuses.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {facets.decades.length > 0 && (
              <div className="seg sc-decades" role="group" aria-label="Decade">
                {facets.decades.map((d) => (
                  <button key={d} aria-pressed={decade === d} onClick={() => setDecade(decade === d ? null : d)}>
                    {d}s
                  </button>
                ))}
              </div>
            )}

            {filtering && (
              <p className="sc-stats" aria-live="polite">
                {filtered.length} of {albums.length} albums.{" "}
                <button className="link" onClick={reset}>
                  Clear filters
                </button>
              </p>
            )}

            {filtered.length === 0 && (
              <p className="note">No albums match. Try a different search or clear the filters.</p>
            )}
            {descending ? (
              <Descent
                ref={descent}
                albums={filtered}
                all={albums}
                onOpen={setSelected}
                hidden={hidden}
                filtering={filtering}
              />
            ) : (
              filtered.length > 0 && (
                <ul className="sc-grid">
                  {filtered.map((album, i) => (
                    <li key={album.id}>
                      <Tile album={album} eager={i < 12} onOpen={setSelected} />
                    </li>
                  ))}
                </ul>
              )
            )}
          </>
        )}

        {picking && (
          <PickDialog
            today={facets.today}
            defaultDay={facets.nextDay}
            taken={Object.fromEntries(facets.taken)}
            onPicked={() => {
              setReload((n) => n + 1);
              onLibraryChanged?.();
            }}
            onClose={() => setPicking(false)}
          />
        )}
        {ranking && facets?.ofTheDay && (
          <RankDialog key={facets.ofTheDay.id} album={facets.ofTheDay} onRanked={applyRanks} onClose={() => setRanking(false)} />
        )}
        {selected && <Detail key={selected.id} album={selected} onClose={() => setSelected(null)} />}
      </WorldProvider>
    </section>
  );
}
