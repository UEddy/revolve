// "Find a token, a stock, anything. One tap, one fingerprint. Every purchase
// lands in its own fresh wallet..." The real Discover carousel, then the buy
// (a real clip when it exists, otherwise the recreation) with the fingerprint
// approval, then each holding dropping into its own sealed box.

import { AbsoluteFill, interpolate, Sequence, useCurrentFrame } from "remotion";
import { C, EASE, EASE_IO, FONT, clamp } from "../brand";
import { AppScreen, Phone } from "../components/Phone";
import { ClipSlot } from "../components/ClipSlot";
import { KeyText } from "../components/KeyText";
import { During, Fingerprint, Shell, WaitCard, s } from "../components/Shell";
import { DiscoverScreen } from "../app-screens/Discover";
import { BuySheet, BuySteps, Portfolio } from "../app-screens/Screens";
import { pick } from "../app-screens/data";
import snapshot from "../generated/discover.json";
import { CLIPS, scene } from "../timeline";

const icons = snapshot.icons as Record<string, string>;

function BuyFallback({ t }: { t: { pressed: number; steps: number; wait: [number, number]; portfolio: number; end: number } }) {
  const frame = useCurrentFrame();
  return (
    <AppScreen>
      <During from={0} to={t.steps}>
        <BuySheet pressed={frame >= t.pressed} />
      </During>
      <During from={t.steps} to={t.wait[1]}>
        <BuySteps at={1} />
      </During>
      <During from={t.portfolio} to={t.end}>
        <Portfolio />
      </During>
      <WaitCard text="A few minutes later" at={t.wait[0]} until={t.wait[1]} />
    </AppScreen>
  );
}

/** Each holding drops into its own box, the lid closes, a gold seal sets. No lines between them. */
function SealedBoxes({ start }: { start: number }) {
  const frame = useCurrentFrame() - start;
  // A token, a stock, another token: each in its own wallet.
  const tokens = [pick("STONK"), pick("NVDAx"), pick("JUP")];
  return (
    <AbsoluteFill>
      {tokens.map((tk, i) => {
        const at = i * 14;
        const drop = interpolate(frame, [at, at + s(0.8)], [0, 1], { ...clamp, easing: EASE });
        const lid = interpolate(frame, [at + s(0.7), at + s(1.2)], [0, 1], { ...clamp, easing: EASE_IO });
        const seal = interpolate(frame, [at + s(1.1), at + s(1.5)], [0, 1], { ...clamp, easing: EASE });
        const x = 960 + (i - 1) * 380;
        const icon = tk.icon ? icons[tk.icon] : undefined;
        return (
          <div key={tk.symbol} style={{ position: "absolute", left: x - 130, top: 380, width: 260 }}>
            <div style={{ position: "relative", width: 260, height: 260, borderRadius: 34, border: `2px solid ${C.line}`, background: C.panel, overflow: "hidden" }}>
              <div style={{ position: "absolute", left: 80, top: 80 - 260 * (1 - drop), width: 100, height: 100, borderRadius: 50, overflow: "hidden", background: "#1a1a1e", display: "grid", placeItems: "center", font: `700 40px ${FONT.display}`, color: C.ink }}>
                {icon ? <img src={icon} style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : tk.symbol[0]}
              </div>
              <div style={{ position: "absolute", inset: 0, borderRadius: 34, border: `2px solid ${C.ink}`, opacity: lid * 0.9, clipPath: `inset(0 ${100 - lid * 100}% calc(100% - 4px) 0)` }} />
              <div style={{ position: "absolute", inset: 0, borderRadius: 34, border: `2px solid rgba(255,255,255,${0.5 * lid})` }} />
            </div>
            <div style={{ position: "absolute", left: 230, top: -14, width: 34, height: 34, borderRadius: 17, background: C.gold, opacity: seal, scale: String(0.6 + 0.4 * seal) }} />
            <div style={{ marginTop: 22, textAlign: "center", font: `600 28px ${FONT.body}`, color: C.ink, opacity: drop }}>{tk.symbol}</div>
            <div style={{ marginTop: 4, textAlign: "center", font: `400 22px ${FONT.body}`, color: C.faint, opacity: seal }}>its own wallet</div>
          </div>
        );
      })}
    </AbsoluteFill>
  );
}

export function Buy() {
  const frame = useCurrentFrame();
  const sc = scene("buy");
  const tap = sc.cue(3);
  const t = {
    discoverEnd: tap - s(1.0),
    pressed: tap + s(0.25),
    steps: tap + s(1.5),
    wait: [tap + s(2.2), tap + s(2.8)] as [number, number],
    portfolio: tap + s(2.7),
    // Lands on "sealed on your phone", after Portfolio has shown the holding.
    boxes: Math.max(sc.cue(4) + s(2.55), tap + s(3.9)),
  };
  const buyLen = t.boxes - t.discoverEnd;
  const out = interpolate(frame, [t.boxes - s(0.6), t.boxes], [0, 1], { ...clamp, easing: EASE });
  const scroll = interpolate(frame, [s(0.4), t.discoverEnd], [0, 330], { ...clamp, easing: EASE_IO });
  return (
    <Shell>
      <AbsoluteFill style={{ opacity: 1 - out, translate: `${-80 * out}px 0` }}>
        <div style={{ position: "absolute", left: 360, top: 70 }}>
          {frame < t.discoverEnd + 8 ? (
            <div style={{ opacity: interpolate(frame, [t.discoverEnd - 4, t.discoverEnd + 8], [1, 0], clamp) }}>
              <Phone scale={0.98}>
                <AppScreen>
                  <DiscoverScreen category="memes" scroll={scroll} />
                </AppScreen>
              </Phone>
            </div>
          ) : null}
          <Sequence from={t.discoverEnd} durationInFrames={buyLen} layout="none">
            <ClipSlot
              clip={CLIPS.buy}
              scale={0.98}
              fallback={<BuyFallback t={{ pressed: t.pressed - t.discoverEnd, steps: t.steps - t.discoverEnd, wait: [t.wait[0] - t.discoverEnd, t.wait[1] - t.discoverEnd], portfolio: t.portfolio - t.discoverEnd, end: buyLen }} />}
            />
          </Sequence>
          <Fingerprint at={tap} until={tap + s(1.25)} style={{ left: 0, width: 412, top: 520 }} />
        </div>
        <KeyText text="A token. A stock. Anything." at={sc.cue(0)} out={tap - 8} style={{ position: "absolute", left: 1000, top: 430, width: 820 }} size={68} />
        <KeyText text="One tap. One fingerprint." at={tap} out={sc.cue(4) - 8} style={{ position: "absolute", left: 1000, top: 430, width: 820 }} size={68} />
        <KeyText text="Its own fresh wallet." at={sc.cue(4)} style={{ position: "absolute", left: 1000, top: 430, width: 820 }} size={68} />
      </AbsoluteFill>
      {frame >= t.boxes - s(0.2) && (
        <AbsoluteFill style={{ opacity: interpolate(frame, [t.boxes - s(0.2), t.boxes + 10], [0, 1], clamp) }}>
          <SealedBoxes start={t.boxes} />
          <KeyText text="Sealed on your phone." at={t.boxes} out={sc.cue(5) - 6} style={{ position: "absolute", top: 150, left: 0, right: 0, textAlign: "center" }} size={64} />
          <KeyText text="No accounts. No seed phrase." at={Math.max(sc.cue(5), t.boxes + s(0.8))} style={{ position: "absolute", top: 150, left: 0, right: 0, textAlign: "center" }} size={64} />
        </AbsoluteFill>
      )}
    </Shell>
  );
}
