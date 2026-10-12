import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowCounterClockwiseIcon, ArrowLeftIcon, ArrowRightIcon, MusicNotesIcon, TrophyIcon, XIcon } from "@phosphor-icons/react";
import { sorterApi } from "../api";
import { LandingZone, Rounds, Songs, Swords, Victor } from "./Battle";
import { Cover } from "./Showcase";

// Owner only: a popup that ranks the Album of the Day, opened by clicking it in the Hall.
//   1. Estimate (optional): a rough guess at its rank, typed before anything is compared.
//   2. Questions: it faces the albums I've ranked, one pair at a time. Each answer halves the places it could take
//      (binary insertion, like Purgatory's playoffs), so 187 albums need at most 8 answers. The estimate stays on
//      screen, locked, while this runs.
//   3. Choose: the ranker's pick, my estimate, or another rank. Then the server slots the album in (renumbering
//      pages whose rank changes.
// Each question is a battle: the Album of the Day (the challenger) against one of my ranked albums (the defender).
// Ranks are the real "Alex Top" numbers you see in the Hall. Placing at No. R gives the album that number and moves
// down only the albums in its way (R, R+1... up to the first free number; a tie moves together). Nothing else changes:
// ties stay ties and gaps stay gaps, those are Purgatory's business.

const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const questionsFor = (n) => Math.ceil(Math.log2(n + 1)); // the most answers a search among n albums can take
const SONGS = "mh-rank-songs"; // whether the battle shows each fighter's songs, remembered in this browser
const VERDICT_MS = 520; // how long the winner of a round is shown before the next round

const savedSongs = () => {
  try {
    return localStorage.getItem(SONGS) === "1";
  } catch {
    return false;
  }
};
const calm = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

// `album` is today's album; `onRanked` gets the server's answer: { ranks: { page id: new rank }, listened: [ids] }.
export default function RankDialog({ album, onRanked, onClose }) {
  const dialog = useRef(null);
  const [ranked, setRanked] = useState(null); // albums that have a rank, best first
  const [step, setStep] = useState("estimate"); // estimate | compare | choose | done
  const [guess, setGuess] = useState(""); // the typed estimate, locked once the questions start
  const [span, setSpan] = useState([0, 0]); // [lo, hi): the places it could still take (indexes into `ranked`)
  const [trail, setTrail] = useState([]); // earlier spans, for Undo
  const [choice, setChoice] = useState("ranker"); // ranker | guess | other
  const [other, setOther] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [placed, setPlaced] = useState(null); // the answer once written
  const [songs, setSongs] = useState(savedSongs); // show each fighter's songs
  const [verdict, setVerdict] = useState(null); // left | right while a round's winner is shown
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  useEffect(() => {
    const el = dialog.current;
    if (el && !el.open) el.showModal();
  }, []);
  useEffect(() => {
    let live = true;
    sorterApi
      .albums()
      .then(({ albums }) => live && setRanked(albums.filter((a) => a.id !== album.id).sort((a, b) => a.rank - b.rank)))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [album.id]);

  // close and unmount right away; the dialog's own close event (Escape) calls onClose too, which is harmless twice
  const close = () => {
    dialog.current?.close();
    onClose();
  };

  const count = ranked?.length ?? 0;
  const last = (ranked?.[count - 1]?.rank ?? 0) + 1; // the last rank it can take: right after the lowest one
  const rankAt = (slot) => (slot < count ? ranked[slot].rank : last); // the rank it gets in slot 0..count (just above that album)
  const slotOf = (rank) => {
    const i = ranked.findIndex((a) => a.rank >= rank);
    return i === -1 ? count : i;
  };
  const valid = (text) => {
    const n = Number(text);
    return text !== "" && Number.isInteger(n) && n >= 1 && n <= last ? n : null;
  };
  const guessPlace = valid(guess);
  const [lo, hi] = span;
  const comparing = step === "compare" && lo < hi;
  const mid = comparing ? (lo + hi) >> 1 : null;
  const opponent = comparing ? ranked[mid] : null;
  const rankerPlace = step === "choose" && lo === hi && trail.length > 0 ? rankAt(lo) : null;

  const chosen = { ranker: rankerPlace, guess: guessPlace, other: valid(other) }[choice];
  const describe = (rank) => {
    const next = ranked.find((a) => a.rank >= rank); // the album that ends up right below it
    if (!next) return count ? `last, below ${ranked[count - 1].name}` : "the first album you rank";
    return next.rank === rank ? `just above ${next.name}` : `in a free spot above ${next.name}`;
  };
  // the albums in its way: the ranks from `rank` up to the first free number move down one place, ties together
  const inTheWay = (rank) => {
    const taken = new Set(ranked.map((a) => a.rank));
    let free = rank;
    while (taken.has(free)) free += 1;
    return ranked.filter((a) => a.rank >= rank && a.rank < free).length;
  };

  const begin = () => {
    setSpan([0, count]);
    setTrail([]);
    setStep(count ? "compare" : "choose");
    setChoice(guessPlace ? "guess" : "other"); // with no albums to compare, there is no ranker's pick
  };
  const skip = () => {
    setSpan([0, 0]);
    setTrail([]);
    setChoice("guess");
    setStep("choose");
  };

  // better = true: today's album beats the opponent, so it goes above it. The winner shows for a beat, then the next round.
  const answer = useCallback(
    (better) => {
      if (!comparing || verdict) return;
      const next = better ? [lo, mid] : [mid + 1, hi];
      const apply = () => {
        setVerdict(null);
        setTrail((t) => [...t, span]);
        setSpan(next);
        if (next[0] === next[1]) {
          setChoice("ranker");
          setStep("choose");
        }
      };
      setVerdict(better ? "left" : "right");
      timer.current = setTimeout(apply, calm() ? 0 : VERDICT_MS);
    },
    [comparing, verdict, span, lo, hi, mid],
  );
  const undo = useCallback(() => {
    if (!trail.length || verdict) return;
    setSpan(trail[trail.length - 1]);
    setTrail((t) => t.slice(0, -1));
    setStep("compare");
  }, [trail, verdict]);

  const toggleSongs = () => {
    setSongs((on) => {
      try {
        localStorage.setItem(SONGS, on ? "0" : "1");
      } catch {
        // storage blocked: it just resets next visit
      }
      return !on;
    });
  };

  useEffect(() => {
    if (!comparing) return;
    const onKey = (e) => {
      if (e.target.closest?.("input, select, textarea")) return;
      if (e.key === "ArrowLeft") answer(true);
      else if (e.key === "ArrowRight") answer(false);
      else if (e.key === "Backspace") undo();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [comparing, answer, undo]);

  const write = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await sorterApi.place({ id: album.id, rank: chosen });
      onRanked(res);
      setPlaced({ ...res, rank: chosen });
      setStep("done");
      if (res.failed) setError(`${plural(res.failed, "rank")} couldn’t be written:\n${res.log.join("\n")}`);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

    const estimateNote = guess !== "" && guessPlace === null ? `Use a whole number from 1 to ${last}.` : "";

  return (
    <dialog
      ref={dialog}
      className="sc-detail rank-dialog"
      aria-label={`Rank ${album.name}`}
      onClose={onClose}
      onClick={(e) => e.target === dialog.current && close()}
    >
      <div className="rank-body">
        <button className="icon-btn sc-x" onClick={close} aria-label="Close">
          <XIcon aria-hidden="true" />
        </button>
        <header className="rank-head">
          <span className="sc-cover rank-thumb">
            <Cover album={album} eager />
          </span>
          <span>
            <span className="sc-kicker">Album of the Day: battle for a rank</span>
            <h2>{album.name}</h2>
            <span className="sc-artist">{album.artist}</span>
          </span>
        </header>

        {!ranked && !error && (
          <p className="note" role="status">
            Loading your ranking…
          </p>
        )}

        {ranked && step !== "estimate" && step !== "done" && (
          <p className="rank-locked">
            <span className="as-dim">My estimate</span>{" "}
            <strong>{guessPlace ? `No. ${guessPlace}` : "none"}</strong>
            <span className="as-dim"> (locked)</span>
          </p>
        )}

        {ranked && step === "estimate" && (
          <div className="rank-step">
            <label className="field rank-guess">
              <span>Rough estimate (optional)</span>
              <input
                type="number"
                min={1}
                max={last}
                inputMode="numeric"
                placeholder={`1 to ${last}`}
                value={guess}
                onChange={(e) => setGuess(e.target.value)}
                autoFocus
              />
            </label>
            <p className="as-dim">
              Where do you think it will rank, from No. 1 (best) to No. {last}? Write it down first. Then the ranker
              compares it with your other albums, up to {plural(questionsFor(count), "round")}, and you pick which
              answer to keep: its pick, your estimate, or another rank.
            </p>
            {estimateNote && <p className="error">{estimateNote}</p>}
            <div className="as-match-actions">
              <button onClick={begin} disabled={guess !== "" && guessPlace === null}>
                Start comparing
              </button>
              <button className="ghost" onClick={skip} disabled={guessPlace === null} title="Use my estimate without the questions">
                Skip the questions
              </button>
            </div>
          </div>
        )}

        {comparing && (
          <div className="rank-step arena">
            <div className="arena-top">
              <p className="as-progress arena-round">
                Round {trail.length + 1}
                <span className="as-dim"> of at most {trail.length + questionsFor(hi - lo)}</span>
              </p>
              <Rounds fought={trail.length} atMost={questionsFor(hi - lo)} />
              <button className="ghost arena-songs-toggle" aria-pressed={songs} onClick={toggleSongs}>
                <MusicNotesIcon aria-hidden="true" />
                Songs
              </button>
            </div>
            <LandingZone lo={lo} hi={hi} slots={count + 1} from={rankAt(lo)} to={rankAt(hi)} estimateSlot={guessPlace ? slotOf(guessPlace) : null} estimateRank={guessPlace} />
            <p className="arena-ask">Which album do you rank higher?</p>
            <div className={`as-pair arena-pair${verdict ? ` decided ${verdict}` : ""}`} key={`${lo}-${hi}`}>
              <div className={`arena-side${verdict === "left" ? " won" : verdict === "right" ? " lost" : ""}`}>
                <span className="arena-role">Challenger</span>
                <button className="as-contender" disabled={Boolean(verdict)} onClick={() => answer(true)} aria-label={`${album.name} is higher (left arrow)`}>
                  <span className="sc-cover">
                    <Cover album={album} eager />
                  </span>
                  <span className="as-cname">{album.name}</span>
                  <span className="as-by">{album.artist}</span>
                  <kbd className="as-key" aria-hidden="true">
                    <ArrowLeftIcon />
                  </kbd>
                </button>
                {verdict === "left" && <Victor />}
                {songs && <Songs album={album} />}
              </div>
              <span className="as-vs arena-vs" aria-hidden="true">
                <Swords />
                <span>vs</span>
              </span>
              <div className={`arena-side${verdict === "right" ? " won" : verdict === "left" ? " lost" : ""}`}>
                <span className="arena-role">Defender, now No. {opponent.rank}</span>
                <button className="as-contender" disabled={Boolean(verdict)} onClick={() => answer(false)} aria-label={`${opponent.name} is higher (right arrow)`}>
                  <span className="sc-cover">
                    <Cover album={opponent} eager />
                  </span>
                  <span className="as-cname">{opponent.name}</span>
                  <span className="as-by">{opponent.artist}</span>
                  <kbd className="as-key" aria-hidden="true">
                    <ArrowRightIcon />
                  </kbd>
                </button>
                {verdict === "right" && <Victor />}
                {songs && <Songs album={opponent} />}
              </div>
            </div>
            <div className="as-match-actions">
              <button className="ghost" onClick={undo} disabled={!trail.length || Boolean(verdict)}>
                <ArrowCounterClockwiseIcon aria-hidden="true" />
                Undo
              </button>
              <span className="as-dim">Arrow keys choose the victor, Backspace undoes.</span>
            </div>
          </div>
        )}

        {ranked && step === "choose" && (
          <div className="rank-step">
            <p className="as-progress arena-verdict">
              <TrophyIcon weight="fill" aria-hidden="true" />
              The battle is over. Which rank do you keep?
            </p>
            <div className="rank-options" role="radiogroup" aria-label="Rank to keep">
              {rankerPlace && (
                <label className={`rank-option${choice === "ranker" ? " on" : ""}`}>
                  <input type="radio" name="rank" checked={choice === "ranker"} onChange={() => setChoice("ranker")} />
                  <span>
                    <strong>The ranker’s pick: No. {rankerPlace}</strong>
                    <span className="as-dim">{describe(rankerPlace)}</span>
                  </span>
                </label>
              )}
              {guessPlace && (
                <label className={`rank-option${choice === "guess" ? " on" : ""}`}>
                  <input type="radio" name="rank" checked={choice === "guess"} onChange={() => setChoice("guess")} />
                  <span>
                    <strong>My estimate: No. {guessPlace}</strong>
                    <span className="as-dim">
                      {describe(guessPlace)}
                      {rankerPlace && (guessPlace === rankerPlace ? " · same as the ranker’s pick" : ` · ${plural(Math.abs(guessPlace - rankerPlace), "rank")} from the ranker’s pick`)}
                    </span>
                  </span>
                </label>
              )}
              <label className={`rank-option${choice === "other" ? " on" : ""}`}>
                <input type="radio" name="rank" checked={choice === "other"} onChange={() => setChoice("other")} />
                <span>
                  <strong>Another rank</strong>
                  <input
                    type="number"
                    min={1}
                    max={last}
                    inputMode="numeric"
                    placeholder={`1 to ${last}`}
                    aria-label="Another rank"
                    value={other}
                    onFocus={() => setChoice("other")}
                    onChange={(e) => {
                      setOther(e.target.value);
                      setChoice("other");
                    }}
                  />
                  {choice === "other" && chosen && <span className="as-dim">{describe(chosen)}</span>}
                </span>
              </label>
            </div>
            <p className="as-dim">
              {chosen
                ? inTheWay(chosen)
                  ? `It becomes No. ${chosen}. ${plural(inTheWay(chosen), "album")} from No. ${chosen} down move one place to make room (a tie moves together), and nothing else changes.`
                  : `It becomes No. ${chosen}. Nothing else moves.`
                : ""}
              {album.status === "In progress" && " It is also marked Listened."}
            </p>
            <div className="as-match-actions">
              <button onClick={write} disabled={busy || !chosen}>
                {busy ? "Writing…" : chosen ? `Write No. ${chosen} to Notion` : "Pick a rank"}
              </button>
              {trail.length > 0 && (
                <button className="ghost" onClick={undo} disabled={busy}>
                  <ArrowCounterClockwiseIcon aria-hidden="true" />
                  Undo last answer
                </button>
              )}
            </div>
          </div>
        )}

        {step === "done" && placed && (
          <div className="rank-step">
            <p className="as-progress arena-verdict">
              <TrophyIcon weight="fill" aria-hidden="true" />
              Ranked No. {placed.rank}. {plural(placed.written, "page")} updated in Notion
              {placed.failed ? `, ${placed.failed} failed` : ""}.
            </p>
            <div className="as-match-actions">
              <button onClick={close}>Done</button>
            </div>
          </div>
        )}

        {error && (
          <p className="error" role="alert" style={{ whiteSpace: "pre-wrap" }}>
            {error}
          </p>
        )}
      </div>
    </dialog>
  );
}
