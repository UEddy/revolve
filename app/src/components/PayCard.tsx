// "Pay with Zodl": the amount, how long the quote holds, and the ZIP-321
// link (open in Zodl, or copy). Used for per-buy orders and for fundings.

import { useEffect, useState } from "react";
import { MOCK } from "../lib/config.ts";
import { countdown } from "../lib/format.ts";
import { errorText } from "./bits.tsx";

export function useNow(every = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(t);
  }, [every]);
  return now;
}

/** `link` builds the zcash: URI; a throw (bad address or memo) is shown instead of a button. */
export function PayCard({ amountZec, expiresAt, link: build, memoNote }: { amountZec: string; expiresAt: string; link: () => string; memoNote: string }) {
  const now = useNow();
  const left = Date.parse(expiresAt) - now;
  const [copied, setCopied] = useState(false);
  let link = "";
  try {
    link = build();
  } catch (e) {
    return <p className="err">{errorText(e)}</p>;
  }
  return (
    <div className="card">
      <div className="eyebrow">Pay</div>
      <div className="display" style={{ fontSize: 34, margin: "6px 0 2px" }}>{amountZec} ZEC</div>
      <div className="faint">Quote holds for {countdown(left)}</div>
      <div className="spacer" />
      {MOCK ? (
        <button className="btn" disabled>Pay with Zodl (demo: paid automatically)</button>
      ) : (
        <a className="btn" href={link} aria-disabled={left <= 0}>
          Pay with Zodl
        </a>
      )}
      <div style={{ height: 8 }} />
      <button
        className="btn ghost"
        onClick={() =>
          navigator.clipboard.writeText(link).then(
            () => setCopied(true),
            () => setCopied(false),
          )
        }
      >
        {copied ? "Copied" : "Copy payment link"}
      </button>
      <p className="faint" style={{ marginBottom: 0 }}>
        Zodl opens with the amount and a private memo filled in. Just confirm. {memoNote}
      </p>
    </div>
  );
}
