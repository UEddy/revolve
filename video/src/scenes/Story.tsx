// "Every wallet tells a story." One address types on; glowing lines branch to
// what it did and who watches it, and the graph grows until it fills the frame.
// The graph is also used by the next scene, collapsing into the shield.

import { AbsoluteFill, interpolate, random, useCurrentFrame } from "remotion";
import { C, EASE, EASE_IO, FONT, clamp } from "../brand";
import { KeyText } from "../components/KeyText";
import { Shell, s } from "../components/Shell";
import { scene } from "../timeline";

const CX = 960;
const CY = 500;
export const ADDRESS = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";

type Node = { x: number; y: number; level: number; parent: number; label?: string };

const FIRST = [
  { a: -160, label: "Bought a memecoin" },
  { a: -105, label: "Exchange deposit" },
  { a: -35, label: "A copytrader follows" },
  { a: 35, label: "Paid a friend" },
  { a: 110, label: "Same time, every week" },
  { a: 165, label: "Bridged from Zcash" },
];

/** A fixed, seeded graph: six first-level branches, then two more levels fanning out. */
export const NODES: Node[] = (() => {
  const out: Node[] = [{ x: CX, y: CY, level: 0, parent: -1 }];
  FIRST.forEach((f, i) => {
    const r = (f.a * Math.PI) / 180;
    out.push({ x: CX + Math.cos(r) * 360, y: CY + Math.sin(r) * 250, level: 1, parent: 0, label: f.label });
    const p1 = out.length - 1;
    for (let j = 0; j < 3; j++) {
      const r2 = r + (j - 1) * 0.42 + (random(`a${i}${j}`) - 0.5) * 0.2;
      out.push({ x: out[p1]!.x + Math.cos(r2) * 260, y: out[p1]!.y + Math.sin(r2) * 190, level: 2, parent: p1 });
      const p2 = out.length - 1;
      for (let k = 0; k < 2; k++) {
        const r3 = r2 + (k - 0.5) * 0.6 + (random(`b${i}${j}${k}`) - 0.5) * 0.3;
        out.push({ x: out[p2]!.x + Math.cos(r3) * 230, y: out[p2]!.y + Math.sin(r3) * 170, level: 3, parent: p2 });
      }
    }
  });
  return out;
})();

/** grow: 0..1 per level (typing done at 0); collapse: 0..1 pulls everything into the centre. */
export function Graph({ grow, collapse = 0, zoom = 1 }: { grow: [number, number, number]; collapse?: number; zoom?: number }) {
  const pos = (n: Node) => ({ x: n.x + (CX - n.x) * collapse, y: n.y + (CY - n.y) * collapse });
  return (
    <svg width={1920} height={1080} style={{ position: "absolute", inset: 0, scale: String(zoom), transformOrigin: `${CX}px ${CY}px`, opacity: 1 - collapse * 0.9 }}>
      <defs>
        <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="3.5" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <g filter="url(#glow)">
        {NODES.slice(1).map((n, i) => {
          const p = NODES[n.parent]!;
          const g = grow[n.level - 1]!;
          // Siblings start a little apart, so branches don't all appear at once.
          const local = Math.max(0, Math.min(1, g * 1.4 - (i % 6) * 0.07));
          const a = pos(p);
          const b = pos(n);
          return (
            <g key={i} opacity={local > 0 ? 1 : 0}>
              <line x1={a.x} y1={a.y} x2={a.x + (b.x - a.x) * local} y2={a.y + (b.y - a.y) * local} stroke={C.ink} strokeOpacity={0.55 - n.level * 0.1} strokeWidth={2.2 - n.level * 0.4} />
              <circle cx={b.x} cy={b.y} r={(7 - n.level * 1.5) * (local >= 1 ? 1 : 0)} fill={C.ink} fillOpacity={0.9 - n.level * 0.2} />
            </g>
          );
        })}
      </g>
      {NODES.filter((n) => n.label).map((n, i) => {
        const g = grow[0];
        const o = Math.max(0, Math.min(1, (g - 0.55 - i * 0.05) * 3)) * (1 - collapse);
        const b = pos(n);
        const left = b.x < CX;
        return (
          <text key={n.label} x={b.x + (left ? -18 : 18)} y={b.y - 16} textAnchor={left ? "end" : "start"} fill={C.dim} opacity={o} style={{ font: `400 25px ${FONT.body}` }}>
            {n.label}
          </text>
        );
      })}
    </svg>
  );
}

export function Address({ typed, opacity = 1 }: { typed: number; opacity?: number }) {
  const n = Math.floor(ADDRESS.length * typed);
  return (
    <div style={{ position: "absolute", left: 0, right: 0, top: CY - 26, textAlign: "center", opacity }}>
      <span style={{ font: `400 34px ${FONT.mono}`, color: C.ink, padding: "8px 20px", background: C.bg, borderRadius: 12 }}>
        {ADDRESS.slice(0, n)}
        <span style={{ opacity: typed < 1 ? 1 : 0 }}>▍</span>
      </span>
    </div>
  );
}

export function Story() {
  const frame = useCurrentFrame();
  const sc = scene("story");
  const g = (a: number, b: number) => interpolate(frame, [s(a), s(b)], [0, 1], { ...clamp, easing: EASE_IO });
  return (
    <Shell>
      <AbsoluteFill>
        <Graph grow={[g(1.2, 2.9), g(2.6, 4.6), g(4.2, 6.6)]} zoom={interpolate(frame, [s(1.2), sc.duration], [1, 1.32], { ...clamp, easing: EASE })} />
        <Address typed={interpolate(frame, [s(0.2), s(1.2)], [0, 1], clamp)} />
      </AbsoluteFill>
      <KeyText text="Every wallet tells a story." at={sc.cue(0)} style={{ position: "absolute", bottom: 110, left: 0, right: 0, textAlign: "center" }} size={64} />
    </Shell>
  );
}
