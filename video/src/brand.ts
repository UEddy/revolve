// Brand for the demo: black, white, and ZEC gold as the only accent; red only
// for data a bridge exposes. Fonts are the app's own, self-hosted.

import { loadFont } from "@remotion/fonts";
import { Easing } from "remotion";
import inter700 from "@fontsource/inter/files/inter-latin-700-normal.woff2";
import inter500 from "@fontsource/inter/files/inter-latin-500-normal.woff2";
import work400 from "@fontsource/work-sans/files/work-sans-latin-400-normal.woff2";
import work600 from "@fontsource/work-sans/files/work-sans-latin-600-normal.woff2";

export const C = {
  bg: "#0A0A0A",
  ink: "#FFFFFF",
  gold: "#F4B728",
  red: "#FF4D4D",
  dim: "rgba(255,255,255,0.62)",
  faint: "rgba(255,255,255,0.38)",
  line: "rgba(255,255,255,0.14)",
  panel: "rgba(255,255,255,0.045)",
} as const;

export const FONT = {
  display: "Inter, system-ui, sans-serif",
  body: "'Work Sans', system-ui, sans-serif",
  mono: "ui-monospace, 'DejaVu Sans Mono', monospace",
} as const;

export const FONT_FILES = { inter700, inter500, work400, work600 };

export const fontsLoaded = Promise.all([
  loadFont({ family: "Inter", url: inter700, weight: "700" }),
  loadFont({ family: "Inter", url: inter500, weight: "500" }),
  loadFont({ family: "Work Sans", url: work400, weight: "400" }),
  loadFont({ family: "Work Sans", url: work600, weight: "600" }),
]);

/** Calm motion only: long ease-out, and an ease-in-out for moves. No springs. */
export const EASE = Easing.bezier(0.22, 1, 0.36, 1);
export const EASE_IO = Easing.bezier(0.65, 0, 0.35, 1);

export const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
