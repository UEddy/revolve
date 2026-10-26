// Small shared pieces: token icon, risk meter, warnings, sheet, top bar.

import { useEffect, useState, type ReactNode } from "react";
import { iconUrl } from "../lib/jupiter.ts";
import type { Level, Warning } from "../lib/coach.ts";
import { Back } from "./icons.tsx";
import { back } from "../router.ts";

export function TokenIcon({ src, symbol, large }: { src?: string; symbol: string; large?: boolean }) {
  const [failed, setFailed] = useState(false);
  const url = iconUrl(src);
  return (
    <span className={`ticon${large ? " lg" : ""}`} aria-hidden>
      {url && !failed ? <img src={url} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} /> : symbol.slice(0, 1).toUpperCase()}
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

export function Spinner() {
  return <span className="spin" aria-label="Working" />;
}

export function errorText(e: unknown): string {
  if (e instanceof DOMException && e.name === "NotAllowedError") return "The passkey prompt was closed. Try again when you're ready.";
  return e instanceof Error ? e.message : String(e);
}
