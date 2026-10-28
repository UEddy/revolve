// One position: paying for it, following the order, and once it lands,
// its value, its linkability and what you can do with it.

import { useEffect, useState } from "react";
import { base58 } from "@scure/base";
import { fromB64 } from "../lib/bytes.ts";
import { pubkeyBytes } from "../lib/burner.ts";
import { useVault } from "../state/vault.tsx";
import { useEngine } from "../state/engine.tsx";
import { buildMemo } from "../lib/memo.ts";
import { positionRisk } from "../lib/coach.ts";
import { MOCK } from "../lib/config.ts";
import { cashOf, chainName } from "../lib/chain.ts";
import { exportEvmKey } from "../lib/evm.ts";
import { amount, countdown, usd, units } from "../lib/format.ts";
import type { Position } from "../lib/model.ts";
import { CANCELLED_TEXT, CancelPayment, Meter, Sheet, Spinner, TokenIcon, TopBar, errorText } from "../components/bits.tsx";
import { Check } from "../components/icons.tsx";
import { PayCard } from "../components/PayCard.tsx";
import { href, go } from "../router.ts";
import { SendSheet } from "./Send.tsx";
import { CashOutSheet } from "./CashOut.tsx";

type Step = { key: string; label: string; detail?: string };

function steps(p: Position): { list: Step[]; at: number } {
  if (p.paidWith === "credits") {
    // Credits are already backed: no Zcash confirmations, just the privacy delay.
    const list: Step[] = [
      { key: "send", label: "Paid with credits", detail: "Sending your order (retried with the same credits if the network drops)" },
      { key: "delay", label: "Privacy delay", detail: "A random 1 to 5 minute wait, so timing can't pair your tap with the payout" },
      { key: "deliver", label: "Delivered to your new wallet" },
      { key: "buy", label: `Bought ${p.token.symbol}` },
    ];
    let at = p.stage === "sending" ? 0 : 1;
    if (p.order.status === "paid_out" || p.stage === "funded" || p.stage === "swapping" || p.stage === "swap_failed") at = 2;
    if (p.stage === "swapping" || p.stage === "funded") at = 3;
    if (p.stage === "held" || p.stage === "closed") at = 4;
    return { list, at };
  }
  const conf = Math.min(3, p.order.confirmations);
  const list: Step[] = [
    { key: "pay", label: "Pay from your Zcash wallet", detail: `${p.order.amountZec} ZEC, shielded` },
    { key: "seen", label: "Payment seen", detail: "Still shielded. Nobody can see who paid." },
    { key: "conf", label: "Confirming", detail: `${conf} of 3 blocks` },
    { key: "delay", label: "Privacy delay", detail: "A random 2 to 6 block wait, so timing can't pair you with the payout" },
    { key: "deliver", label: "Delivered to your new wallet" },
    { key: "buy", label: `Bought ${p.token.symbol}` },
  ];
  const s = p.order.status;
  let at = 0;
  if (s === "seen") at = p.order.confirmations > 0 ? 2 : 1;
  if (s === "confirmed") at = 3;
  if (s === "paid_out" || s === "gone" || p.stage === "funded" || p.stage === "swapping" || p.stage === "swap_failed") at = 4;
  if (p.stage === "swapping" || p.stage === "funded") at = 5;
  if (p.stage === "held" || p.stage === "closed") at = 6;
  return { list, at };
}

function Steps({ p }: { p: Position }) {
  const { list, at } = steps(p);
  return (
    <ol className="steps">
      {list.map((s, i) => (
        <li key={s.key} className={i < at ? "done" : i === at ? "now" : "todo"}>
          <span className="node">{i < at && <Check />}</span>
          <div>
            <div className="label">{s.label}</div>
            {i === at && s.detail && <div className="faint">{s.detail}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}

export function PositionScreen({ id }: { id: string }) {
  const { data, updatePosition, confirm } = useVault();
  const { prices, busy, retrySwap, sell, cancel, pricePosition } = useEngine();
  const [cancelled, setCancelled] = useState(false);
  const [sending, setSending] = useState(false);
  const [selling, setSelling] = useState(false);
  const [cashingOut, setCashingOut] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const all = data?.positions ?? [];
  const p = all.find((x) => x.id === id);
  const mint = p?.token.mint;
  useEffect(() => {
    if (p) pricePosition(p);
    // Once per asset, not on every balance update.
  }, [mint, pricePosition]);
  if (!p && cancelled) {
    return (
      <div className="screen">
        <TopBar title="" />
        <div className="card flat">
          <h3>Payment cancelled</h3>
          <p className="muted">{CANCELLED_TEXT}</p>
          <a className="btn ghost" href={href.home}>Back to portfolio</a>
        </div>
      </div>
    );
  }
  if (!p) return <div className="screen"><TopBar title="" /><p className="empty">This position is not in your vault.</p></div>;

  const held = units(p.balance?.tokenRaw ?? p.swap?.outAmount, p.token.decimals);
  const value = prices[p.token.mint] !== undefined ? held * prices[p.token.mint]! : null;
  const c = cashOf(p);
  const cash = units(p.balance?.lamports, c.decimals) * (prices[c.mint] ?? 0);
  // Both chains cash out privately to credits; Zodl's Swap (SOL only) is the second route on Solana.
  const plan = p.cashoutPlan;
  const planLeft = plan?.parts.filter((x) => !x.fundId && !x.skipped) ?? [];
  const canCashOut = planLeft.length === 0;
  const planDone = plan ? plan.parts.filter((x) => x.fundId).reduce((n, x) => n + x.credits, 0) : 0;
  const tokenHref = p.chain === "base" ? href.baseToken(p.token.mint) : href.token(p.token.mint);
  const risk = positionRisk(p, all);
  const live = p.stage === "held" || p.stage === "closed";
  const doing = busy[p.id];

  return (
    <div className="screen">
      <TopBar title="" right={p.demo ? <span className="badge caution">Demo</span> : undefined} />
      <div className="row">
        <TokenIcon src={p.token.icon} symbol={p.token.symbol} large />
        <div className="grow">
          <div className="eyebrow">{p.token.isStock ? "Stock" : "Token"}</div>
          <h1 style={{ margin: "4px 0 0", fontSize: 26 }}>{p.token.name}</h1>
          <a className="small" href={tokenHref}>{p.token.symbol}</a>{p.chain === "base" && <span className="badge" style={{ marginLeft: 6 }}>Base</span>}
        </div>
      </div>

      {live ? (
        <>
          <div className="hero" style={{ textAlign: "left", padding: "18px 0 6px" }}>
            <div className="total num">{usd(value)}</div>
            <div className="muted num">{amount(held)} {p.token.symbol}{cash > 0.01 ? ` · ${usd(cash)} cash for fees` : ""}</div>
          </div>
          <h2>Linkability</h2>
          <div className="card flat">
            <div className="row" style={{ marginBottom: 10 }}>
              <div className="grow"><Meter level={risk.level} label /></div>
              <span className="num faint">{risk.score}/100</span>
            </div>
            <ul style={{ margin: 0, paddingLeft: 18 }} className="small muted">
              {risk.reasons.map((r) => <li key={r.text} style={{ marginBottom: 4 }}>{r.text}</li>)}
            </ul>
          </div>
          <div className="spacer" />
          {error && <p className="err">{error}</p>}
          {plan && (
            <div className="card flat small" style={{ marginBottom: 12 }}>
              <b>Cashing out to credits{plan.mode === "gradual" ? ", gradually" : ""}</b>
              <p className="muted" style={{ margin: "6px 0 0" }}>
                {planLeft.length === 0
                  ? `Done: ${planDone} credits sent to your balance.`
                  : `${plan.parts.length - planLeft.length} of ${plan.parts.length} parts sent. Next at ${new Date(Math.min(...planLeft.map((x) => x.at))).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}; keep Revolve open around then, or it goes out next time you open it.`}
              </p>
              {planLeft.length > 0 && plan.lastError && <p className="err" style={{ margin: "6px 0 0" }}>Waiting to retry: {plan.lastError}</p>}
            </div>
          )}
          {p.stage === "held" && (
            <div className="stack">
              <button className="btn" disabled={!!doing} onClick={() => setSelling(true)}>{doing === "Selling" ? <Spinner /> : null} Sell to cash</button>
              {canCashOut && <button className="btn ghost" disabled={!!doing} onClick={() => setCashingOut(true)}>Cash out</button>}
              <button className="btn ghost" onClick={() => setSending(true)}>Send out</button>
            </div>
          )}
          {p.stage === "closed" && (
            <div className="stack">
              <p className="muted center">Sold. The {c.symbol} stays in this wallet{canCashOut ? "" : " until the cash-out below takes it"}.</p>
              {canCashOut && BigInt(p.balance?.lamports ?? "0") > 0n && (
                <button className="btn" onClick={() => setCashingOut(true)}>Cash out</button>
              )}
            </div>
          )}
        </>
      ) : (
        <>
          <div className="spacer" />
          {p.stage === "awaiting_payment" && (
            <PayCard
              depositUa={p.order.depositUa}
              amountZec={p.order.amountZec}
              memo={() => buildMemo(p.order.id, p.burner.pub, p.chain)}
              expiresAt={p.order.quoteExpiresAt}
              memoNote="The message tells the payout where to go and is encrypted on chain."
            />
          )}
          {p.stage === "awaiting_payment" && !p.paidWith && (
            <>
              <div className="spacer" />
              <CancelPayment what="order and its new wallet" run={() => cancel(p.id).then(() => setCancelled(true))} />
            </>
          )}
          {p.stage === "expired" && (
            <div className="card flat">
              <h3>Quote expired</h3>
              <p className="muted">No payment arrived in time. Nothing was charged. If you did pay, it will be refunded by hand.</p>
              <button className="btn ghost" onClick={() => go(tokenHref)}>Start a new order</button>
            </div>
          )}
          {p.stage === "needs_review" && (
            <div className="card flat">
              <h3>Payment needs a look</h3>
              <p className="muted">The amount or memo didn't match this order. It will be refunded by hand. Keep this order id: <span className="mono">{p.order.id}</span></p>
            </div>
          )}
          {p.stage === "swap_failed" && (
            <div className="card flat">
              <h3>The buy didn't go through</h3>
              <p className="muted">{p.swap?.error ?? "Unknown error"}. Your funds are safe in this position's wallet.</p>
              <button className="btn" disabled={!!doing} onClick={() => retrySwap(p.id).catch((e) => setError(errorText(e)))}>{doing ? <Spinner /> : null} Try again</button>
            </div>
          )}
          <div className="spacer" />
          <div className="card flat">
            <Steps p={p} />
          </div>
        </>
      )}

      <h2>Details</h2>
      <div className="card flat small">
        <div className="kv"><span>Order</span><span className="mono">{p.order.id}</span></div>
        <div className="kv"><span>Paid</span><span>{p.order.amountZec} ZEC</span></div>
        <div className="kv"><span>Opened</span><span>{new Date(p.createdAt).toLocaleString()}</span></div>
        <div className="kv"><span>Chain</span><span>{chainName(p)}</span></div>
        <div className="kv"><span>Wallet</span><span className="mono">{p.burner.pub.slice(0, 6)}…{p.burner.pub.slice(-6)}</span></div>
      </div>
      <div className="spacer" />
      <button className="btn ghost" onClick={() => setShowKey(true)}>Export this wallet's key</button>

      <Sheet open={selling} onClose={() => setSelling(false)}>
        <h3 className="display" style={{ fontSize: 20 }}>Sell all {p.token.symbol}?</h3>
        <p className="muted">It is sold for cash inside this same wallet. Nothing moves to any other address, so nothing new is linked.</p>
        <button
          className="btn"
          onClick={() => {
            setSelling(false);
            setError(null);
            sell(p.id).catch((e) => setError(errorText(e)));
          }}
        >
          Sell
        </button>
      </Sheet>
      <SendSheet open={sending} onClose={() => setSending(false)} p={p} />
      <CashOutSheet open={cashingOut} onClose={() => setCashingOut(false)} p={p} />
      <KeySheet open={showKey} onClose={() => setShowKey(false)} p={p} onReveal={() => updatePosition(p.id, (x) => void (x.keyRevealed = true))} confirm={confirm} />
    </div>
  );
}

function KeySheet({ open, onClose, p, onReveal, confirm }: { open: boolean; onClose: () => void; p: Position; onReveal: () => void; confirm: () => Promise<void> }) {
  const [shown, setShown] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) {
      setShown(false);
      setError(null);
    }
  }, [open]);
  return (
    <Sheet open={open} onClose={onClose}>
      <h3 className="display" style={{ fontSize: 20 }}>Export key</h3>
      <div className="warn high" style={{ margin: "12px 0" }}>
        <span className="dot" />
        <div>
          <b>Import it on its own</b>
          <p>A wallet app that holds this key next to your other wallets, or your known wallet, can link them. Anyone with this key can take the funds.</p>
        </div>
      </div>
      {error && <p className="err">{error}</p>}
      {shown ? (
        <p className="mono card sunk">{exportKey(p)}</p>
      ) : (
        <button
          className="btn danger"
          onClick={() => {
            setError(null);
            // The key can take everything in this wallet: shown only after a fresh passkey check.
            (p.demo ? Promise.resolve() : confirm()).then(
              () => {
                setShown(true);
                onReveal();
              },
              (e: unknown) => setError(errorText(e)),
            );
          }}
        >
          Show key
        </button>
      )}
    </Sheet>
  );
}

/** Phantom and Solflare take the 64-byte secret key (seed then public key) as base58; MetaMask and Rabby a 0x hex key. */
function exportKey(p: Position): string {
  if (p.chain === "base") return exportEvmKey(p.burner);
  const seed = fromB64(p.burner.seed);
  const full = new Uint8Array(64);
  full.set(seed, 0);
  full.set(pubkeyBytes(p.burner.pub), 32);
  seed.fill(0);
  const out = base58.encode(full);
  full.fill(0);
  return out;
}
