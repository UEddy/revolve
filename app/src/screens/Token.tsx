// One token: the numbers that matter, the coach's warnings, and Buy.

import { useEffect, useState } from "react";
import { tokens, toRef, ultraOrder, usdPrice, isStock, type JupToken } from "../lib/jupiter.ts";
import { OrderApiError } from "../lib/orders.ts";
import { MOCK, SOL_MINT, SWAP_RESERVE_LAMPORTS, ZEC_MINT } from "../lib/config.ts";
import { afterSpread, formatZec, zecToUsd, type Limits } from "../lib/amount.ts";
import type { Chain, TokenRef } from "../lib/model.ts";
import { amountNote, buyWarnings, creditWarnings } from "../lib/coach.ts";
import { creditsFor } from "../lib/credits.ts";
import { useCredits, SpendRefused } from "../state/credits.tsx";
import { AmountEntry, useAmount, useLimits, zecLabel } from "../components/AmountEntry.tsx";
import { BalanceText } from "./Fund.tsx";
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
      <BuySheet open={buying} onClose={() => setBuying(false)} token={toRef(t)} estimate={t.id === SOL_MINT ? undefined : solanaEstimate(t)} />
    </div>
  );
}

/** A rough "you get" before any order exists: the amount's value in SOL, minus the reserve, quoted on Jupiter. */
function solanaEstimate(t: JupToken) {
  return async (zats: bigint, limits: Limits): Promise<number | null> => {
    const sol = await usdPrice(SOL_MINT);
    if (!sol) return null;
    // The payout (after the spread), less what stays in the wallet for gas.
    const lamports = BigInt(Math.floor((afterSpread(zecToUsd(zats, limits), limits) / sol) * 1e9)) - SWAP_RESERVE_LAMPORTS;
    if (lamports <= 0n) return 0;
    return units((await ultraOrder(SOL_MINT, t.id, lamports)).outAmount, t.decimals);
  };
}

/**
 * Buying one asset: the amount, credits or a Zodl payment, the coach's
 * warnings. `chain` picks the payout chain (and the wallet kind); `estimate`
 * gives the rough amount received, or is absent when there is nothing to swap.
 */
export function BuySheet({
  open,
  onClose,
  token: ref,
  chain = "solana",
  estimate: estimateFor,
}: {
  open: boolean;
  onClose: () => void;
  token: TokenRef;
  chain?: Chain;
  estimate?: (zats: bigint, limits: Limits) => Promise<number | null>;
}) {
  const { data } = useVault();
  const { startOrder } = useEngine();
  const { balance, credits, spendOnOrder } = useCredits();
  const [state, refreshLimits] = useLimits(open, chain);
  const limits = state.phase === "ready" ? state.limits : null;
  const a = useAmount(limits);
  const zats = a.zats;
  const [estimate, setEstimate] = useState<number | null>(null);
  const [busy, setBusy] = useState<"credits" | "zodl" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const need = zats !== null ? creditsFor(zats) : null;
  const enough = need !== null && balance >= need;
  const note = zats !== null && limits ? amountNote(zats, limits) : null;
  const warnings = [
    ...buyWarnings(ref, data?.positions ?? [], Date.now()),
    ...(note ? [note] : []),
    ...(enough ? creditWarnings(need, credits, Date.now()) : []),
  ];

  useEffect(() => {
    if (!open || zats === null || !limits || !estimateFor) return setEstimate(null);
    let live = true;
    const timer = setTimeout(() => {
      estimateFor(zats, limits).then(
        (n) => live && setEstimate(n),
        () => live && setEstimate(null),
      );
    }, 400);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // `limits` is compared by its rate only: a refresh with the same rate keeps the estimate.
    // `estimateFor` is a fresh closure each render; the asset it quotes is fixed for the sheet's life.
  }, [open, zats, limits?.usdPerZec, ref.mint]);

  const run = async (how: "credits" | "zodl") => {
    if (zats === null) return;
    setBusy(how);
    setError(null);
    try {
      const id = how === "credits" ? await spendOnOrder(ref, formatZec(zats), chain) : await startOrder(ref, formatZec(zats), chain);
      onClose();
      go(href.position(id));
    } catch (e) {
      setError(errorText(e));
      if ((e instanceof OrderApiError && e.status === 409) || (e instanceof SpendRefused && /more than Revolve can pay/.test(e.message))) refreshLimits();
    } finally {
      setBusy(null);
    }
  };

  const loading = state.phase === "loading";
  const creditsLabel = loading
    ? "Loading rates…"
    : zats === null
      ? a.text.trim()
        ? "Check the amount"
        : "Buy with credits"
      : !enough
        ? "Not enough credits"
        : `Buy with credits · ${zecLabel(zats)}`;
  return (
    <Sheet open={open} onClose={onClose}>
      <div className="row" style={{ marginBottom: 14 }}>
        <TokenIcon src={ref.icon} symbol={ref.symbol} />
        <div className="grow">
          <h3>Buy {ref.symbol}{chain === "base" ? " on Base" : ""}</h3>
          <div className="faint">Enter how much to spend.</div>
        </div>
      </div>
      <AmountEntry a={a} state={state} limits={limits} />
      <div className="card sunk" style={{ margin: "14px 0" }}>
        <div className="kv"><span>You pay</span><strong className="num">{zats !== null ? zecLabel(zats) : "–"}</strong></div>
        <div className="kv">
          <span>You get about</span>
          <span className="num">{!estimateFor || zats === null ? "–" : estimate === null ? "…" : `${amount(estimate)} ${ref.symbol}`}</span>
        </div>
        <div className="kv"><span>Goes to</span><span>A new {chain === "base" ? "Base " : ""}wallet, only on this phone</span></div>
        <div className="kv">
          <span>Your credits</span>
          <span><BalanceText credits={balance} /> · <a href={href.fund} onClick={onClose}>Add funds</a></span>
        </div>
      </div>
      <Warnings items={warnings} />
      <p className="faint center">Buying with credits asks for your passkey first. A small part of the payout stays in the wallet to cover fees and a later sale.</p>
      <div className="sheet-actions">
      {error && <p className="err">{error}</p>}
      <button className="btn" onClick={() => run("credits")} disabled={busy !== null || !enough}>
        {busy === "credits" ? <Spinner /> : null} {MOCK && enough ? `${creditsLabel} (demo)` : creditsLabel}
      </button>
      {!enough && zats !== null && !loading && (
        <p className="faint center" style={{ margin: "8px 0 0" }}>
          {balance === 0 ? "Add funds once, then buy with a tap of your passkey." : `You have ${balance} credit${balance === 1 ? "" : "s"}; this needs ${need}.`}
        </p>
      )}
      <div style={{ height: 8 }} />
      <button className="btn ghost" onClick={() => run("zodl")} disabled={busy !== null || zats === null}>
        {busy === "zodl" ? <Spinner /> : null} Pay from your Zcash wallet instead
      </button>
      </div>
    </Sheet>
  );
}
