// "Pay from your Zcash wallet": the amount, how long the quote holds, and the
// payment itself. Zodl blocks zcash: links opened from other apps, so the main
// path is the ZIP-321 QR, saved to the gallery and imported by Zodl's scanner;
// the fields are there to copy one by one into Zodl's Send screen. Used for
// per-buy orders and for fundings.

import { useEffect, useMemo, useState } from "react";
import { MOCK } from "../lib/config.ts";
import { countdown } from "../lib/format.ts";
import { zip321 } from "../lib/memo.ts";
import { paymentQr, qrPath, qrPng, saveQr } from "../lib/qr.ts";
import { Spinner, errorText } from "./bits.tsx";

export function useNow(every = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(t);
  }, [every]);
  return now;
}

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2_000);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <div className="payfield">
      <div className="payfield-head">
        <span className="payfield-label">{label}</span>
        <button className="btn small ghost" onClick={() => navigator.clipboard.writeText(value).then(() => setCopied(true), () => setCopied(false))}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <p className="mono payfield-value">{value}</p>
    </div>
  );
}

/** Throws from building the payment (a bad address or memo) are shown instead of the card. */
export function PayCard({ depositUa, amountZec, memo: buildMemoText, expiresAt, memoNote }: { depositUa: string; amountZec: string; memo: () => string; expiresAt: string; memoNote: string }) {
  const now = useNow();
  const left = Date.parse(expiresAt) - now;
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const built = useMemo(() => {
    try {
      const memo = buildMemoText();
      const uri = zip321(depositUa, amountZec, memo);
      return { memo, uri, qr: paymentQr(uri) };
    } catch (e) {
      return { error: errorText(e) };
    }
    // The memo builder is a fresh closure each render; its inputs are the order's own fields, fixed for its life.
  }, [depositUa, amountZec]);
  if ("error" in built) return <p className="err">{built.error}</p>;
  const { memo, uri, qr } = built;
  const expired = left <= 0;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      setSaved(await saveQr(await qrPng(qr)));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card">
      <div className="eyebrow">Pay from your Zcash wallet</div>
      <div className="display" style={{ fontSize: 34, margin: "6px 0 2px" }}>{amountZec} ZEC</div>
      <div className="faint">{expired ? "This quote has expired" : `Quote holds for ${countdown(left)}`}</div>
      {MOCK && <p className="badge caution" style={{ marginTop: 8 }}>Demo: paid automatically, nothing to send</p>}

      <figure className="payqr" aria-hidden={expired}>
        <svg viewBox={`0 0 ${qr.size} ${qr.size}`} role="img" aria-label={`Payment QR code for ${amountZec} ZEC`} shapeRendering="crispEdges">
          <rect className="payqr-paper" width={qr.size} height={qr.size} />
          <path className="payqr-ink" d={qrPath(qr)} />
        </svg>
      </figure>
      <button className="btn" disabled={saving || expired} onClick={save}>
        {saving ? <Spinner /> : null} {saved ? "Saved. Save again" : "Save QR to photos"}
      </button>
      {error && <p className="err">{error}</p>}
      <p className="small" style={{ margin: "10px 0 0" }}>
        In Zodl: tap <b>Scan</b> → choose from gallery → pick the saved QR → check and send.
      </p>

      <h3 style={{ margin: "22px 0 4px", fontSize: 15 }}>Or in Zodl: Send → paste address, amount and message.</h3>
      <CopyField label="Address" value={depositUa} />
      <CopyField label="Exact amount (ZEC)" value={amountZec} />
      <CopyField label="Exact message" value={memo} />

      <div className="warn medium" style={{ margin: "14px 0 0" }}>
        <span className="dot" />
        <div>
          <b>The message must match exactly, or the payment goes to manual review.</b>
          <p>
            {memoNote} Delete the saved QR from your photos after paying: photo backups would keep a copy of the message.
          </p>
        </div>
      </div>

      <p className="small center" style={{ margin: "14px 0 0" }}>
        <a href={uri}>Open in another Zcash wallet</a>
      </p>
    </div>
  );
}
