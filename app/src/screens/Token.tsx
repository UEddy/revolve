// One token: the numbers that matter, the coach's warnings, and Buy.

import { useEffect, useState } from "react";
import { tokens, toRef, ultraOrder, usdPrice, isStock, type JupToken } from "../lib/jupiter.ts";
import { getBuckets } from "../lib/orders.ts";
import { BUCKETS, MOCK, SOL_MINT, SWAP_RESERVE_LAMPORTS, ZEC_MINT, type Bucket } from "../lib/config.ts";
import { buyWarnings } from "../lib/coach.ts";
import { ago, amount, compact, pct, price, usd, units } from "../lib/format.ts";
import { go, href } from "../router.ts";
import { useVault } from "../state/vault.tsx";
import { useEngine } from "../state/engine.tsx";
import { Sheet, Spinner, TokenIcon, TopBar, Warnings, errorText } from "../components/bits.tsx";
import { seen } from "./Discover.tsx";

function useToken(mint: string) {
  const [t, setT] = useState<JupToken | null>(seen.get(mint) ?? null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    // Lists already carry full token data; only look it up when arriving by link.
    if (seen.has(mint)) return;
    let live = true;
    tokens
      .byMint(mint)
      .then((x) => {
        if (!live) return;
        if (x) {
          seen.set(mint, x);
          setT(x);
        } else if (!seen.has(mint)) setError("Token not found");
      })
      .catch((e: Error) => live && !seen.has(mint) && setError(e.message));
    return () => {
      live = false;
    };
  }, [mint]);
  return { t, error };
}

function usePrice(mint: string) {
  const [p, setP] = useState<number | null>(null);
  useEffect(() => {
    usdPrice(mint).then(setP, () => {});
  }, [mint]);
  return p;
}

export function TokenScreen({ mint }: { mint: string }) {
  const { t, error } = useToken(mint);
  const [buying, setBuying] = useState(false);
  if (!t) return <div className="screen"><TopBar title="" />{error ? <p className="empty">{error}</p> : <div className="skeleton" style={{ borderRadius: 22 }} />}</div>;
  const launched = t.firstPool?.createdAt ?? t.createdAt;
  const change = t.stats24h?.priceChange;
  return (
    <div className="screen">
      <TopBar title="" />
      <div className="row">
        <TokenIcon src={t.icon} symbol={t.symbol} large />
        <div className="grow">
          <div className="eyebrow">{isStock(t) ? "Stock" : "Token"}</div>
          <h1 style={{ margin: "4px 0 0", fontSize: 26 }}>{t.name}</h1>
          <div className="muted">
            {t.symbol} {t.isVerified ? <span className="badge ok">✓ Verified</span> : <span className="badge caution">Unverified</span>}
          </div>
        </div>
      </div>
      <div className="hero" style={{ textAlign: "left", padding: "18px 0 6px" }}>
        <div className="total num">{price(t.usdPrice)}</div>
        {change !== undefined && <div className={change >= 0 ? "up" : "down"}>{pct(change)} today</div>}
      </div>
      <div className="stats">
        <div className="stat"><span className="faint">Market cap</span><b className="num">{t.mcap ? `$${compact(t.mcap)}` : "–"}</b></div>
        <div className="stat"><span className="faint">Liquidity</span><b className="num">{t.liquidity ? `$${compact(t.liquidity)}` : "–"}</b></div>
        <div className="stat"><span className="faint">Holders</span><b className="num">{compact(t.holderCount)}</b></div>
        <div className="stat"><span className="faint">Launched</span><b>{launched ? `${ago(launched)} ago` : "–"}</b></div>
      </div>
      {t.audit && (t.audit.mintAuthorityDisabled === false || t.audit.freezeAuthorityDisabled === false) && !isStock(t) && (
        <p className="faint" style={{ marginTop: 12 }}>
          Heads up: the issuer can still {t.audit.mintAuthorityDisabled === false ? "mint more" : ""}
          {t.audit.mintAuthorityDisabled === false && t.audit.freezeAuthorityDisabled === false ? " and " : ""}
          {t.audit.freezeAuthorityDisabled === false ? "freeze holdings" : ""}.
        </p>
      )}
      <div className="dock">
        <button className="btn" onClick={() => setBuying(true)} disabled={t.id === ZEC_MINT}>
          Buy {t.symbol}
        </button>
      </div>
      <BuySheet open={buying} onClose={() => setBuying(false)} t={t} />
    </div>
  );
}

function BuySheet({ open, onClose, t }: { open: boolean; onClose: () => void; t: JupToken }) {
  const { data } = useVault();
  const { startOrder } = useEngine();
  const zec = usePrice(ZEC_MINT);
  const sol = usePrice(SOL_MINT);
  const [bucket, setBucket] = useState<Bucket>("0.01");
  const [available, setAvailable] = useState<Record<string, boolean> | null>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    getBuckets().then(
      (b) => {
        if (!live) return;
        setAvailable(b);
        // Keep the choice if it is offered, else fall back to the smallest one that is.
        setBucket((cur) => (b[cur] ? cur : (BUCKETS.find((x) => b[x]) ?? cur)));
      },
      () => live && setAvailable(null),
    );
    return () => {
      live = false;
    };
  }, [open]);
  const noneAvailable = available !== null && !BUCKETS.some((b) => available[b]);
  const [estimate, setEstimate] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = toRef(t);
  const warnings = buyWarnings(ref, data?.positions ?? [], Date.now());

  // A rough "you get" before any order exists: the bucket's value in SOL, minus the reserve, quoted on Jupiter.
  useEffect(() => {
    if (!open || !zec || !sol || t.id === SOL_MINT) return setEstimate(null);
    let live = true;
    const lamports = BigInt(Math.floor(((Number(bucket) * zec) / sol) * 1e9)) - SWAP_RESERVE_LAMPORTS;
    if (lamports <= 0n) return setEstimate(0);
    ultraOrder(SOL_MINT, t.id, lamports).then(
      (q) => live && setEstimate(units(q.outAmount, t.decimals)),
      () => live && setEstimate(null),
    );
    return () => {
      live = false;
    };
  }, [open, bucket, zec, sol, t.id, t.decimals]);

  const buy = async () => {
    setBusy(true);
    setError(null);
    try {
      const id = await startOrder(ref, bucket);
      onClose();
      go(href.position(id));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose}>
      <div className="row" style={{ marginBottom: 14 }}>
        <TokenIcon src={t.icon} symbol={t.symbol} />
        <div className="grow">
          <h3>Buy {t.symbol}</h3>
          <div className="faint">Pick an amount. Fixed sizes help you blend in.</div>
        </div>
      </div>
      <div className="chips" role="group" aria-label="Amount">
        {BUCKETS.map((b) => (
          <button key={b} className="chip" aria-pressed={bucket === b} disabled={available !== null && !available[b]} onClick={() => setBucket(b)}>
            <strong>{b}</strong>
            <span>ZEC{zec ? ` · ${usd(Number(b) * zec)}` : ""}</span>
          </button>
        ))}
      </div>
      <div className="card sunk" style={{ margin: "14px 0" }}>
        <div className="kv"><span>You pay</span><span className="num">{bucket} ZEC</span></div>
        <div className="kv">
          <span>You get about</span>
          <span className="num">{t.id === SOL_MINT ? "–" : estimate === null ? "…" : `${amount(estimate)} ${t.symbol}`}</span>
        </div>
        <div className="kv"><span>Goes to</span><span>A new wallet, only on this phone</span></div>
      </div>
      <Warnings items={warnings} />
      {noneAvailable && <p className="err">Buying is paused while the payout wallet refills. Try again soon.</p>}
      {error && <p className="err">{error}</p>}
      <div className="spacer" />
      <button className="btn" onClick={buy} disabled={busy || noneAvailable || (available !== null && !available[bucket])}>
        {busy ? <Spinner /> : null} {MOCK ? "Continue (demo, no money moves)" : "Continue to payment"}
      </button>
      <p className="faint center">A small part of the payout stays in the wallet to cover fees and a later sale.</p>
    </Sheet>
  );
}
