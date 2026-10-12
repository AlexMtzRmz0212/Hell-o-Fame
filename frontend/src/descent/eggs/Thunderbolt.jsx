import { useState } from "react";
import { useWorld, reducedMotion } from "../world";

// A thunderbolt half-hidden in a dark cloud in the sky. Clicking it throws a bolt down the page with two soft
// flashes (well under the three-per-second limit for flashing); with reduced motion, the bolt just appears.
export default function Thunderbolt() {
  const { say } = useWorld();
  const [strike, setStrike] = useState(0);

  const throwBolt = () => {
    setStrike((n) => n + 1);
    say("Zeus is listening.");
  };

  return (
    <>
      <button className="thunder" onClick={throwBolt} aria-label="A thunderbolt">
        <svg viewBox="0 0 120 70" aria-hidden="true" focusable="false">
          <path className="thunder-bolt" d="M66 34L54 52H64L56 68L78 44H67L74 34Z" fill="#F7C548" />
          <g fill="#8E9DAE">
            <ellipse cx="38" cy="30" rx="26" ry="16" />
            <ellipse cx="64" cy="22" rx="28" ry="20" />
            <ellipse cx="88" cy="32" rx="24" ry="14" />
            <rect x="20" y="30" width="86" height="14" rx="7" />
          </g>
        </svg>
      </button>
      {strike > 0 && (
        <div key={strike} className={`zeus${reducedMotion() ? " still" : ""}`} aria-hidden="true" onAnimationEnd={() => setStrike(0)}>
          <svg viewBox="0 0 100 400" preserveAspectRatio="none">
            <path d="M58 0L40 120H56L30 250H50L22 400L72 210H52L80 90H62L74 0Z" />
          </svg>
        </div>
      )}
    </>
  );
}
