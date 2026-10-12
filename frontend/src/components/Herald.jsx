import { CalendarPlusIcon } from "@phosphor-icons/react";
import "../herald.css";
import { Cover, formatDate } from "./Showcase";

// The banner for a day that has no Album of the Day yet: Hermes hasn't delivered. Visitors see the wait; the owner is
// asked to pick (`onPick`) and sees how many albums are waiting. The last delivered album stays one click away.

const FEATHERS = [12, -2, -16, -30]; // each wing's feathers fan out by these angles

function Wing() {
  return (
    <g>
      {FEATHERS.map((angle, i) => (
        <ellipse key={angle} cx="52" cy="62" rx={48 - i * 4} ry="7.5" transform={`rotate(${angle} 104 62)`} opacity={1 - i * 0.12} />
      ))}
    </g>
  );
}

/** The day, between two wings. */
function Medallion({ day }) {
  const date = new Date(`${day}T12:00:00`);
  return (
    <span className="herald-medal" role="img" aria-label={date.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}>
      <svg viewBox="0 0 220 124" aria-hidden="true">
        <Wing />
        <g transform="translate(220 0) scale(-1 1)">
          <Wing />
        </g>
      </svg>
      <span className="herald-disc">
        <span className="herald-month">{date.toLocaleDateString(undefined, { month: "short" })}</span>
        <span className="herald-num">{date.getDate()}</span>
        <span className="herald-weekday">{date.toLocaleDateString(undefined, { weekday: "short" })}</span>
      </span>
    </span>
  );
}

// `day` is today (YYYY-MM-DD), `waiting` how many albums wait to be listened to, `latest` the last delivered album.
export default function Herald({ day, owner, waiting, latest, onPick, onOpenLatest }) {
  return (
    <section className="sc-herald" aria-label="Album of the Day">
      <Medallion day={day} />
      <div className="herald-text">
        <span className="sc-kicker">Album of the Day</span>
        <h2>{owner ? "Hermes awaits your word" : "Hermes is on his way"}</h2>
        <p>
          {owner
            ? "Choose what to listen to today and he will carry it to the Hall."
            : "Today’s album hasn’t been delivered yet. Come back soon."}
          {owner && waiting > 0 && ` ${waiting} ${waiting === 1 ? "album is" : "albums are"} waiting for you.`}
        </p>
        {owner && (
          <button className="sc-pick" onClick={onPick}>
            <CalendarPlusIcon aria-hidden="true" />
            Pick today’s Album of the Day
          </button>
        )}
      </div>
      {latest && (
        <button className="herald-last" onClick={onOpenLatest} aria-label={`Open ${latest.name}, the last album delivered`}>
          <span className="herald-last-label">Last delivered</span>
          <span className="sc-cover herald-last-cover">
            <Cover album={latest} />
          </span>
          <span className="herald-last-name">{latest.name}</span>
          <span className="sc-dim">{latest.artist}</span>
          <span className="sc-dim">
            {formatDate(latest.album_of_day)}
            {latest.rank != null ? ` · No. ${latest.rank}` : ""}
          </span>
        </button>
      )}
    </section>
  );
}
