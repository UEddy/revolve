// A small "Install Revolve" banner at the bottom: Chrome's own install
// dialog behind our Install button, or Share instructions on iOS. Only
// rendered on the welcome, unlock and tab screens (never over a payment or
// buy flow); hidden by CSS while a sheet is open.
// - inline (welcome, unlock): the last thing in the page's flow, pushed to
//   the bottom of the screen when there is room, so it can never cover the
//   Create or Unlock button, however short the phone.
// - floating (tab screens): fixed above the tab bar; it reports its height
//   as --install-h so the screen pads its bottom by that much.

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { bannerKind, installPrompt, isIos, isStandalone, readSnoozed, snooze } from "../lib/install.ts";
import { Mark, Share } from "./icons.tsx";

export function InstallBanner({ inline }: { inline?: boolean }) {
  const canPrompt = useSyncExternalStore(installPrompt.subscribe, installPrompt.available);
  const installed = useSyncExternalStore(installPrompt.subscribe, installPrompt.installed);
  const [dismissed, setDismissed] = useState(readSnoozed);
  const kind = bannerKind({
    standalone: isStandalone(),
    installed,
    ios: isIos(navigator.userAgent, navigator.maxTouchPoints),
    canPrompt,
    snoozed: dismissed,
  });
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = box.current;
    const root = document.documentElement.style;
    if (!el || inline) return;
    const ro = new ResizeObserver(() => root.setProperty("--install-h", `${el.offsetHeight + 12}px`));
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.removeProperty("--install-h");
    };
  }, [kind, inline]);

  if (!kind) return null;
  const notNow = () => {
    snooze();
    setDismissed(true);
  };
  return (
    <div ref={box} className={`install ${inline ? "inline" : "floating"}`} role="region" aria-label="Install Revolve">
      <span className="install-mark"><Mark /></span>
      <div className="install-text">
        <b>Install Revolve for one-tap access</b>
        {kind === "ios" && (
          <span className="faint">
            Tap Share <Share className="install-share" /> then “Add to Home Screen”.
          </span>
        )}
      </div>
      <div className="install-actions">
        {kind === "prompt" && (
          <button
            className="btn small"
            onClick={async () => {
              // A dismissed system dialog counts as Not now; the event can't be reused anyway.
              if ((await installPrompt.show()) === "dismissed") notNow();
            }}
          >
            Install
          </button>
        )}
        <button className="btn small ghost" onClick={notNow}>Not now</button>
      </div>
    </div>
  );
}
