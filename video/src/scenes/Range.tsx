// "Memecoins. Stocks. Prediction markets. Collectibles. Across Solana,
// Ethereum and Robinhood Chain." The real Discover carousel sweeping its
// categories; collections carry their chain labels. Markets and collections
// are browse-only in the app, and the carousel has no buy buttons.

import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { EASE_IO, clamp } from "../brand";
import { AppScreen, Phone } from "../components/Phone";
import { KeyText } from "../components/KeyText";
import { Shell, s } from "../components/Shell";
import { DiscoverScreen } from "../app-screens/Discover";
import type { Category } from "../../../app/src/lib/discover.ts";
import { scene } from "../timeline";

export function Range() {
  const frame = useCurrentFrame();
  const sc = scene("range");
  // The four category words share the first spoken phrase; they are spread by
  // their length, which is how they fall in the recording.
  const first = sc.cue(0);
  const span = sc.cue(1) - first - s(0.35);
  const words: { cat: Category; text: string; share: number }[] = [
    { cat: "memes", text: "Memecoins.", share: 0 },
    { cat: "stocks", text: "Stocks.", share: 0.22 },
    { cat: "markets", text: "Prediction markets.", share: 0.38 },
    { cat: "nfts", text: "Collectibles.", share: 0.72 },
  ];
  const starts = words.map((w) => first + Math.round(w.share * span));
  const i = Math.max(0, starts.findLastIndex((t) => frame >= t));
  const current = words[i]!;
  const local = frame - starts[i]!;
  const scroll =
    current.cat === "nfts"
      ? interpolate(frame, [starts[3]! + s(0.4), sc.duration - s(0.6)], [0, 760], { ...clamp, easing: EASE_IO })
      : interpolate(local, [0, s(1.2)], [0, 120], { ...clamp, easing: EASE_IO });
  return (
    <Shell>
      <AbsoluteFill>
        <div style={{ position: "absolute", left: 1150, top: 70 }}>
          <Phone scale={0.98}>
            <AppScreen>
              <DiscoverScreen category={current.cat} scroll={scroll} />
            </AppScreen>
          </Phone>
        </div>
        {words.map((w, k) => (
          <KeyText key={w.cat} text={w.text} at={starts[k]!} out={k < 3 ? starts[k + 1]! - 4 : sc.cue(1) - 6} style={{ position: "absolute", left: 150, top: 440 }} size={88} />
        ))}
        <KeyText text="Solana, Ethereum, Robinhood Chain." at={sc.cue(1)} style={{ position: "absolute", left: 150, top: 410, width: 860 }} size={76} />
      </AbsoluteFill>
    </Shell>
  );
}
