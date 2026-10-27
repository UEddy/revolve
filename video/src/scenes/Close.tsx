// "Revolve. Buy anything. Leave no trail." The wordmark, its orbit's dot
// turning slowly, and where to find it. Also the 1080 x 1080 teaser.

import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { C, EASE, FONT, clamp } from "../brand";
import { KeyText } from "../components/KeyText";
import { Shell, s } from "../components/Shell";
import { Wordmark } from "../components/Wordmark";
import { scene } from "../timeline";

export function Close({ square = false, cue }: { square?: boolean; cue?: (i: number) => number }) {
  const frame = useCurrentFrame();
  const at = cue ?? scene("close").cue;
  const W = square ? 720 : 820;
  const H = square ? 1080 : 1080;
  const width = square ? 1080 : 1920;
  const cy = square ? 400 : 420;
  const appear = interpolate(frame, [0, s(1.0)], [0, 1], { ...clamp, easing: EASE });
  const links = interpolate(frame, [at(1) + s(1.0), at(1) + s(1.8)], [0, 1], { ...clamp, easing: EASE });
  const hack = interpolate(frame, [at(1) + s(1.6), at(1) + s(2.4)], [0, 1], { ...clamp, easing: EASE });
  return (
    <Shell>
      <AbsoluteFill style={{ width, height: H }}>
        <Wordmark width={W} dotAngle={28 + frame * 0.6} style={{ position: "absolute", left: (width - W) / 2, top: cy - (W * 134) / 552 / 2, opacity: appear, scale: String(0.98 + 0.02 * appear) }} />
        <KeyText text="Buy anything. Leave no trail." at={at(1)} style={{ position: "absolute", top: cy + 150, left: 0, right: 0, textAlign: "center" }} size={square ? 54 : 58} />
        <div style={{ position: "absolute", top: cy + (square ? 270 : 260), left: 0, right: 0, textAlign: "center", opacity: links, font: `400 ${square ? 32 : 30}px/1.6 ${FONT.body}`, color: C.dim }}>
          <div>revolveapp-phi.vercel.app</div>
          <div>github.com/UEddy/revolve</div>
        </div>
        <div style={{ position: "absolute", bottom: square ? 70 : 80, left: 0, right: 0, textAlign: "center", opacity: hack, font: `500 22px ${FONT.display}`, letterSpacing: "0.12em", textTransform: "uppercase", color: C.faint }}>
          ZECATHON 2026 · Cross-Chain
        </div>
      </AbsoluteFill>
    </Shell>
  );
}
