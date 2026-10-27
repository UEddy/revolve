// Scene timing, derived from the voiceover: each scene starts, plays a short
// lead-in, then its narration block (never sped up or pitched), then holds
// until its visuals are done. Cues are frames, within a scene, where each
// spoken phrase starts, so visuals land on the words.

import manifest from "./generated/manifest.json" with { type: "json" };
import { SCRIPT, type SceneId } from "./script.ts";

export const FPS = 30;

/** Seconds: quiet lead before the narration, and the shortest the scene may be. */
const SHAPE: Record<SceneId, { lead: number; min: number; tail: number }> = {
  story: { lead: 1.3, min: 7.4, tail: 0.9 },
  problem: { lead: 0.4, min: 15.5, tail: 1.1 },
  reveal: { lead: 0.5, min: 8.4, tail: 1.3 },
  fund: { lead: 0.4, min: 13.2, tail: 1.0 },
  buy: { lead: 0.3, min: 14.2, tail: 1.2 },
  cashout: { lead: 0.4, min: 8.6, tail: 1.0 },
  proof: { lead: 0.4, min: 12.4, tail: 1.2 },
  range: { lead: 0.4, min: 8.6, tail: 1.2 },
  close: { lead: 0.7, min: 7.6, tail: 3.0 },
};

type Seg = { start: number; end: number };
type Block = { id: string; start: number; end: number; segments: Seg[] };

const blocks = (manifest.voiceover?.blocks ?? []) as Block[];

export type Scene = {
  id: SceneId;
  from: number;
  duration: number;
  /** The narration: where it plays in the scene and which part of the file. */
  vo: { at: number; trimBefore: number; trimAfter: number } | null;
  /** Frame in the scene where spoken phrase `i` of this block starts. */
  cue: (i: number) => number;
  /** Frame in the scene where the narration ends. */
  voEnd: number;
};

const PAD_BEFORE = 0.08; // keeps the first consonant
const PAD_AFTER = 0.15; // lets the last word ring out

let at = 0;
export const SCENES: Scene[] = SCRIPT.map(({ id, vo }) => {
  const shape = SHAPE[id];
  const b = blocks.find((x) => x.id === id);
  // Without a recording, time the scene from its text at an even speaking pace.
  const spoken = b ? b.end - b.start : vo.length / 14.5;
  const seconds = Math.max(shape.min, shape.lead + spoken + shape.tail);
  const scene: Scene = {
    id,
    from: at,
    duration: Math.round(seconds * FPS),
    vo: b
      ? {
          at: Math.round((shape.lead - PAD_BEFORE) * FPS),
          trimBefore: Math.max(0, Math.floor((b.start - PAD_BEFORE) * FPS)),
          trimAfter: Math.ceil((b.end + PAD_AFTER) * FPS),
        }
      : null,
    cue: (i) => {
      const s = b?.segments[Math.min(i, b.segments.length - 1)];
      return Math.round((shape.lead + (s && b ? s.start - b.start : (i * spoken) / 4)) * FPS);
    },
    voEnd: Math.round((shape.lead + spoken) * FPS),
  };
  at += scene.duration;
  return scene;
});

export const TOTAL = at;
export const scene = (id: SceneId) => SCENES.find((s) => s.id === id)!;
export const VOICEOVER = manifest.voiceover?.file ?? null;
export const MUSIC = manifest.music;
export const CLIPS = manifest.clips;
export const IMAGES = manifest.images;
