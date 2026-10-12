// In-memory stand-in for the tools API, used by the public demo. Same shapes as
// the real API; nothing leaves the browser and no account is touched.

import { planRanks } from "../sorter";
import { COVER_BASE, SORTER_SNAPSHOT } from "./sorterSnapshot";

const T = (id, category, title, description, writes, params) => ({ id, category, title, description, writes, params, missing: [] });
const dry = { name: "dry_run", label: "Dry run (don't write)", type: "bool", default: true };

const TOOLS = [
  T("streams_songs", "Charts", "Most streamed songs", "Scrapes the most-streamed Spotify songs and fills a Notion table.", true, [dry]),
  T("streams_albums", "Charts", "Most streamed albums", "Scrapes all-time Spotify album streams and fills a Notion table.", true, [dry]),
  T("album_icons", "Library", "Album covers as page icons", "Gives every album page with a Spotify cover and no icon that cover as its Notion icon. Icons set by hand are kept unless you tick the second option.", true,
    [dry, { name: "replace_chosen", label: "Also replace icons set by hand (emoji, uploaded images, other Notion icons)", type: "bool", default: false }]),
  T("purgatory_backup", "Library", "Back up Purgatory", "Saves every ranked album's rank (ties included) into the backup file the public page plays on. It only writes that file on this computer, never Notion.", false, []),
  T("purgatory_restore", "Library", "Restore Purgatory from the backup", "Writes the ranks saved in the backup file back to Notion, ties and gaps included, for when the ranking got damaged.", true, [dry]),
  T("spotify_search", "Lookup", "Spotify search", "Looks up albums, artists or tracks in the Spotify catalogue.", false,
    [{ name: "query", label: "Search", type: "text", default: "Twenty One Pilots" },
     { name: "kind", label: "Type", type: "select", options: ["album", "artist", "track"], default: "album" }]),
  T("setlistfm", "Lookup", "Setlist.fm search", "Recent concert setlists for an artist.", false,
    [{ name: "artist", label: "Artist", type: "text", default: "Radiohead" }]),
  T("genius_lyrics", "Lookup", "Genius lyrics", "Finds a song on Genius and shows its page and lyrics.", false,
    [{ name: "artist", label: "Artist", type: "text", default: "Eminem" }, { name: "song", label: "Song", type: "text", default: "Lose Yourself" }]),
];

const RUNS = {
  streams_songs: () => ({
    log: ["Retrieved 100 songs (sample data)"],
    result: { written: 0, rows: [
      { Rank: "1", Song: "Blinding Lights", Artist: "The Weeknd", Streams: "5.6", Date: "29 November 2019" },
      { Rank: "2", Song: "Shape of You", Artist: "Ed Sheeran", Streams: "4.1", Date: "6 January 2017" } ] },
  }),
  streams_albums: () => ({
    log: ["Retrieved 200 albums (sample data)"],
    result: { written: 0, rows: [
      { ArtistandTitle: "The Weeknd - After Hours", Streams: "12,000,000,000", Daily: "5,000,000" },
      { ArtistandTitle: "Ed Sheeran - ÷", Streams: "13,000,000,000", Daily: "4,000,000" } ] },
  }),
  purgatory_backup: () => ({
    log: ["Notion has 16 ranked albums (2 ranks shared by several); the backup had 16", "0 added, 0 removed, 0 with another rank (sample data)"],
    result: { albums: 16, ties: 2, changed: 0, rows: [] },
  }),
  purgatory_restore: () => ({
    log: ["The backup has 16 ranked albums: 0 would get another rank in Notion (sample data)"],
    result: { would_write: 0, written: 0, failed: 0, rows: [] },
  }),
  album_icons: () => ({
    log: ["12 pages: 4 already have an icon, 8 get their cover as the icon (sample data)"],
    result: { would_write: 8, written: 0, failed: 0, rows: [
      { album: "OK Computer", artist: "Radiohead", icon: "https://i.scdn.co/image/sample" },
      { album: "Kid A", artist: "Radiohead", icon: "https://i.scdn.co/image/sample" } ] },
  }),
  spotify_search: (p) => ({
    log: [`3 ${p.kind}(s) for '${p.query}' (sample data)`],
    result: { rows: [1, 2, 3].map((n) => ({ name: `${p.query} #${n}`, artists: "Sample Artist", released: `20${10 + n}-01-01`, url: "https://open.spotify.com" })) },
  }),
  setlistfm: (p) => ({
    log: [`2 setlists for '${p.artist}' (sample data)`],
    result: { rows: [{ date: "01-06-2025", venue: "Sample Arena", city: "Toronto", songs: 22, opener: "Opening Song" },
                     { date: "28-05-2025", venue: "Demo Hall", city: "Montreal", songs: 20, opener: "Opening Song" }] },
  }),
  genius_lyrics: (p) => ({
    log: [`Found '${p.song}' by ${p.artist} (sample data)`],
    result: { found: true, title: p.song, artist: p.artist, url: "https://genius.com", lyrics: "(The demo doesn't fetch real lyrics.)" },
  }),
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Same shape as GET /api/showcase/albums. No covers: the showcase draws a coloured tile instead.
const S = (rank, name, artist, genres, release_date, status = "Listened", extra = {}) => ({
  id: `sample-${name}`, name, artist, genres, release_date, decade: null, rank, status,
  album_of_day: null, cover: null, ...extra,
});
const SAMPLE_ALBUMS = [
  S(1, "OK Computer", "Radiohead", ["Alternative rock"], "1997-06-16", "Listened", { album_of_day: "2025-06-01" }),
  S(2, "To Pimp a Butterfly", "Kendrick Lamar", ["Hip hop", "Jazz rap"], "2015-03-15"),
  S(3, "Blurryface", "Twenty One Pilots", ["Alternative"], "2015-05-17"),
  S(4, "Random Access Memories", "Daft Punk", ["Electronic", "Disco"], "2013-05-17"),
  S(5, "Walking On A Dream", "Empire of the Sun", ["Synth-pop"], "2008-10-03"),
  S(6, "Blue", "Joni Mitchell", ["Folk"], "1971-06-22"),
  S(7, "Kind of Blue", "Miles Davis", ["Jazz"], "1959-08-17"),
  S(8, "Lonerism", "Tame Impala", ["Psychedelic"], "2012-10-05"),
  S(9, "Rumours", "Fleetwood Mac", ["Rock"], "1977-02-04"),
  S(10, "Kid A", "Radiohead", ["Electronic", "Experimental"], "2000-10-02"),
  S(null, "Punisher", "Phoebe Bridgers", ["Indie folk"], "2020-06-18", "Not listened"),
  S(null, "Discovery", "Daft Punk", ["Electronic", "House"], "2001-03-12", "Not listened"),
];

// Album sorter demo: a copy of the real Purgatory, ties included (see sorterSnapshot.js). "Writing" only changes
// this list, in memory; reloading the page brings the ties back.
const rankText = (rank) => String(rank).padStart(rank > 99 ? 3 : 2, "0");
let SORTER_ALBUMS = SORTER_SNAPSHOT.map(([rank, name, artist, image], i) => ({
  id: `demo-${i}`, name, artist, cover: image ? COVER_BASE + image : null, rank, rank_text: rankText(rank),
}));

export const demoApi = {
  showcase: async () => ({ albums: SAMPLE_ALBUMS, updated_at: null }),
  tools: async () => TOOLS,
  sorter: {
    albums: async () => {
      await wait(200);
      return { albums: SORTER_ALBUMS };
    },
    apply: async ({ tiebreak, compact }) => {
      await wait(400);
      const rows = planRanks(SORTER_ALBUMS, tiebreak, compact);
      SORTER_ALBUMS = rows.map(({ id, name, artist, cover, after, afterNum }) => ({ id, name, artist, cover, rank: afterNum, rank_text: after }));
      return { written: rows.filter((r) => r.changed).length, failed: 0, log: [] };
    },
  },
  run: async (id, params) => {
    await wait(400);
    const { log, result } = RUNS[id](params);
    return { ok: true, error: null, log, result };
  },
};
