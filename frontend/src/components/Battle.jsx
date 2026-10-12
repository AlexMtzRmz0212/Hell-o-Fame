import { useEffect, useState } from "react";
import { CrownIcon, FlagPennantIcon, SwordIcon } from "@phosphor-icons/react";
import { coversApi } from "../api";

// The pieces of the ranker's battle: crossed swords, a round tracker, the zone the album can still land in, the
// songs of each fighter and the victor's crown. RankDialog puts them together.

/** Two swords crossed, the emblem between the fighters. */
export function Swords() {
  return (
    <span className="arena-swords" aria-hidden="true">
      <SwordIcon weight="fill" />
      <SwordIcon weight="fill" className="flip" />
    </span>
  );
}

/** One pip per round: fought, the one being fought, and the most that can still follow. */
export function Rounds({ fought, atMost }) {
  const total = fought + atMost;
  return (
    <span className="arena-rounds" role="img" aria-label={`Round ${fought + 1} of at most ${total}`}>
      {Array.from({ length: total }, (_, i) => (
        <span key={i} className={i < fought ? "done" : i === fought ? "now" : ""} />
      ))}
    </span>
  );
}

/**
 * The ranking as a strip, No. 1 on the left. The lit part is where the album can still land (it shrinks with
 * every round), and the pennant is my locked estimate.
 */
export function LandingZone({ lo, hi, slots, from, to, estimateSlot, estimateRank }) {
  // lo..hi are slots between my ranked albums (0 = above the first, `slots - 1` = below the last); from/to are their ranks
  const pct = (n) => `${(n / slots) * 100}%`;
  return (
    <div className="arena-zone">
      <div className="arena-strip" aria-hidden="true">
        <span className="arena-lit" style={{ left: pct(lo), width: pct(hi - lo + 1) }} />
        {estimateSlot != null && (
          <span className="arena-flag" style={{ left: pct(estimateSlot + 0.5) }} title={`My estimate: No. ${estimateRank}`}>
            <FlagPennantIcon weight="fill" />
          </span>
        )}
      </div>
      <p className="as-dim arena-zone-text">
        It will land between No. {from} and No. {to}
        {estimateSlot != null ? (estimateSlot >= lo && estimateSlot <= hi ? ", and your estimate is still in play." : ", and your estimate is out of range now.") : "."}
      </p>
    </div>
  );
}

/** Marks the winner of a round. */
export function Victor() {
  return (
    <span className="arena-victor" aria-hidden="true">
      <CrownIcon weight="fill" />
      Victor
    </span>
  );
}

// songs by library album id, kept for the whole session so flipping back to a fight is instant
const cache = new Map();

function useSongs(album, enabled) {
  const [, bump] = useState(0);
  useEffect(() => {
    if (!enabled || cache.has(album.id)) return;
    cache.set(album.id, { state: "loading" });
    coversApi
      .albumTracks({ name: album.name, artist: album.artist, cover: album.cover })
      .then((res) => cache.set(album.id, res.found ? { state: "ready", ...res } : { state: "missing" }))
      .catch((e) => cache.set(album.id, { state: "error", error: e.message }))
      .finally(() => bump((n) => n + 1));
    bump((n) => n + 1);
  }, [album.id, album.name, album.artist, album.cover, enabled]);
  return cache.get(album.id);
}

const duration = (s) => (s ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : "");

/** The songs of one fighter, from Spotify. */
export function Songs({ album }) {
  const songs = useSongs(album, true);
  if (!songs || songs.state === "loading") return <p className="as-dim arena-songs">Loading songs…</p>;
  if (songs.state === "missing") return <p className="as-dim arena-songs">Spotify doesn’t have this album.</p>;
  if (songs.state === "error") return <p className="as-dim arena-songs">Couldn’t load the songs.</p>;
  return (
    <div className="arena-songs">
      <ol>
        {songs.tracks.map((t, i) => (
          <li key={`${t.disc}-${t.n}-${i}`}>
            {/* first, so it floats level with the song's first line */}
            <span className="cr-dur">{duration(t.seconds)}</span>
            <span className="cr-track">{t.name}</span>
            {t.explicit && (
              <abbr className="cr-e" title="Explicit">
                E
              </abbr>
            )}
          </li>
        ))}
      </ol>
      {songs.edition && songs.edition.toLowerCase() !== album.name.toLowerCase() && (
        <p className="as-dim">Edition: {songs.edition}</p>
      )}
    </div>
  );
}
