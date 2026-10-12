// Album sorter logic, no React: which ranks are shared, the playoff that orders them, and the ranks that result.
// planRanks mirrors rank_listened in musicbox/library/transform.py; the server recomputes it when writing.

const ANSWERS = "mh-sorter-answers";

/**
 * Ranks shared by several albums, lowest rank first. Each group plays in a fixed order (by page id) so the
 * saved answers replay the same way however Notion happens to list the albums.
 */
export function tieGroups(albums) {
  const byRank = new Map();
  for (const a of albums) byRank.set(a.rank, [...(byRank.get(a.rank) || []), a]);
  return [...byRank]
    .filter(([, members]) => members.length > 1)
    .sort(([a], [b]) => a - b)
    .map(([rank, members]) => {
      const ids = members.map((m) => m.id).sort();
      // keyed by who is tied, not by the rank number: ranking another album shifts ranks, but not who plays whom
      return { rank, ids, key: ids.join(",") };
    });
}

/**
 * Binary insertion through matches. Albums enter one at a time and the newcomer (the challenger) faces the album
 * in the middle of the places it could still take, so every answer halves them; nothing that already follows
 * from earlier answers is asked. `answers` are the winners' ids, in order. Replaying them gives either the next
 * match or the final order (best first).
 */
export function playoff(ids, answers) {
  const ladder = ids.slice(0, 1);
  let played = 0;
  for (let i = 1; i < ids.length; i++) {
    const challenger = ids[i];
    let lo = 0;
    let hi = ladder.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (played >= answers.length) {
        // worst case left: this challenger's search, then every later one into a ladder that keeps growing
        let left = Math.ceil(Math.log2(hi - lo + 1));
        for (let size = ladder.length + 1; size < ids.length; size++) left += Math.ceil(Math.log2(size + 1));
        return {
          done: false, ladder, challenger, opponent: ladder[mid], lo, hi, played,
          waiting: ids.slice(i + 1), atMost: played + left,
        };
      }
      if (answers[played++] === challenger) hi = mid;
      else lo = mid + 1;
    }
    ladder.splice(lo, 0, challenger);
  }
  return { done: true, order: ladder, played, atMost: played };
}

/** The most matches a group of n albums can take (the brief's 5-way tie: 8, where every pair would be 10). */
export function maxMatches(n) {
  let total = 0;
  for (let k = 2; k <= n; k++) total += Math.ceil(Math.log2(k));
  return total;
}

const pad = (n, width) => String(n).padStart(width, "0");

/**
 * Unique ranks for every album: ties ordered by `tiebreak` (page ids), the rest bumped down to make room,
 * optionally renumbered 1..N. Rows come back in the new order with before/after and how far each one moved
 * (`delta` > 0 is up).
 */
export function planRanks(albums, tiebreak, compact) {
  const position = new Map(tiebreak.map((id, i) => [id, i]));
  const at = (a) => position.get(a.id) ?? position.size;
  const rated = albums.filter((a) => a.rank != null).sort((a, b) => a.rank - b.rank || at(a) - at(b));

  let last = 0;
  let ordered = rated.map((a) => {
    last = a.rank > last ? a.rank : last + 1;
    return [a, last];
  });
  if (compact) ordered = ordered.map(([a], i) => [a, i + 1]);
  const width = ordered.length && (ordered[ordered.length - 1][1] > 99 || ordered.length > 99) ? 3 : 2;
  return ordered.map(([a, rank]) => ({
    ...a,
    after: pad(rank, width),
    afterNum: rank,
    delta: a.rank - rank,
    changed: pad(rank, width) !== a.rank_text,
  }));
}

export function loadAnswers() {
  try {
    // picks saved before the rank was left out of the key ("64:id,id") carry over
    const saved = JSON.parse(localStorage.getItem(ANSWERS) || "{}");
    return Object.fromEntries(Object.entries(saved).map(([key, winners]) => [key.replace(/^\d+:/, ""), winners]));
  } catch {
    return {};
  }
}
export function saveAnswers(answers) {
  try {
    localStorage.setItem(ANSWERS, JSON.stringify(answers));
  } catch {
    // storage blocked: the playoffs just start over next visit
  }
}
