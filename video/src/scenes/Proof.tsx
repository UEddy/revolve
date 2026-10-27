// "On the left, a normal bridge. Everything visible. On the right, a Revolve
// deposit. Nothing to see. Live on mainnet. With real funds." Split screen of
// the two real Zcash transactions, then the payout and the buy it funded
// scrolling past as their real hashes, with sources named.

import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame } from "remotion";
import { C, EASE, FONT, clamp } from "../brand";
import { TX, TxCard } from "../components/Evidence";
import { KeyText, Label } from "../components/KeyText";
import { Shell, s } from "../components/Shell";
import { IMAGES, scene } from "../timeline";
import { nearRows } from "./Problem";

const revolveRows = [
  { label: "Transaction", value: TX.revolveDeposit.hash, mono: true },
  { label: "Block", value: TX.revolveDeposit.block },
  { label: "Type", value: "Fully shielded" },
  { label: "Amount", value: "Not public", tone: "hidden" as const },
  { label: "Sender", value: "Not public", tone: "hidden" as const },
  { label: "Memo", value: "Encrypted", tone: "hidden" as const },
];

const HASHES = [
  { label: "Shielded deposit · Zcash", hash: TX.revolveDeposit.hash, note: "landed in the shielded pool, block 3,531,565", source: TX.revolveDeposit.source },
  { label: "Payout · Solana", hash: TX.payout.hash, note: TX.payout.what, source: TX.payout.source },
  { label: "Buy · Solana", hash: TX.bonk.hash, note: TX.bonk.what, source: TX.bonk.source },
];

export function Proof() {
  const frame = useCurrentFrame();
  const sc = scene("proof");
  const p = (a: number, b: number) => interpolate(frame, [a, b], [0, 1], { ...clamp, easing: EASE });
  const left = p(sc.cue(0), sc.cue(0) + s(0.8));
  const right = p(sc.cue(2), sc.cue(2) + s(0.8));
  const away = p(sc.cue(5) - s(0.2), sc.cue(5) + s(0.6));
  const red = sc.cue(1);
  const scrollP = interpolate(frame, [sc.cue(5), sc.duration], [0, 1], clamp);
  return (
    <Shell>
      <AbsoluteFill style={{ opacity: 1 - away, translate: `0 ${-60 * away}px` }}>
        <div style={{ position: "absolute", left: 80, top: 150, opacity: left, translate: `${(1 - left) * -40}px 0` }}>
          <Label style={{ marginBottom: 18 }}>A normal bridge</Label>
          <TxCard title="NEAR Intents swap, from Zodl" source={TX.nearDeshield.source} rows={nearRows} width={860} screenshot={IMAGES.explorerNear} highlight={{ 2: red, 3: red, 4: red, 5: red }} glow={red} />
        </div>
        <div style={{ position: "absolute", right: 80, top: 150, opacity: right, translate: `${(1 - right) * 40}px 0` }}>
          <Label style={{ marginBottom: 18 }}>A Revolve deposit</Label>
          <TxCard title="Revolve deposit" source={TX.revolveDeposit.source} rows={revolveRows} width={860} screenshot={IMAGES.explorerRevolve} />
        </div>
        <KeyText text="Nothing to see." at={sc.cue(4)} style={{ position: "absolute", right: 80, bottom: 90, width: 860, textAlign: "center" }} size={48} color={C.gold} />
      </AbsoluteFill>
      {frame >= sc.cue(5) - s(0.2) && (
        <AbsoluteFill style={{ opacity: away }}>
          <KeyText text="Live on mainnet. Real funds." at={sc.cue(5)} style={{ position: "absolute", top: 110, left: 0, right: 0, textAlign: "center" }} size={68} />
          <div style={{ position: "absolute", left: 160, right: 160, top: 290 - scrollP * 120 }}>
            {HASHES.map((h, i) => {
              const o = interpolate(frame, [sc.cue(5) + i * 12, sc.cue(5) + i * 12 + 18], [0, 1], { ...clamp, easing: EASE });
              const shot = i > 0 ? IMAGES.solscan[i - 1] : undefined;
              return (
                <div key={h.hash} style={{ opacity: o, translate: `0 ${(1 - o) * 24}px`, padding: "26px 0", borderTop: `1px solid ${C.line}` }}>
                  <div style={{ font: `600 24px ${FONT.body}`, color: C.gold }}>{h.label}</div>
                  {shot ? (
                    <Img src={staticFile(shot)} style={{ marginTop: 10, maxHeight: 160, borderRadius: 12 }} />
                  ) : (
                    <div style={{ marginTop: 8, font: `400 27px ${FONT.mono}`, color: C.ink, wordBreak: "break-all" }}>{h.hash}</div>
                  )}
                  <div style={{ marginTop: 8, font: `400 22px ${FONT.body}`, color: C.dim }}>
                    {h.note} · Source: {h.source}
                  </div>
                </div>
              );
            })}
          </div>
        </AbsoluteFill>
      )}
    </Shell>
  );
}
