// "Pay from your Zcash wallet": the amount, how long the quote holds, and the
// payment itself. Zodl blocks zcash: links opened from other apps, so the main
// path is the ZIP-321 QR, saved to the gallery and imported by Zodl's scanner;
// the fields are there to copy one by one into Zodl's Send screen. Used for
// per-buy orders and for fundings.
//
// The code is a real PNG <img> (a blob URL), so a long-press offers the
// browser's own "Download image" / "Save to Photos". "Save QR to photos" is a
// plain download link (Android puts it in Downloads, which the gallery shows);
// iPhone also gets "Share QR", since its share sheet's Save Image is the way
// into Photos there.

import { useEffect, useMemo, useState } from "react";
import { MOCK } from "../lib/config.ts";
import { countdown } from "../lib/format.ts";
import { isIos } from "../lib/install.ts";
import { zip321 } from "../lib/memo.ts";
import { paymentQr, qrPath, qrPng, QR_FILENAME, shareQr } from "../lib/qr.ts";
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
  const ios = useMemo(() => isIos(navigator.userAgent, navigator.maxTouchPoints), []);
  const [png, setPng] = useState<{ blob: Blob; url: string } | null>(null);
  const [sharing, setSharing] = useState(false);
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
  // The PNG behind the <img> and the download link; its URL lives as long as this payment.
  useEffect(() => {
    if ("error" in built) return;
    let live = true;
    let url = "";
    qrPng(built.qr).then(
      (blob) => {
        if (!live) return;
        url = URL.createObjectURL(blob);
        setPng({ blob, url });
      },
      (e: unknown) => live && setError(errorText(e)),
    );
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
      setPng(null);
    };
  }, [built]);
  if ("error" in built) return <p className="err">{built.error}</p>;
  const { memo, uri, qr } = built;
  const expired = left <= 0;

  const share = async () => {
    if (!png) return;
    setSharing(true);
    setError(null);
    try {
      if (await shareQr(png.blob)) setSaved(true);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSharing(false);
    }
  };

  return (
    <div className="card">
      <div className="eyebrow">Pay from your Zcash wallet</div>
      <div className="display" style={{ fontSize: 34, margin: "6px 0 2px" }}>{amountZec} ZEC</div>
      <div className="faint">{expired ? "This quote has expired" : `Quote holds for ${countdown(left)}`}</div>
      {MOCK && <p className="badge caution" style={{ marginTop: 8 }}>Demo: paid automatically, nothing to send</p>}

      <figure className="payqr" aria-hidden={expired}>
        {png ? (
          <img src={png.url} width={qr.size} height={qr.size} alt={`Payment QR code for ${amountZec} ZEC`} />
        ) : (
          <svg viewBox={`0 0 ${qr.size} ${qr.size}`} role="img" aria-label={`Payment QR code for ${amountZec} ZEC`} shapeRendering="crispEdges">
            <rect className="payqr-paper" width={qr.size} height={qr.size} />
            <path className="payqr-ink" d={qrPath(qr)} />
          </svg>
        )}
      </figure>
      <div className="stack">
        {png && !expired ? (
          <a className="btn" href={png.url} download={QR_FILENAME} onClick={() => setSaved(true)}>
            {saved ? "Saved. Save again" : "Save QR to photos"}
          </a>
        ) : (
          <button className="btn" disabled>
            {expired ? null : <Spinner />} Save QR to photos
          </button>
        )}
        {ios && (
          <button className="btn ghost" disabled={!png || sharing || expired} onClick={share}>
            {sharing ? <Spinner /> : null} Share QR
          </button>
        )}
      </div>
      {error && <p className="err">{error}</p>}
      <p className="small" style={{ margin: "10px 0 0" }}>
        {ios ? (
          <>On iPhone, <b>Share QR</b> → Save Image puts it in Photos (or long-press the code → Save to Photos).</>
        ) : (
          <>It saves to Downloads, which your gallery shows. If nothing downloads, long-press the code → Download image.</>
        )}
      </p>
      <p className="small" style={{ margin: "6px 0 0" }}>
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
