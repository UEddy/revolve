// The Revolve demo: nine scenes in sequence, each with its narration block
// placed after a short lead-in (the recording is never sped up or pitched),
// an empty music slot at low volume, and film grain over everything.

import { Audio } from "@remotion/media";
import { AbsoluteFill, Sequence, staticFile } from "remotion";
import type { ComponentType } from "react";
import { C } from "./brand";
import { Film } from "./components/Film";
import { Buy } from "./scenes/Buy";
import { CashOut } from "./scenes/CashOut";
import { Close } from "./scenes/Close";
import { Fund } from "./scenes/Fund";
import { Problem } from "./scenes/Problem";
import { Proof } from "./scenes/Proof";
import { Range } from "./scenes/Range";
import { Reveal } from "./scenes/Reveal";
import { Story } from "./scenes/Story";
import type { SceneId } from "./script";
import { MUSIC, SCENES, VOICEOVER, scene } from "./timeline";

export const SCENE_COMPONENTS: Record<SceneId, ComponentType> = {
  story: Story,
  problem: Problem,
  reveal: Reveal,
  fund: Fund,
  buy: Buy,
  cashout: CashOut,
  proof: Proof,
  range: Range,
  close: () => <Close />,
};

/** One narration block, at its place in its scene. */
export function Narration({ id }: { id: SceneId }) {
  const vo = scene(id).vo;
  if (!vo || !VOICEOVER) return null;
  return (
    <Sequence from={vo.at} durationInFrames={vo.trimAfter - vo.trimBefore} layout="none">
      <Audio src={staticFile(VOICEOVER)} trimBefore={vo.trimBefore} trimAfter={vo.trimAfter} />
    </Sequence>
  );
}

export function Demo() {
  return (
    <AbsoluteFill style={{ background: C.bg }}>
      {SCENES.map((sc) => {
        const Scene = SCENE_COMPONENTS[sc.id];
        return (
          <Sequence key={sc.id} name={sc.id} from={sc.from} durationInFrames={sc.duration}>
            <Scene />
            <Narration id={sc.id} />
          </Sequence>
        );
      })}
      {/* Music slot: add ~/revolve-media/music.mp3 (royalty-free) and it plays quietly under everything. */}
      {MUSIC && <Audio src={staticFile(MUSIC)} volume={0.12} loop />}
      <Film />
    </AbsoluteFill>
  );
}

/** 10 seconds, 1080 x 1080, from the closing scene, for X. */
export function Teaser() {
  const close = scene("close");
  const lead = 30;
  return (
    <AbsoluteFill style={{ background: C.bg }}>
      <Sequence durationInFrames={300}>
        <Close square cue={(i) => lead + (close.cue(i) - close.cue(0))} />
      </Sequence>
      {close.vo && VOICEOVER && (
        <Sequence from={lead - 2} durationInFrames={close.vo.trimAfter - close.vo.trimBefore} layout="none">
          <Audio src={staticFile(VOICEOVER)} trimBefore={close.vo.trimBefore} trimAfter={close.vo.trimAfter} />
        </Sequence>
      )}
      <Film />
    </AbsoluteFill>
  );
}
