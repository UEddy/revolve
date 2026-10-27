// Small shared pieces: token icon, risk meter, warnings, sheet, top bar.

import { useEffect, useState, type ReactNode } from "react";
import { iconUrl } from "../lib/jupiter.ts";
import type { Level, Warning } from "../lib/coach.ts";
import { Back, Mark } from "./icons.tsx";
import wordmarkLight from "../assets/brand/revolve-wordmark-light.svg";
import wordmarkDark from "../assets/brand/revolve-wordmark-dark.svg";
import { back } from "../router.ts";

export function TokenIcon({ src, symbol, large }: { src?: string; symbol: string; large?: boolean }) {
  const [loaded, setLoaded] = useState(false);
  const url = iconUrl(src);
  return (
    <span className={`ticon${large ? " lg" : ""}`} aria-hidden>
      {!loaded && symbol.slice(0, 1).toUpperCase()}
      {url && <img src={url} alt="" loading="lazy" referrerPolicy="no-referrer" className={loaded ? "in" : undefined} onLoad={() => setLoaded(true)} />}
    </span>
  );
}

export function Meter({ level, label }: { level: Level; label?: boolean }) {
  const text = { low: "Hard to link", medium: "Some link risk", high: "Easy to link" }[level];
  return (
    <span className="row" style={{ gap: 6, display: "inline-flex" }} title={text}>
      <span className={`meter ${level}`} aria-label={text}>
        <i /><i /><i /><i /><i />
      </span>
      {label && <span className="small muted">{text}</span>}
    </span>
  );
}

export function Warnings({ items }: { items: Warning[] }) {
  if (!items.length) return null;
  return (
    <div className="stack">
      {items.map((w) => (
        <div key={w.title} className={`warn ${w.level}`}>
          <span className="dot" />
          <div>
            <b>{w.title}</b>
            <p>{w.body}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

export function Sheet({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="sheet" role="dialog" aria-modal="true">
        <div className="grab" />
        {children}
      </div>
    </>
  );
}

export function TopBar({ title, right, noBack }: { title?: ReactNode; right?: ReactNode; noBack?: boolean }) {
  return (
    <div className="top">
      {!noBack && (
        <button className="icon-btn" onClick={() => back()} aria-label="Back">
          <Back />
        </button>
      )}
      <h1 className="display" style={{ fontSize: 22 }}>{title}</h1>
      {right}
    </div>
  );
}

/** The wordmark, light or dark to match the system theme. */
export function Wordmark({ height }: { height: number }) {
  return (
    <picture className="wordmark">
      <source srcSet={wordmarkDark} media="(prefers-color-scheme: dark)" />
      <img src={wordmarkLight} alt="Revolve" height={height} width={Math.round((height * 552) / 134)} />
    </picture>
  );
}

/** Busy indicator: the mark, turning slowly. */
export function Spinner() {
  return (
    <span className="spin" role="status" aria-label="Working">
      <Mark />
    </span>
  );
}

export function errorText(e: unknown): string {
  if (e instanceof DOMException && e.name === "NotAllowedError") return "The passkey prompt was closed. Try again when you're ready.";
  return e instanceof Error ? e.message : String(e);
}
