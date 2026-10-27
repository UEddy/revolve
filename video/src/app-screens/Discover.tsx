// The Discover tab: the app's real DiscoverSection (chips and carousel), fed
// the live snapshot through its own card cache, inside the tab's chrome
// (heading, search, the tab bar), which is the app's markup and CSS.
// The video picks the category and drives the carousel's scroll by frame.

import { useEffect, useRef } from "react";
import { continueRender, delayRender } from "remotion";
import { cardCache, DiscoverSection } from "../../../app/src/components/DiscoverSection.tsx";
import { Compass, Gear, Search, Wallet } from "../../../app/src/components/icons.tsx";
import type { Category } from "../../../app/src/lib/discover.ts";
import { CARDS } from "./data";

// Fresh forever: the section never refetches, it reads these cards.
for (const [cat, cards] of Object.entries(CARDS)) cardCache.set(cat as Category, { at: Date.now() + 1e13, cards });
try {
  localStorage.setItem("revolve.discover.hinted", "1"); // the one-time swipe hint is not part of this shot
} catch {}

export function Tabs({ at }: { at: "home" | "discover" | "settings" }) {
  const tab = (name: typeof at, label: string, Icon: typeof Wallet) => (
    <a aria-current={at === name ? "page" : undefined}>
      <Icon /> {at === name && label}
    </a>
  );
  return (
    <nav className="tabs">
      {tab("home", "Portfolio", Wallet)}
      {tab("discover", "Discover", Compass)}
      {tab("settings", "Settings", Gear)}
    </nav>
  );
}

/** One category's carousel. `scroll` is the track's scrollLeft in CSS px for this frame. */
export function DiscoverScreen({ category, scroll, below = true }: { category: Category; scroll: number; below?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  // The section reads its category from sessionStorage when it mounts.
  try {
    sessionStorage.setItem("rv.dsc", category);
  } catch {}
  // After the section's own effects (which reset the scroll when it mounts),
  // set the carousel's scroll and bring the active chip into view, and hold
  // the frame until the browser has applied both.
  useEffect(() => {
    const handle = delayRender("discover scroll");
    let done = false;
    const release = () => {
      if (!done) continueRender(handle);
      done = true;
    };
    const apply = () => {
      const track = box.current?.querySelector<HTMLDivElement>(".dsc-track");
      const chips = box.current?.querySelector<HTMLDivElement>(".dsc-chips");
      const chip = chips?.querySelector<HTMLElement>('[aria-selected="true"]');
      if (track) track.scrollLeft = scroll;
      if (chips && chip) chips.scrollLeft = Math.max(0, chip.offsetLeft - chips.offsetLeft - 18);
    };
    apply();
    const view = box.current?.ownerDocument.defaultView ?? window;
    const id = view.requestAnimationFrame(() => {
      apply();
      release();
    });
    return () => {
      view.cancelAnimationFrame(id);
      release();
    };
  });
  return (
    <div ref={box} className="screen" style={{ minHeight: "100%" }}>
      <h1 style={{ marginTop: 6 }}>Discover</h1>
      <DiscoverSection key={category} />
      {below && (
        <div className="search" style={{ position: "sticky" }}>
          <Search />
          <input className="input" type="search" placeholder="Search any token or stock" readOnly />
        </div>
      )}
      <Tabs at="discover" />
    </div>
  );
}
