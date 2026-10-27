// A minimal modern phone: a thin black bezel, rounded screen, a small camera
// pill. The screen is the app at its real CSS size (390 x 844), scaled.
// Every recreated (non-recorded) screen carries a small caption beneath it.

import type { CSSProperties, ReactNode } from "react";
import { AppFrame } from "./AppFrame";
import { C, FONT } from "../brand";

export const SCREEN = { width: 390, height: 844 };

export function Phone({ children, scale = 1, recreation = true, style }: { children: ReactNode; scale?: number; recreation?: boolean; style?: CSSProperties }) {
  const bezel = 11;
  return (
    <div style={{ position: "relative", width: (SCREEN.width + bezel * 2) * scale, height: (SCREEN.height + bezel * 2) * scale, ...style }}>
      <div
        style={{
          width: SCREEN.width + bezel * 2,
          height: SCREEN.height + bezel * 2,
          scale: String(scale),
          transformOrigin: "0 0",
          borderRadius: 62,
          padding: bezel,
          background: "#000",
          boxShadow: `0 0 0 1.5px ${C.line}, 0 40px 120px rgba(0,0,0,0.6)`,
        }}
      >
        <div style={{ position: "relative", width: SCREEN.width, height: SCREEN.height, borderRadius: 52, overflow: "hidden", background: "#000" }}>
          {children}
          <div style={{ position: "absolute", top: 11, left: "50%", translate: "-50% 0", width: 108, height: 32, borderRadius: 20, background: "#000" }} />
        </div>
      </div>
      {recreation && (
        <div style={{ position: "absolute", left: 0, right: 0, top: (SCREEN.height + bezel * 2) * scale + 18, textAlign: "center", font: `400 17px ${FONT.body}`, color: C.faint, letterSpacing: "0.02em" }}>
          Recreation of the live app
        </div>
      )}
    </div>
  );
}

/** An app screen inside the phone: the app's CSS and dark theme, its own layout. */
export function AppScreen({ children }: { children: ReactNode }) {
  return <AppFrame width={SCREEN.width} height={SCREEN.height}>{children}</AppFrame>;
}
