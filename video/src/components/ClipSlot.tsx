// A slot for a real screen recording from ~/revolve-media. When the file
// exists (scripts/probe.mjs checks before every render) it plays inside the
// phone, cropped to the screen, the status bar covered, at most 6 seconds,
// with waits sped up 1.5x only where the slot's plan says so. Otherwise the
// slot's recreation plays, captioned as such.

import type { ReactNode } from "react";
import { Video } from "@remotion/media";
import { AbsoluteFill, Sequence, staticFile } from "remotion";
import { FPS } from "../timeline";
import { Phone, SCREEN } from "./Phone";

export type Clip = { file: string; duration: number; width: number | null; height: number | null } | null;

/** A run of the recording: seconds in the file, and its speed (1, or 1.5 through a wait). */
export type Part = { from: number; to: number; rate?: 1 | 1.5 };

/** Default plan: the first 6 seconds at normal speed. Edit per clip once the recordings exist. */
export const DEFAULT_PLAN: Part[] = [{ from: 0, to: 6 }];

export function ClipSlot({ clip, plan = DEFAULT_PLAN, fallback, scale = 1 }: { clip: Clip; plan?: Part[]; fallback: ReactNode; scale?: number }) {
  if (!clip) return <Phone scale={scale}>{fallback}</Phone>;
  let at = 0;
  const parts = plan.map((p) => {
    const rate = p.rate ?? 1;
    const frames = Math.round(((p.to - p.from) / rate) * FPS);
    const seq = { p, rate, at, frames };
    at += frames;
    return seq;
  });
  return (
    <Phone scale={scale} recreation={false}>
      <AbsoluteFill style={{ background: "#000" }}>
        {parts.map(({ p, rate, at: from, frames }) => (
          <Sequence key={p.from} from={from} durationInFrames={frames} layout="none">
            <Video
              src={staticFile(clip.file)}
              trimBefore={Math.round(p.from * FPS)}
              trimAfter={Math.round(p.to * FPS)}
              playbackRate={rate}
              muted
              style={{ width: SCREEN.width, height: SCREEN.height, objectFit: "cover" }}
            />
          </Sequence>
        ))}
        {/* The phone's own status bar (time, notifications) is never shown. */}
        <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 52, background: "#000" }} />
      </AbsoluteFill>
    </Phone>
  );
}
