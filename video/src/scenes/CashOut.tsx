// "When you're done, cash out. Straight back into shielded ZEC." The cash out
// flow (a real clip when it exists, otherwise the recreation, up to the
// passkey approval), then a gold line from the holding loops back into the
// mark and closes its orbit.

import { AbsoluteFill, interpolate, Sequence, useCurrentFrame } from "remotion";
import { C, EASE, EASE_IO, clamp } from "../brand";
import { AppScreen } from "../components/Phone";
import { ClipSlot } from "../components/ClipSlot";
import { KeyText } from "../components/KeyText";
import { Mark } from "../components/Mark";
import { During, Fingerprint, Shell, s } from "../components/Shell";
import { CashOutSheet } from "../app-screens/Screens";
import { CLIPS, scene } from "../timeline";

function CashOutFallback({ end }: { end: number }) {
  return (
    <AppScreen>
      <During from={0} to={s(1.1)}>
        <CashOutSheet step="position" />
      </During>
      <During from={s(1.1)} to={s(3.0)}>
        <CashOutSheet step="form" />
      </During>
      <During from={s(3.0)} to={end}>
        <CashOutSheet step="review" />
      </During>
    </AppScreen>
  );
}

const LOOP = "M 560 640 C 560 330, 900 250, 1120 330 S 1330 520, 1330 520";

export function CashOut() {
  const frame = useCurrentFrame();
  const sc = scene("cashout");
  const phoneEnd = s(5.2);
  const out = interpolate(frame, [phoneEnd - s(0.4), phoneEnd + s(0.3)], [0, 1], { ...clamp, easing: EASE });
  const loopAt = phoneEnd;
  const line = interpolate(frame, [loopAt + s(0.2), loopAt + s(1.8)], [0, 1], { ...clamp, easing: EASE_IO });
  const close = interpolate(frame, [loopAt + s(1.5), loopAt + s(2.4)], [0.55, 1], { ...clamp, easing: EASE_IO });
  const show = interpolate(frame, [loopAt, loopAt + 12], [0, 1], clamp);
  return (
    <Shell>
      <AbsoluteFill style={{ opacity: 1 - out, translate: `${-80 * out}px 0` }}>
        <div style={{ position: "absolute", left: 360, top: 70 }}>
          <Sequence durationInFrames={phoneEnd + s(0.4)} layout="none">
            <ClipSlot clip={CLIPS.cashout} scale={0.98} fallback={<CashOutFallback end={phoneEnd + s(0.4)} />} />
          </Sequence>
          <Fingerprint at={s(3.9)} until={s(5.0)} style={{ left: 0, width: 412, top: 520 }} />
        </div>
        <KeyText text="Cash out." at={sc.cue(1)} style={{ position: "absolute", left: 1000, top: 380 }} />
        <KeyText text="Straight back into shielded ZEC." at={sc.cue(2)} style={{ position: "absolute", left: 1000, top: 480, width: 820 }} size={60} color={C.dim} />
      </AbsoluteFill>
      {frame >= loopAt && (
        <AbsoluteFill style={{ opacity: show }}>
          <div style={{ position: "absolute", left: 470, top: 640, width: 180, height: 180, borderRadius: 28, border: `2px solid rgba(255,255,255,0.5)`, background: C.panel }}>
            <div style={{ position: "absolute", left: 150, top: -12, width: 28, height: 28, borderRadius: 14, background: C.gold }} />
          </div>
          <svg width={1920} height={1080} style={{ position: "absolute", inset: 0 }}>
            <path d={LOOP} pathLength={1} fill="none" stroke={C.gold} strokeWidth={3} strokeLinecap="round" style={{ strokeDasharray: 1, strokeDashoffset: 1 - line }} />
          </svg>
          <Mark size={300} orbit={close} dot={interpolate(close, [0.9, 1], [0, 1], clamp)} style={{ position: "absolute", left: 1330 - 150, top: 520 - 150 }} />
        </AbsoluteFill>
      )}
    </Shell>
  );
}
