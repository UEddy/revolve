// Renders app screens inside a same-origin iframe, with the app's real CSS
// (theme.css and styles.css, read by scripts/probe.mjs) and its dark theme.
// The iframe keeps the app's global rules (html, body, #root) away from the
// video, and the app's components render into it through a portal, so what
// shows is the live app's markup and styling, not a redraw.

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { continueRender, delayRender } from "remotion";
import css from "../generated/app-css.json";
import { FONT_FILES } from "../brand";

/** The app's dark-mode tokens, lifted out of its prefers-color-scheme block. */
function darkTokens(theme: string): string {
  const m = /@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{([\s\S]*?)\}\s*\}/.exec(theme);
  return m ? `:root { ${m[1]} }` : "";
}

const fontFaces = `
@font-face { font-family: "Inter"; font-weight: 700; src: url(${FONT_FILES.inter700}) format("woff2"); }
@font-face { font-family: "Work Sans"; font-weight: 400; src: url(${FONT_FILES.work400}) format("woff2"); }
@font-face { font-family: "Work Sans"; font-weight: 600; src: url(${FONT_FILES.work600}) format("woff2"); }`;

const STYLE = [
  fontFaces,
  css.theme,
  darkTokens(css.theme),
  css.styles,
  // Frames are driven by the video's clock, so the app's CSS animations and
  // transitions are off; the phone frame sets the width.
  `*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent; }
   html, body { width: 100%; height: 100%; overflow: hidden; }
   #root { max-width: none; min-height: 100%; }
   /* A real phone's safe areas: the app pads by env(safe-area-inset-*), which is 0 in an iframe. */
   .screen { padding-top: 58px !important; }
   .tabs { bottom: 24px !important; }
   ::-webkit-scrollbar { display: none; }`,
].join("\n");

export function AppFrame({ children, width, height }: { children: ReactNode; width: number; height: number }) {
  const [root, setRoot] = useState<HTMLElement | null>(null);
  const [handle] = useState(() => delayRender("app frame"));
  const onLoad = useCallback(
    (e: React.SyntheticEvent<HTMLIFrameElement>) => {
      const doc = e.currentTarget.contentDocument!;
      const style = doc.createElement("style");
      style.textContent = STYLE;
      doc.head.appendChild(style);
      const r = doc.createElement("div");
      r.id = "root";
      doc.body.appendChild(r);
      setRoot(r);
      doc.fonts.ready.then(() => continueRender(handle));
    },
    [handle],
  );
  useEffect(() => () => continueRender(handle), [handle]);
  return (
    <>
      <iframe
        title="app"
        srcDoc="<!doctype html><html><head><meta charset='utf-8'></head><body></body></html>"
        onLoad={onLoad}
        style={{ width, height, border: 0, display: "block", background: "#000" }}
      />
      {root && createPortal(children, root)}
    </>
  );
}
