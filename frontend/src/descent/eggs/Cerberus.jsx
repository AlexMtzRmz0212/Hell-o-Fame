import { useWorld } from "../world";

// The three-headed dog at the gate of the House of Hades. Each head has its own reaction when you point at it
// (blink, pant, yawn); click to pet him, he lies down and the gate opens for the rest of the visit.
export default function Cerberus() {
  const { petted, pet } = useWorld();
  return (
    <button
      className={`cerberus${petted ? " petted" : ""}`}
      onClick={pet}
      aria-label={petted ? "Cerberus, petted and asleep" : "Pet Cerberus"}
      aria-pressed={petted}
    >
      <svg viewBox="0 0 160 110" aria-hidden="true" focusable="false">
        <ellipse cx="86" cy="86" rx="56" ry="20" fill="#553034" />
        <path d="M138 80q18 -6 14 -26" stroke="#553034" strokeWidth="7" fill="none" strokeLinecap="round" className="tail" />
        <rect x="44" y="90" width="12" height="18" rx="5" fill="#42262A" />
        <rect x="110" y="90" width="12" height="18" rx="5" fill="#42262A" />
        {[
          { cx: 42, cy: 52, k: "blink" },
          { cx: 80, cy: 38, k: "pant" },
          { cx: 118, cy: 52, k: "yawn" },
        ].map(({ cx, cy, k }) => (
          <g key={k} className={`head head-${k}`} style={{ transformOrigin: `${cx}px ${cy + 30}px` }}>
            <path d={`M${cx - 6} ${cy + 28}L${cx - 4} ${cy + 6}L${cx + 4} ${cy + 6}L${cx + 6} ${cy + 28}Z`} fill="#553034" />
            <path d={`M${cx - 14} ${cy - 8}l4 -14l8 10zM${cx + 14} ${cy - 8}l-4 -14l-8 10z`} fill="#42262A" />
            <circle cx={cx} cy={cy} r="16" fill="#553034" />
            <ellipse cx={cx} cy={cy + 9} rx="9" ry="6" fill="#42262A" />
            <g className="eyes" style={{ transformOrigin: `${cx}px ${cy - 3}px` }}>
              <circle cx={cx - 6} cy={cy - 3} r="2.6" fill="#F06A43" />
              <circle cx={cx + 6} cy={cy - 3} r="2.6" fill="#F06A43" />
            </g>
            <path className="sleep" d={`M${cx - 9} ${cy - 3}h6M${cx + 3} ${cy - 3}h6`} stroke="#F06A43" strokeWidth="2" strokeLinecap="round" />
            {k === "pant" && <path className="tongue" d={`M${cx - 3} ${cy + 13}h6v7a3 3 0 0 1 -6 0z`} fill="#E0607A" />}
            {k === "yawn" && <ellipse className="mouth" cx={cx} cy={cy + 12} rx="4" ry="3" fill="#120809" />}
          </g>
        ))}
      </svg>
    </button>
  );
}
