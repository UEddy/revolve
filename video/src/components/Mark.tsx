// The Revolve mark, drawn from the same geometry as app/src/components/icons.tsx
// (and the kit's SVGs): a broken white ring, and the gold orbit around it with
// its dot. Each part can be drawn on by progress, and the dot can travel the
// orbit. The orbit is two halves, back (under the ring) and front (over it).

import type { CSSProperties } from "react";
import { C } from "../brand";

const ORBIT = "translate(50 50) rotate(-24)";
const RX = 47;
const RY = 21;

export function Mark({
  size,
  ring = 1,
  orbit = 1,
  dot = 1,
  dotAngle = 28,
  ringColor = C.ink,
  style,
}: {
  size: number;
  /** 0..1 draw progress of each part. */
  ring?: number;
  orbit?: number;
  dot?: number;
  /** Where the dot sits on the orbit, in degrees (28 is the logo's position). */
  dotAngle?: number;
  ringColor?: string;
  style?: CSSProperties;
}) {
  const a = (dotAngle * Math.PI) / 180;
  const dx = RX * Math.cos(a);
  const dy = -RY * Math.sin(a);
  // The dot is behind the ring on the far half of the orbit.
  const dotInFront = Math.sin(a) < 0;
  const dash = (p: number) => ({ strokeDasharray: 1, strokeDashoffset: 1 - p });
  const dotEl = <circle transform={ORBIT} cx={dx} cy={dy} r={5.6} fill={C.gold} opacity={dot} />;
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} style={{ overflow: "visible", ...style }} aria-hidden>
      <path transform={ORBIT} d={`M-${RX} 0A${RX} ${RY} 0 0 1 ${RX} 0`} pathLength={1} fill="none" stroke={C.gold} strokeWidth={4.8} strokeLinecap="round" style={dash(Math.min(1, orbit * 2))} />
      {!dotInFront && dotEl}
      <path d="M74.259 67.649A30 30 0 0 1 46.883 79.838" pathLength={1} fill="none" stroke={ringColor} strokeWidth={12} style={dash(ring)} />
      <path d="M26.371 68.485A30 30 0 1 1 79.548 44.809" pathLength={1} fill="none" stroke={ringColor} strokeWidth={12} style={dash(ring)} />
      <path transform={ORBIT} d={`M${RX} 0A${RX} ${RY} 0 0 1 -${RX} 0`} pathLength={1} fill="none" stroke={C.gold} strokeWidth={4.8} strokeLinecap="round" style={dash(Math.max(0, orbit * 2 - 1))} />
      {dotInFront && dotEl}
    </svg>
  );
}
