// One token: the numbers that matter, the coach's warnings, and Buy.

import { useEffect, useState } from "react";
import { tokens, toRef, ultraOrder, usdPrice, isStock, type JupToken } from "../lib/jupiter.ts";
import { getLimits, OrderApiError } from "../lib/orders.ts";
import { MOCK, SOL_MINT, SWAP_RESERVE_LAMPORTS, ZEC_MINT } from "../lib/config.ts";
import { checkAmount, formatZec, zecToUsd, type AmountCheck, type Limits, type Unit } from "../lib/amount.ts";
import { amountNote, buyWarnings } from "../lib/coach.ts";
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

const LOADING_RETRY_MS: [number, number] = [3_000, 5_000];
const ERROR_RETRY_MS: [number, number] = [8_000, 12_000];
const REFRESH_MS: [number, number] = [45_000, 75_000];
const between = ([lo, hi]: [number, number]) => lo + Math.random() * (hi - lo);

/**
 * Amount limits while the sheet is open (GET /limits). "loading" until the
 * worker has a price and balance (503; ask again every 3 to 5 seconds),
 * then refreshed about once a minute since the max follows inventory.
 * "error" if the worker can't be reached; it keeps retrying.
 */
type LimitsPhase = { phase: "loading" } | { phase: "ready"; limits: Limits } | { phase: "error" };

function useLimits(open: boolean): [LimitsPhase, () => void] {
  const [state, setState] = useState<LimitsPhase>({ phase: "loading" });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!open) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = () =>
      getLimits().then(
        (r) => {
          if (!live) return;
          if (r.loading) {
            setState({ phase: "loading" });
            timer = setTimeout(ask, between(LOADING_RETRY_MS));
          } else {
            setState({ phase: "ready", limits: r.limits });
            timer = setTimeout(ask, between(REFRESH_MS));
          }
        },
        () => {
          if (!live) return;
          setState((s) => (s.phase === "ready" ? s : { phase: "error" }));
          timer = setTimeout(ask, between(ERROR_RETRY_MS));
        },
      );
    void ask();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [open, nonce]);
  useEffect(() => {
    if (!open) setState({ phase: "loading" });
  }, [open]);
  return [state, () => setNonce((n) => n + 1)];
}

const zecLabel = (zats: bigint) => `${formatZec(zats)} ZEC`;
const usdLabel = (zats: bigint, limits: Limits) => usd(zecToUsd(zats, limits));

/** The one line under the amount: what is wrong, or what the amount will be. */
function amountMessage(check: AmountCheck, unit: Unit, limits: Limits): { text: string; error: boolean } {
  switch (check.kind) {
    case "unavailable":
      return { text: "Buying is temporarily unavailable. Try again soon.", error: true };
    case "empty":
      return { text: `Between ${zecLabel(limits.min)} and ${zecLabel(limits.max)} (about ${usdLabel(limits.min, limits)} to ${usdLabel(limits.max, limits)}).`, error: false };
    case "invalid":
      return { text: unit === "USD" ? "Enter a dollar amount, like 5 or 5.50." : "Enter a ZEC amount, like 0.004.", error: true };
    case "below_min":
      return { text: `The minimum is ${zecLabel(limits.min)} (about ${usdLabel(limits.min, limits)}).`, error: true };
    case "above_max":
      return { text: `The most you can buy right now is ${zecLabel(limits.max)} (about ${usdLabel(limits.max, limits)}).`, error: true };
    case "ok":
      return unit === "USD"
        ? { text: `= ${zecLabel(check.zats)}${check.rounded ? ", rounded to the nearest 0.001 ZEC" : ""}`, error: false }
        : { text: `About ${usdLabel(check.zats, limits)}${check.rounded ? ". Rounded to the nearest 0.001 ZEC" : ""}`, error: false };
  }
}

function BuySheet({ open, onClose, t }: { open: boolean; onClose: () => void; t: JupToken }) {
  const { data } = useVault();
  const { startOrder } = useEngine();
  const sol = usePrice(SOL_MINT);
  const [state, refreshLimits] = useLimits(open);
  const limits = state.phase === "ready" ? state.limits : null;
  const [unit, setUnit] = useState<Unit>("USD");
  const [text, setText] = useState("");
  const [estimate, setEstimate] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = toRef(t);

  const check = limits ? checkAmount(text, unit, limits) : null;
  const zats = check?.kind === "ok" ? check.zats : null;
  const message = check && limits ? amountMessage(check, unit, limits) : null;
  const note = zats !== null && limits ? amountNote(zats, limits) : null;
  const warnings = [...buyWarnings(ref, data?.positions ?? [], Date.now()), ...(note ? [note] : [])];

  // Switching units keeps the amount: the ZEC side always shows the grid amount.
  const switchUnit = (next: Unit) => {
    if (next === unit) return;
    if (limits && check && "zats" in check && check.zats > 0n) {
      setText(next === "ZEC" ? formatZec(check.zats) : zecToUsd(check.zats, limits).toFixed(2));
    }
    setUnit(next);
  };

  // A rough "you get" before any order exists: the amount's value in SOL, minus the reserve, quoted on Jupiter.
  useEffect(() => {
    if (!open || zats === null || !limits || !sol || t.id === SOL_MINT) return setEstimate(null);
    let live = true;
    const timer = setTimeout(() => {
      const lamports = BigInt(Math.floor((zecToUsd(zats, limits) / sol) * 1e9)) - SWAP_RESERVE_LAMPORTS;
      if (lamports <= 0n) return live && setEstimate(0);
      ultraOrder(SOL_MINT, t.id, lamports).then(
        (q) => live && setEstimate(units(q.outAmount, t.decimals)),
        () => live && setEstimate(null),
      );
    }, 400);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // `limits` is compared by its rate only: a refresh with the same rate keeps the estimate.
  }, [open, zats, limits?.usdPerZec, sol, t.id, t.decimals]);

  const buy = async () => {
    if (zats === null) return;
    setBusy(true);
    setError(null);
    try {
      const id = await startOrder(ref, formatZec(zats));
      onClose();
      go(href.position(id));
    } catch (e) {
      setError(errorText(e));
      if (e instanceof OrderApiError && e.status === 409) refreshLimits();
    } finally {
      setBusy(false);
    }
  };

  const unavailable = check?.kind === "unavailable";
  return (
    <Sheet open={open} onClose={onClose}>
      <div className="row" style={{ marginBottom: 14 }}>
        <TokenIcon src={t.icon} symbol={t.symbol} />
        <div className="grow">
          <h3>Buy {t.symbol}</h3>
          <div className="faint">Enter how much to spend.</div>
        </div>
      </div>
      <div className={`amount${message?.error ? " invalid" : ""}`}>
        <div className="row">
          {unit === "USD" && <span className="amount-unit">$</span>}
          <input
            className="amount-input num"
            inputMode="decimal"
            autoComplete="off"
            placeholder={unit === "USD" ? "0.00" : "0.000"}
            aria-label={`Amount in ${unit}`}
            aria-describedby="amount-msg"
            value={text}
            disabled={unavailable}
            onChange={(e) => setText(e.target.value)}
          />
          {unit === "ZEC" && <span className="amount-unit">ZEC</span>}
        </div>
        <div className="seg unit" role="group" aria-label="Currency">
          {(["USD", "ZEC"] as const).map((u) => (
            <button key={u} aria-pressed={unit === u} onClick={() => switchUnit(u)}>
              {u}
            </button>
          ))}
        </div>
      </div>
      <p id="amount-msg" className={message?.error ? "err amount-msg" : "faint amount-msg"} aria-live="polite">
        {state.phase === "loading" ? (
          <span className="row" style={{ gap: 10 }} role="status">
            <Spinner /> Getting the latest rates…
          </span>
        ) : state.phase === "error" ? (
          "Can't reach Revolve right now. Retrying…"
        ) : (
          message?.text
        )}
      </p>
      <div className="card sunk" style={{ margin: "14px 0" }}>
        <div className="kv"><span>You pay</span><strong className="num">{zats !== null ? zecLabel(zats) : "–"}</strong></div>
        <div className="kv">
          <span>You get about</span>
          <span className="num">{t.id === SOL_MINT || zats === null ? "–" : estimate === null ? "…" : `${amount(estimate)} ${t.symbol}`}</span>
        </div>
        <div className="kv"><span>Goes to</span><span>A new wallet, only on this phone</span></div>
      </div>
      <Warnings items={warnings} />
      {error && <p className="err">{error}</p>}
      <div className="spacer" />
      <button className="btn" onClick={buy} disabled={busy || zats === null}>
        {busy ? <Spinner /> : null}{" "}
        {state.phase === "loading"
          ? "Loading rates…"
          : zats === null
            ? text.trim()
              ? "Check the amount"
              : "Enter an amount"
            : `${MOCK ? "Continue (demo)" : "Continue"} with ${zecLabel(zats)}`}
      </button>
      <p className="faint center">A small part of the payout stays in the wallet to cover fees and a later sale.</p>
    </Sheet>
  );
}
