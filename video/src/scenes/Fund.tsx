// "Fund it once from your Zcash wallet... They're blind signed, so even we
// can't link what you spend to what you paid." The Add funds flow (a real
// clip when it exists, otherwise the recreation), then credits passing behind
// a frosted pane: what the server sees is only blurred shapes.

import { AbsoluteFill, interpolate, Sequence, useCurrentFrame } from "remotion";
import { C, EASE, EASE_IO, FONT, clamp } from "../brand";
import { AppScreen } from "../components/Phone";
import { ClipSlot } from "../components/ClipSlot";
import { KeyText, Label } from "../components/KeyText";
import { During, Shell, WaitCard, s } from "../components/Shell";
import { AddFunds, CreditsAdded, Scroll } from "../app-screens/Screens";
import { CLIPS, scene } from "../timeline";

function FundFallback({ end }: { end: number }) {
  const frame = useCurrentFrame();
  const scroll = interpolate(frame, [s(1.8), s(3.4)], [0, 300], { ...clamp, easing: EASE_IO });
  return (
    <AppScreen>
      <During from={0} to={s(3.8)}>
        <Scroll y={scroll}>
          <AddFunds />
        </Scroll>
      </During>
      <During from={s(4.6)} to={end}>
        <CreditsAdded />
      </During>
      <WaitCard text="3 confirmations later" at={s(3.6)} until={s(4.6)} />
    </AppScreen>
  );
}

/** Six credits: on the left as the phone made them, blurred behind the pane, signed on the right. */
function BlindSigning({ start }: { start: number }) {
  const frame = useCurrentFrame() - start;
  const pane = { left: 760, right: 1160 };
  return (
    <AbsoluteFill>
      {Array.from({ length: 6 }, (_, i) => {
        // Two columns of three, crossing one after another.
        const row = i % 3;
        const col = Math.floor(i / 3);
        const t = interpolate(frame, [s(0.3) + i * 8, s(3.9) + i * 8], [0, 1], { ...clamp, easing: EASE_IO });
        const x = 260 + col * 130 + t * 1260;
        const y = 395 + row * 125;
        const behind = x > pane.left - 30 && x < pane.right + 30;
        const signed = x > pane.right + 30;
        return (
          <div key={i} style={{ position: "absolute", left: x - 34, top: y - 34, width: 68, height: 68, borderRadius: 34, border: `2.5px solid ${signed ? C.gold : C.ink}`, filter: behind ? "blur(14px)" : "none", opacity: behind ? 0.5 : 1, display: "grid", placeItems: "center" }}>
            {signed ? (
              <svg viewBox="0 0 24 24" width={30} height={30} fill="none" stroke={C.gold} strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 5 5 9-10" /></svg>
            ) : (
              <div style={{ width: 10 + (i % 3) * 5, height: 10 + (i % 3) * 5, borderRadius: 3, background: C.ink, rotate: `${i * 23}deg` }} />
            )}
          </div>
        );
      })}
      <div style={{ position: "absolute", left: pane.left, width: pane.right - pane.left, top: 270, height: 470, borderRadius: 28, background: "rgba(255,255,255,0.06)", backdropFilter: "blur(18px)", border: `1px solid ${C.line}` }} />
      <Label style={{ position: "absolute", left: 140, top: 290, width: 420, textAlign: "center" }}>Made on your phone</Label>
      <Label style={{ position: "absolute", left: pane.left, width: pane.right - pane.left, top: 230, textAlign: "center" }}>What Revolve sees</Label>
      <Label style={{ position: "absolute", left: 1460, top: 290, width: 300, textAlign: "center" }}>Signed, unlinkable</Label>
    </AbsoluteFill>
  );
}

export function Fund() {
  const frame = useCurrentFrame();
  const sc = scene("fund");
  const phoneEnd = sc.cue(2) - s(0.2);
  const out = interpolate(frame, [phoneEnd - s(0.5), phoneEnd + s(0.3)], [0, 1], { ...clamp, easing: EASE });
  const signingAt = phoneEnd;
  return (
    <Shell>
      <AbsoluteFill style={{ opacity: 1 - out, translate: `${-80 * out}px 0` }}>
        <div style={{ position: "absolute", left: 360, top: 70 }}>
          <Sequence durationInFrames={phoneEnd + s(0.4)} layout="none">
            <ClipSlot clip={CLIPS.fund} scale={0.98} fallback={<FundFallback end={phoneEnd + s(0.4)} />} />
          </Sequence>
        </div>
        <KeyText text="Fund it once." at={sc.cue(0)} out={sc.cue(1) - 8} style={{ position: "absolute", left: 1000, top: 430 }} />
        <KeyText text="Comes back as private credits." at={sc.cue(1) + s(1.2)} style={{ position: "absolute", left: 1000, top: 430, width: 800 }} size={68} />
      </AbsoluteFill>
      {frame >= signingAt && (
        <AbsoluteFill style={{ opacity: interpolate(frame, [signingAt, signingAt + 14], [0, 1], clamp) }}>
          <BlindSigning start={signingAt} />
          <KeyText text="Blind signed. Unlinkable." at={signingAt + 6} style={{ position: "absolute", top: 110, left: 0, right: 0, textAlign: "center" }} size={64} />
          <div style={{ position: "absolute", bottom: 130, left: 0, right: 0, textAlign: "center", font: `400 26px ${FONT.body}`, color: C.dim }}>RFC 9474 blind signatures</div>
        </AbsoluteFill>
      )}
    </Shell>
  );
}
