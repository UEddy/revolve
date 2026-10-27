// The Revolve wordmark from the brand kit (app/src/assets/brand), with its
// letters as drawn in the kit and the mark rendered live in the "o", so the
// orbit can draw itself and the dot can travel.

import type { CSSProperties } from "react";
import brand from "../generated/brand.json";
import { Mark } from "./Mark";

// Where the kit places the mark inside the wordmark: centre (319.425, 158.75),
// ring radius 35.75 against the mark's 30, in a 40 76 552 134 viewBox.
const [VX, VY, VW, VH] = brand.viewBox.split(" ").map(Number) as [number, number, number, number];
const SCALE = 35.75 / 30;
const MARK = { x: 319.425 - 50 * SCALE, y: 158.75 - 50 * SCALE, size: 100 * SCALE };

/** Where the mark sits for a wordmark `width` wide: left, top and size in px. */
export function markBox(width: number) {
  const k = width / VW;
  return { left: (MARK.x - VX) * k, top: (MARK.y - VY) * k, size: MARK.size * k, height: VH * k };
}

export function Wordmark({ width, letters = 1, orbit = 1, ring = 1, dot = 1, dotAngle = 28, style }: { width: number; letters?: number; orbit?: number; ring?: number; dot?: number; dotAngle?: number; style?: CSSProperties }) {
  const m = markBox(width);
  return (
    <div style={{ position: "relative", width, height: m.height, ...style }}>
      <div style={{ position: "absolute", inset: 0, opacity: letters }} dangerouslySetInnerHTML={{ __html: brand.wordmarkLetters.replace("<svg ", `<svg style="width:100%;height:100%;display:block" `) }} />
      <Mark size={m.size} orbit={orbit} ring={ring} dot={dot} dotAngle={dotAngle} style={{ position: "absolute", left: m.left, top: m.top }} />
    </div>
  );
}
