// Shared scene pieces: the fade in and out of black, progress helpers, the
// fingerprint overlay (Android hides biometric prompts from recordings), and
// the card that stands in for a wait.

import type { CSSProperties, ReactNode } from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { C, EASE, FONT, clamp } from "../brand";

export const s = (sec: number) => Math.round(sec * 30);

/** 0..1 over [a, b] frames, eased. */
export function useP(a: number, b: number, easing = EASE): number {
  const frame = useCurrentFrame();
  return interpolate(frame, [a, b], [0, 1], { ...clamp, easing });
}

export function Shell({ children }: { children: ReactNode }) {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const opacity = Math.min(
    interpolate(frame, [0, 12], [0, 1], { ...clamp, easing: EASE }),
    interpolate(frame, [durationInFrames - 12, durationInFrames], [1, 0], clamp),
  );
  return (
    <AbsoluteFill style={{ background: C.bg }}>
      <AbsoluteFill style={{ opacity }}>{children}</AbsoluteFill>
    </AbsoluteFill>
  );
}

/** Visible while frame is in [from, to), with a short crossfade at both ends. */
export function During({ from, to, children, fade = 8, style }: { from: number; to: number; children: ReactNode; fade?: number; style?: CSSProperties }) {
  const frame = useCurrentFrame();
  if (frame < from - fade || frame >= to + fade) return null;
  const o = Math.min(interpolate(frame, [from - fade, from], [0, 1], clamp), interpolate(frame, [to, to + fade], [1, 0], clamp));
  return <AbsoluteFill style={{ opacity: o, ...style }}>{children}</AbsoluteFill>;
}

/** Fingerprint glyph with a slow pulse, and the caption saying what happened. */
export function Fingerprint({ at, until, style }: { at: number; until: number; style?: CSSProperties }) {
  const frame = useCurrentFrame();
  if (frame < at || frame > until + 10) return null;
  const inP = interpolate(frame, [at, at + 12], [0, 1], { ...clamp, easing: EASE });
  const outP = interpolate(frame, [until, until + 10], [1, 0], clamp);
  const pulse = ((frame - at) % 36) / 36;
  return (
    <div style={{ position: "absolute", display: "flex", flexDirection: "column", alignItems: "center", gap: 18, opacity: inP * outP, ...style }}>
      <div style={{ position: "relative", width: 132, height: 132, borderRadius: 66, background: "rgba(10,10,10,0.86)", border: `1.5px solid ${C.line}`, display: "grid", placeItems: "center" }}>
        <div style={{ position: "absolute", inset: -14 * pulse, borderRadius: "50%", border: `2px solid ${C.gold}`, opacity: 0.5 * (1 - pulse) }} />
        <svg viewBox="0 0 24 24" width={70} height={70} fill="none" stroke={C.gold} strokeWidth={1.4} strokeLinecap="round" aria-hidden>
          <path d="M12 11v3.5" />
          <path d="M8.5 13c0-2.2 1.6-3.8 3.5-3.8s3.5 1.6 3.5 3.8v1.2c0 1.7-.4 3.3-1.2 4.8" />
          <path d="M6 12.5C6 9.2 8.7 6.6 12 6.6s6 2.6 6 5.9v1.7c0 2.3-.5 4.5-1.5 6.4" />
          <path d="M3.8 11.2C4.5 7.2 7.9 4.2 12 4.2c4.6 0 8.3 3.6 8.3 8.2" />
          <path d="M10 16.5c-.2 1.6-.8 3.1-1.7 4.4M12 17c0 1.4-.3 2.7-.9 3.9" />
        </svg>
      </div>
      <div style={{ font: `600 24px ${FONT.body}`, color: C.ink, background: "rgba(10,10,10,0.86)", padding: "8px 18px", borderRadius: 999, border: `1px solid ${C.line}` }}>
        Approved with fingerprint
      </div>
    </div>
  );
}

/** Stands in for a real wait (confirmations, the privacy delay). */
export function WaitCard({ text, at, until }: { text: string; at: number; until: number }) {
  const frame = useCurrentFrame();
  if (frame < at - 6 || frame > until + 6) return null;
  const o = Math.min(interpolate(frame, [at - 6, at + 4], [0, 1], clamp), interpolate(frame, [until - 4, until + 6], [1, 0], clamp));
  const bar = interpolate(frame, [at, until], [0, 1], clamp);
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", background: `rgba(0,0,0,${0.72 * o})` }}>
      <div style={{ opacity: o, padding: "26px 34px", borderRadius: 22, background: "rgba(18,18,20,0.96)", border: `1px solid ${C.line}`, textAlign: "center", minWidth: 260 }}>
        <div style={{ font: `700 28px ${FONT.display}`, color: C.ink }}>{text}</div>
        <div style={{ marginTop: 16, height: 3, borderRadius: 2, background: C.line }}>
          <div style={{ width: `${bar * 100}%`, height: "100%", borderRadius: 2, background: C.gold }} />
        </div>
      </div>
    </AbsoluteFill>
  );
}
