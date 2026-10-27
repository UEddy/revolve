// On-chain evidence, as real data. A card is a faithful, styled rendering of
// what the named explorer shows for that transaction; when a screenshot of
// it exists in ~/revolve-media, the screenshot is shown instead.

import type { CSSProperties, ReactNode } from "react";
import { Img, interpolate, staticFile, useCurrentFrame } from "remotion";
import { C, EASE, FONT, clamp } from "../brand";

export type Row = { label: string; value: string; mono?: boolean; tone?: "red" | "hidden" | "gold" };

/** `highlight` maps a row index to the frame where it turns red (or hidden rows dim in). */
export function TxCard({
  title,
  source,
  rows,
  highlight = {},
  width = 820,
  glow,
  style,
  screenshot,
}: {
  title: ReactNode;
  source: string;
  rows: Row[];
  highlight?: Record<number, number>;
  width?: number;
  /** Frame from which the card's edge glows red. */
  glow?: number;
  style?: CSSProperties;
  screenshot?: string | null;
}) {
  const frame = useCurrentFrame();
  const glowP = glow === undefined ? 0 : interpolate(frame, [glow, glow + 20], [0, 1], { ...clamp, easing: EASE });
  const frameStyle: CSSProperties = {
    width,
    borderRadius: 26,
    border: `1.5px solid ${glowP > 0 ? `rgba(255,77,77,${0.25 + 0.55 * glowP})` : C.line}`,
    boxShadow: glowP > 0 ? `0 0 ${60 * glowP}px rgba(255,77,77,${0.28 * glowP})` : "none",
    background: "#101012",
    overflow: "hidden",
    ...style,
  };
  if (screenshot) {
    return (
      <div style={frameStyle}>
        <Img src={staticFile(screenshot)} style={{ width: "100%", display: "block" }} />
        <Source text={source} pad />
      </div>
    );
  }
  return (
    <div style={{ ...frameStyle, padding: "30px 36px 24px" }}>
      <div style={{ font: `700 30px ${FONT.display}`, color: C.ink, marginBottom: 18 }}>{title}</div>
      {rows.map((r, i) => {
        const on = highlight[i] === undefined ? 0 : interpolate(frame, [highlight[i]!, highlight[i]! + 14], [0, 1], { ...clamp, easing: EASE });
        const color = r.tone === "red" ? `rgb(255,${255 - 178 * on},${255 - 178 * on})` : r.tone === "hidden" ? C.faint : r.tone === "gold" ? C.gold : C.ink;
        return (
          <div key={r.label} style={{ display: "flex", gap: 24, padding: "13px 0", borderTop: `1px solid ${C.line}`, alignItems: "baseline" }}>
            <div style={{ width: 170, flex: "none", font: `500 21px ${FONT.display}`, color: C.dim }}>{r.label}</div>
            <div
              style={{
                font: r.mono ? `400 21px/1.45 ${FONT.mono}` : `600 24px/1.35 ${FONT.body}`,
                color,
                wordBreak: "break-all",
                background: r.tone === "red" ? `rgba(255,77,77,${0.16 * on})` : "transparent",
                borderRadius: 8,
                padding: "2px 8px",
                margin: "-2px -8px",
              }}
            >
              {r.value}
            </div>
          </div>
        );
      })}
      <Source text={source} />
    </div>
  );
}

function Source({ text, pad }: { text: string; pad?: boolean }) {
  return <div style={{ font: `400 18px ${FONT.body}`, color: C.faint, marginTop: pad ? 0 : 14, padding: pad ? "12px 20px" : 0 }}>Source: {text}</div>;
}

// The real transactions, as the explorers show them (checked on mainnet).
export const TX = {
  nearDeshield: {
    hash: "19d07f8f507039a1b922113c6cc28bfa8414478b198f96d30425d3541da6fe01",
    block: "3,531,462",
    time: "2026-10-26 16:33:38 UTC",
    type: "Deshielding (Z-T)",
    to: "t1dCCf1RHzVnkB6KE8d1bzAQypGNktu8zwh",
    amount: "0.00251649 ZEC",
    source: "mainnet.zcashexplorer.app",
  },
  revolveDeposit: {
    hash: "bef498e89249127a1fb93457305b3b447bb11e831f340fda42ff25c6da1d63fd",
    block: "3,531,565",
    type: "Shielded (Orchard actions)",
    source: "mainnet.zcashexplorer.app",
  },
  payout: {
    hash: "4uTmgrG2wcg66VkmFFfEzk8nD8KazRaiGQ2maQFwSLVbb1WMaSRg7JUCXfzdGBakZijhsEqxiZDesZx6QtTGd8m2",
    time: "2026-10-26 18:52:07 UTC",
    what: "0.065380967 SOL to a fresh wallet",
    source: "solscan.io",
  },
  bonk: {
    hash: "KPoQSXNf4NFaJL6tbYUCsjx9pxCbU5bBq8YTRt9SuCEZtQhKBGCEwxBJEDH35vSWZamMp9VgwDGTdnHUwRq3pPe",
    time: "2026-10-26 18:56:53 UTC",
    what: "330,983 BONK, bought in that wallet",
    source: "solscan.io",
  },
} as const;
