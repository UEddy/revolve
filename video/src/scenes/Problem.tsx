// "Zcash was built to keep that story private... Every route out of Zcash
// today deshields." The graph collapses into a shield; a red line leaks out of
// it; then the real NEAR Intents swap made from Zodl, as the explorer shows it,
// with the exposed amount, time and destination marked in red.

import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { C, EASE, EASE_IO, clamp } from "../brand";
import { TX, TxCard } from "../components/Evidence";
import { KeyText } from "../components/KeyText";
import { Shell, s } from "../components/Shell";
import { IMAGES, scene } from "../timeline";
import { Graph } from "./Story";

const SHIELD = "M50 4 L88 18 V48 C88 72 72 88 50 96 C28 88 12 72 12 48 V18 Z";

export function Shield({ draw, x, y, size, leak = 0 }: { draw: number; x: number; y: number; size: number; leak?: number }) {
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} style={{ position: "absolute", left: x - size / 2, top: y - size / 2, overflow: "visible" }}>
      <path d={SHIELD} pathLength={1} fill="none" stroke={C.ink} strokeWidth={2.4} strokeLinejoin="round" style={{ strokeDasharray: 1, strokeDashoffset: 1 - draw }} />
      <path d="M36 50 L46 60 L66 40" pathLength={1} fill="none" stroke={C.ink} strokeOpacity={0.7} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" style={{ strokeDasharray: 1, strokeDashoffset: 1 - Math.max(0, draw * 2 - 1) }} />
      {leak > 0 && <path d="M88 50 L 302 50" pathLength={1} fill="none" stroke={C.red} strokeWidth={2.4} strokeLinecap="round" style={{ strokeDasharray: 1, strokeDashoffset: 1 - leak }} />}
    </svg>
  );
}

export const nearRows = [
  { label: "Transaction", value: TX.nearDeshield.hash, mono: true },
  { label: "Block", value: TX.nearDeshield.block },
  { label: "Time", value: TX.nearDeshield.time, tone: "red" as const },
  { label: "Type", value: TX.nearDeshield.type, tone: "red" as const },
  { label: "Paid out to", value: TX.nearDeshield.to, mono: true, tone: "red" as const },
  { label: "Amount", value: TX.nearDeshield.amount, tone: "red" as const },
];

export function Problem() {
  const frame = useCurrentFrame();
  const sc = scene("problem");
  const p = (a: number, b: number, e = EASE) => interpolate(frame, [a, b], [0, 1], { ...clamp, easing: e });
  const collapse = p(s(0.1), s(1.6), EASE_IO);
  const moveLeft = p(sc.cue(1), sc.cue(1) + s(1.2), EASE_IO);
  const cardIn = p(sc.cue(2), sc.cue(2) + s(0.9));
  const shieldX = 960 - 560 * moveLeft;
  return (
    <Shell>
      <AbsoluteFill>
        {collapse < 1 && <Graph grow={[1, 1, 1]} collapse={collapse} zoom={1.32 - 0.32 * collapse} />}
        <Shield draw={p(s(1.0), s(2.6))} x={shieldX} y={500} size={240 - 40 * moveLeft} leak={p(sc.cue(1) + s(1.6), sc.cue(1) + s(3.2))} />
      </AbsoluteFill>
      <div style={{ position: "absolute", right: 110, top: 300, opacity: cardIn, translate: `${(1 - cardIn) * 60}px 0` }}>
        <TxCard
          title="NEAR Intents swap, from Zodl"
          source={TX.nearDeshield.source}
          rows={nearRows}
          width={900}
          screenshot={IMAGES.explorerNear}
          highlight={{ 5: sc.cue(3), 2: sc.cue(4), 3: sc.cue(5), 4: sc.cue(5) }}
          glow={sc.cue(6)}
        />
      </div>
      <KeyText text="Every route out deshields." at={sc.cue(2)} style={{ position: "absolute", top: 120, left: 110 }} size={68} />
      <KeyText text="In public. Forever." at={sc.cue(5)} style={{ position: "absolute", top: 210, left: 110 }} size={44} color={C.dim} />
    </Shell>
  );
}
