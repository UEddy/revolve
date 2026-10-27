// On-screen key phrases: at most six words, no em dashes, calm fade and rise.

import type { CSSProperties } from "react";
import { interpolate, useCurrentFrame } from "remotion";
import { C, EASE, FONT, clamp } from "../brand";

export function KeyText({ text, at, out, style, size = 76, color = C.ink, weight = 700 }: { text: string; at: number; out?: number; style?: CSSProperties; size?: number; color?: string; weight?: number }) {
  const frame = useCurrentFrame();
  if (text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length > 6) throw new Error(`key text over six words: ${text}`);
  if (/[—–]/.test(text)) throw new Error(`no em or en dashes on screen: ${text}`);
  const inP = interpolate(frame, [at, at + 20], [0, 1], { ...clamp, easing: EASE });
  const outP = out === undefined ? 1 : interpolate(frame, [out, out + 14], [1, 0], { ...clamp, easing: EASE });
  return (
    <div
      style={{
        font: `${weight} ${size}px/1.08 ${FONT.display}`,
        letterSpacing: "-0.02em",
        color,
        opacity: inP * outP,
        translate: `0 ${(1 - inP) * 22}px`,
        ...style,
      }}
    >
      {text}
    </div>
  );
}

/** Small, quiet label text. */
export function Label({ children, style }: { children: React.ReactNode; style?: CSSProperties }) {
  return <div style={{ font: `500 22px ${FONT.display}`, letterSpacing: "0.08em", textTransform: "uppercase", color: C.faint, ...style }}>{children}</div>;
}
