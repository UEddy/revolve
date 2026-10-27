// "This is Revolve." The broken ring draws, the gold orbit draws itself
// around it, and the mark settles into the "o" of the wordmark.

import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { C, EASE, EASE_IO, clamp } from "../brand";
import { KeyText } from "../components/KeyText";
import { Mark } from "../components/Mark";
import { Shell, s } from "../components/Shell";
import { markBox, Wordmark } from "../components/Wordmark";
import { scene } from "../timeline";

const W = 900;

export function Reveal() {
  const frame = useCurrentFrame();
  const sc = scene("reveal");
  const p = (a: number, b: number, e = EASE) => interpolate(frame, [a, b], [0, 1], { ...clamp, easing: e });
  const ring = p(s(0.0), s(0.7), EASE_IO);
  const orbit = p(s(0.45), s(1.7), EASE_IO);
  const dot = p(s(1.55), s(1.9));
  const settle = p(s(1.9), s(2.9), EASE_IO);
  const m = markBox(W);
  const wTop = 470 - m.height / 2;
  const from = { left: 960 - 190, top: 470 - 190, size: 380 };
  const to = { left: 960 - W / 2 + m.left, top: wTop + m.top, size: m.size };
  const at = (k: keyof typeof from) => from[k] + (to[k] - from[k]) * settle;
  return (
    <Shell>
      <AbsoluteFill>
        {settle < 1 ? (
          <>
            <Wordmark width={W} letters={settle} ring={0} orbit={0} dot={0} style={{ position: "absolute", left: 960 - W / 2, top: wTop }} />
            <Mark size={at("size")} ring={ring} orbit={orbit} dot={dot} style={{ position: "absolute", left: at("left"), top: at("top") }} />
          </>
        ) : (
          <Wordmark width={W} style={{ position: "absolute", left: 960 - W / 2, top: wTop }} dotAngle={28 + (frame - s(2.9)) * 0.5} />
        )}
      </AbsoluteFill>
      <KeyText text="Spend shielded ZEC on anything." at={sc.cue(1)} out={sc.cue(2) - 8} style={{ position: "absolute", top: 660, left: 0, right: 0, textAlign: "center" }} size={54} color={C.dim} />
      <KeyText text="Never leave the shielded pool." at={sc.cue(2)} style={{ position: "absolute", top: 660, left: 0, right: 0, textAlign: "center" }} size={54} />
    </Shell>
  );
}
