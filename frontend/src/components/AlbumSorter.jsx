import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowCounterClockwiseIcon, ArrowLeftIcon, ArrowRightIcon, CheckIcon } from "@phosphor-icons/react";
import { loadAnswers, maxMatches, planRanks, playoff, saveAnswers, tieGroups } from "../sorter";
import Movements from "./Movements";
import { Cover } from "./Showcase";

// Album sorter. Albums that share an "Alex Top" rank play off in pairs until their order is known (sorter.js picks
// each pair so as few as possible are asked), one shared rank after another. Then Movements shows who goes up or
// down, and Write sends the new ranks to Notion. Answers are kept in this browser until they are written.

const pad = (n) => String(n).padStart(2, "0");
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

function Contender({ album, side, onPick }) {
  return (
    <button className="as-contender" onClick={onPick} aria-label={`${album.name} by ${album.artist} wins (${side} arrow)`}>
      <span className="sc-cover">
        <Cover album={album} eager />
      </span>
      <span className="as-cname">{album.name}</span>
      <span className="as-by">{album.artist}</span>
      <kbd className="as-key" aria-hidden="true">
        {side === "left" ? <ArrowLeftIcon /> : <ArrowRightIcon />}
      </kbd>
    </button>
  );
}

function LadderRow({ album, label, className = "" }) {
  return (
    <li className={`as-rung ${className}`}>
      <span className="as-rank">{label}</span>
      <span className="sc-cover as-thumb">
        <Cover album={album} />
      </span>
      <span className="as-text">
        <span className="as-name">{album.name}</span>
        <span className="as-by">{album.artist}</span>
      </span>
    </li>
  );
}

// `refresh` changes when the library is scanned (reload the ranks); `onStatus` tells the app how many ranks are
// shared and how many of those are still undecided, so the tab is only offered while there are ties.
export default function AlbumSorter({ api, live, hidden, refresh, onStatus }) {
  const [albums, setAlbums] = useState(null);
  const [error, setError] = useState("");
  const [answers, setAnswers] = useState(loadAnswers); // group key -> winners' ids, in order
  const [step, setStep] = useState("playoffs"); // playoffs | movements
  const [picked, setPicked] = useState(null); // a group chosen by hand (or the one just finished)
  const [settled, setSettled] = useState(null); // the album that just found its place, for the slide-in
  const [compact, setCompact] = useState(true); // renumber 1..N without gaps; the option lives under "More options"
  const [writing, setWriting] = useState(false);
  const [result, setResult] = useState(null);

  const load = useCallback(() => {
    setError("");
    api
      .albums()
      .then((r) => setAlbums(r.albums))
      .catch((e) => setError(e.message));
  }, [api]);
  useEffect(load, [load, refresh]);

  const byId = useMemo(() => new Map((albums || []).map((a) => [a.id, a])), [albums]);
  const groups = useMemo(
    () => tieGroups(albums || []).map((g) => ({ ...g, state: playoff(g.ids, answers[g.key] || []) })),
    [albums, answers],
  );
  const open = groups.filter((g) => !g.state.done);
  useEffect(() => {
    if (albums) onStatus?.({ ties: groups.length, open: open.length });
  }, [albums, groups.length, open.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const group = groups.find((g) => g.key === picked) || open[0] || null;
  const tiebreak = groups.filter((g) => g.state.done).flatMap((g) => g.state.order);
  const rows = useMemo(() => planRanks(albums || [], tiebreak, compact), [albums, tiebreak.join(), compact]); // eslint-disable-line react-hooks/exhaustive-deps
  const newRank = new Map(rows.map((r) => [r.id, r.after]));

  const setGroupAnswers = (key, list) =>
    setAnswers((a) => {
      const next = { ...a, [key]: list };
      if (!list.length) delete next[key];
      saveAnswers(next);
      return next;
    });

  const state = group?.state;
  const swap = state && !state.done && state.played % 2 === 1; // the challenger doesn't always stand on the left
  const left = state && !state.done ? (swap ? state.opponent : state.challenger) : null;
  const right = state && !state.done ? (swap ? state.challenger : state.opponent) : null;

  const pick = useCallback(
    (winner) => {
      if (!group || group.state.done) return;
      const list = [...(answers[group.key] || []), winner];
      const after = playoff(group.ids, list);
      setSettled(after.done || after.challenger !== group.state.challenger ? group.state.challenger : null);
      setPicked(group.key); // stay on this tie; once finished it stays on screen to show its order
      setGroupAnswers(group.key, list);
    },
    [group, answers], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const undo = useCallback(() => {
    if (!group) return;
    const list = answers[group.key] || [];
    if (!list.length) return;
    setSettled(null);
    setPicked(group.key);
    setGroupAnswers(group.key, list.slice(0, -1));
  }, [group, answers]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (hidden || step !== "playoffs") return;
    const onKey = (e) => {
      if (e.target.closest?.("input, select, textarea")) return;
      if (e.key === "ArrowLeft" && left) pick(left);
      else if (e.key === "ArrowRight" && right) pick(right);
      else if (e.key === "Backspace") undo();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hidden, step, left, right, pick, undo]);

  const changes = rows.filter((r) => r.changed).length;
  const write = async () => {
    const pending = open.length ? `\n\n${plural(open.length, "tie")} not decided yet will keep Notion’s order.` : "";
    if (!window.confirm(`Write ${plural(changes, "new rank")} to Notion?${pending}`)) return;
    setWriting(true);
    setResult(null);
    try {
      const res = await api.apply({ tiebreak, compact });
      setResult(res);
      setAnswers((a) => {
        const next = { ...a };
        for (const g of groups) if (g.state.done) delete next[g.key];
        saveAnswers(next);
        return next;
      });
      setPicked(null);
      load();
    } catch (e) {
      setResult({ error: e.message });
    } finally {
      setWriting(false);
    }
  };

  const name = (id) => byId.get(id);

  return (
    <section className="as" hidden={hidden} aria-label="Album sorter">
      <div className="seg as-steps" role="group" aria-label="Step">
        <button aria-pressed={step === "playoffs"} onClick={() => setStep("playoffs")}>
          Playoffs
          {groups.length > 0 && (
            <span className="seg-note">
              {groups.length - open.length} of {groups.length} decided
            </span>
          )}
        </button>
        <button aria-pressed={step === "movements"} onClick={() => setStep("movements")}>
          Movements and write
        </button>
      </div>

      {error && (
        <p className="error">
          {error}{" "}
          <button className="link" onClick={load}>
            Try again
          </button>
        </p>
      )}
      {!albums && !error && (
        <p className="note" role="status">
          Loading albums…
        </p>
      )}

      {albums && step === "playoffs" && (
        <>
          <p className="note">
            {groups.length === 0
              ? "Every rank already belongs to one album: there are no ties to play off."
              : `${plural(groups.length, "rank")} ${groups.length === 1 ? "is" : "are"} shared by several albums. Click the better album of each pair, or use the arrow keys. Each pair is chosen so you answer as few as possible. The winner keeps the rank and the others follow it.`}
          </p>

          {groups.length > 0 && (
            <div className="as-groups" role="group" aria-label="Ties">
              {groups.map((g) => (
                <button
                  key={g.key}
                  className={`chip${g.state.done ? " done" : ""}`}
                  aria-pressed={g === group}
                  onClick={() => setPicked(g.key)}
                >
                  {g.state.done && (
                    <>
                      <CheckIcon aria-hidden="true" weight="bold" />
                      <span className="sr-only">Decided: </span>
                    </>
                  )}
                  Rank {pad(g.rank)}, {g.ids.length} albums
                </button>
              ))}
            </div>
          )}

          {group && !state.done && (
            <div className="as-arena">
              <div className="as-match plaque">
                <p className="as-progress">
                  Rank {pad(group.rank)}, match {state.played + 1}
                  <span className="as-dim"> of at most {state.atMost} for this tie</span>
                </p>
                {/* keyed by match so each new pair rises in */}
                <div className="as-pair" key={`${group.key}-${state.played}`}>
                  <Contender album={name(left)} side="left" onPick={() => pick(left)} />
                  <span className="as-vs" aria-hidden="true">
                    or
                  </span>
                  <Contender album={name(right)} side="right" onPick={() => pick(right)} />
                </div>
                <div className="as-match-actions">
                  <button className="ghost" onClick={undo} disabled={!(answers[group.key] || []).length}>
                    <ArrowCounterClockwiseIcon aria-hidden="true" />
                    Undo
                  </button>
                  <span className="as-dim">
                    <kbd>Backspace</kbd> undoes too
                  </span>
                </div>
              </div>

              <aside className="as-ladder">
                <h2>Order so far</h2>
                <p className="as-dim">
                  <strong>{name(state.challenger).name}</strong> lands somewhere in the highlighted part.
                </p>
                <ol>
                  {state.ladder.map((id, i) => (
                    <LadderRow
                      key={id}
                      album={name(id)}
                      label={pad(group.rank + i)}
                      className={[
                        i >= state.lo && i < state.hi ? "range" : "",
                        id === state.opponent ? "facing" : "",
                        id === settled ? "new" : "",
                      ].join(" ")}
                    />
                  ))}
                </ol>
                {state.waiting.length > 0 && (
                  <p className="as-dim as-waiting">
                    Still to play: {state.waiting.map((id) => name(id).name).join(", ")}
                  </p>
                )}
              </aside>
            </div>
          )}

          {group && state.done && (
            <div className="as-decided plaque">
              <h2>Rank {pad(group.rank)} is decided</h2>
              <p className="as-dim">
                {plural(state.played, "match", "matches")} (never more than {maxMatches(group.ids.length)} for {group.ids.length} albums). New ranks:
              </p>
              <ol className="as-final">
                {state.order.map((id, i) => (
                  <LadderRow key={id} album={name(id)} label={newRank.get(id)} className={`${i === 0 ? "winner" : ""} ${id === settled ? "new" : ""}`} />
                ))}
              </ol>
              <div className="as-match-actions">
                {open.length > 0 ? (
                  <button onClick={() => setPicked(open[0].key)}>
                    Next tie: rank {pad(open[0].rank)}, {open[0].ids.length} albums
                  </button>
                ) : (
                  <button onClick={() => setStep("movements")}>See the movements</button>
                )}
                <button className="ghost" onClick={() => undo()}>
                  <ArrowCounterClockwiseIcon aria-hidden="true" />
                  Undo last pick
                </button>
                <button className="ghost" onClick={() => setGroupAnswers(group.key, [])}>
                  Play this tie again
                </button>
              </div>
            </div>
          )}

          {groups.length === 0 && (
            <button onClick={() => setStep("movements")}>See the ranking</button>
          )}
        </>
      )}

      {albums && step === "movements" && (
        <>
          {open.length > 0 && (
            <p className="as-warn">
              {plural(open.length, "rank")} still {open.length === 1 ? "is" : "are"} shared by several albums and not
              played off yet (ranks {open.map((g) => pad(g.rank)).join(", ")}). Until you do, Notion’s own order decides
              which album of each tie goes first.{" "}
              <button className="link" onClick={() => setStep("playoffs")}>
                Play them off
              </button>
            </p>
          )}
          <Movements rows={rows} />

          <div className="as-write">
            <p>
              {changes > 0
                ? `${plural(changes, "album")} get${changes === 1 ? "s" : ""} a new rank in Notion.`
                : "Nothing to write: Notion already has these ranks."}
              {!live && " Demo: this only changes the sample albums on this page."}
            </p>
            <button className={live ? "danger" : ""} onClick={write} disabled={!changes || writing}>
              {writing ? "Writing…" : `Write ${plural(changes, "rank")} to Notion`}
            </button>
            {result?.error && (
              <p className="error" role="alert">
                {result.error}
              </p>
            )}
            {result && !result.error && (
              <p className="as-dim" role="status">
                Wrote {plural(result.written, "rank")}
                {result.failed ? `, ${result.failed} failed (see below)` : ""}.
              </p>
            )}
            {result?.failed > 0 && <pre className="log">{result.log.join("\n")}</pre>}
            <details className="as-more">
              <summary>More options</summary>
              <label className="check">
                <input type="checkbox" checked={compact} onChange={(e) => setCompact(e.target.checked)} />
                Close gaps: renumber every album 1 to {rows.length}, skipping no number
              </label>
              <p className="as-dim">
                On (the default): ranks run 1, 2, 3… with no holes, so every album below the first gap gets a new
                number. Off: albums keep their ranks and only tied albums move down to make room, so a gap (4, then 6)
                stays.
              </p>
            </details>
          </div>
        </>
      )}
    </section>
  );
}
