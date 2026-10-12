import { useWorld } from "../world";

// A pomegranate seed hidden in the scenery (Persephone ate six). `x`/`y` place it in its scene, in percent.
export default function Seed({ id, x, y }) {
  const { seeds, findSeed } = useWorld();
  if (seeds.includes(id)) return null;
  return (
    <button className="seed" style={{ left: `${x}%`, top: `${y}%` }} aria-label="A pomegranate seed" onClick={() => findSeed(id)}>
      <svg viewBox="0 0 10 13" aria-hidden="true" focusable="false">
        <path d="M5 0.5C7.8 3.4 9.5 6.1 9.5 8.4A4.5 4.2 0 0 1 0.5 8.4C0.5 6.1 2.2 3.4 5 0.5Z" />
        <ellipse cx="3.6" cy="6.6" rx="1" ry="1.6" className="seed-shine" />
      </svg>
    </button>
  );
}
