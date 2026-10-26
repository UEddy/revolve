// One position: paying for it, following the order, and once it lands,
// its value, its linkability and what you can do with it.

import { useEffect, useState } from "react";
import { base58 } from "@scure/base";
import { fromB64 } from "../lib/bytes.ts";
import { pubkeyBytes } from "../lib/burner.ts";
import { useVault } from "../state/vault.tsx";
import { useEngine, paymentLink } from "../state/engine.tsx";
import { positionRisk } from "../lib/coach.ts";
import { MOCK, SOL_MINT } from "../lib/config.ts";
import { amount, countdown, usd, units } from "../lib/format.ts";
import type { Position } from "../lib/model.ts";
import { Meter, Sheet, Spinner, TokenIcon, TopBar, errorText } from "../components/bits.tsx";
import { Check } from "../components/icons.tsx";
import { href, go } from "../router.ts";
import { SendSheet } from "./Send.tsx";

function useNow(every = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(t);
  }, [every]);
  return now;
}

type Step = { key: string; label: string; detail?: string };

function steps(p: Position): { list: Step[]; at: number } {
  const conf = Math.min(3, p.order.confirmations);
  const list: Step[] = [
    { key: "pay", label: "Pay from Zodl", detail: `${p.order.amountZec} ZEC, shielded` },
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

function PayCard({ p }: { p: Position }) {
  const now = useNow();
  const left = Date.parse(p.order.quoteExpiresAt) - now;
  const [copied, setCopied] = useState(false);
  let link = "";
  let bad: string | null = null;
  try {
    link = paymentLink(p);
  } catch (e) {
    bad = errorText(e);
  }
  if (bad) return <p className="err">{bad}</p>;
  return (
    <div className="card">
      <div className="eyebrow">Pay</div>
      <div className="display" style={{ fontSize: 34, margin: "6px 0 2px" }}>{p.order.amountZec} ZEC</div>
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
        Zodl opens with the amount and a private memo filled in. Just confirm. The memo tells the payout where to go and is
        encrypted on chain.
      </p>
    </div>
  );
}

export function PositionScreen({ id }: { id: string }) {
  const { data, updatePosition } = useVault();
  const { prices, busy, retrySwap, sell } = useEngine();
  const [sending, setSending] = useState(false);
  const [selling, setSelling] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const all = data?.positions ?? [];
  const p = all.find((x) => x.id === id);
  if (!p) return <div className="screen"><TopBar title="" /><p className="empty">This position is not in your vault.</p></div>;

  const held = units(p.balance?.tokenRaw ?? p.swap?.outAmount, p.token.decimals);
  const value = prices[p.token.mint] !== undefined ? held * prices[p.token.mint]! : null;
  const cash = units(p.balance?.lamports, 9) * (prices[SOL_MINT] ?? 0);
  const risk = positionRisk(p, all);
  const live = p.stage === "held" || p.stage === "closed";
  const doing = busy[p.id];

  return (
    <div className="screen">
      <TopBar title="" right={p.demo ? <span className="badge warn">Demo</span> : undefined} />
      <div className="row">
        <TokenIcon src={p.token.icon} symbol={p.token.symbol} large />
        <div className="grow">
          <div className="eyebrow">{p.token.isStock ? "Stock" : "Token"}</div>
          <h1 style={{ margin: "4px 0 0", fontSize: 26 }}>{p.token.name}</h1>
          <a className="small" href={href.token(p.token.mint)}>{p.token.symbol}</a>
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
          {p.stage === "held" && (
            <div className="stack">
              <button className="btn" disabled={!!doing} onClick={() => setSelling(true)}>{doing === "Selling" ? <Spinner /> : null} Sell to cash</button>
              <button className="btn ghost" onClick={() => setSending(true)}>Send out</button>
            </div>
          )}
          {p.stage === "closed" && <p className="muted center">Sold. The cash stays in this wallet.</p>}
        </>
      ) : (
        <>
          <div className="spacer" />
          {p.stage === "awaiting_payment" && <PayCard p={p} />}
          {p.stage === "expired" && (
            <div className="card flat">
              <h3>Quote expired</h3>
              <p className="muted">No payment arrived in time. Nothing was charged. If you did pay, it will be refunded by hand.</p>
              <button className="btn ghost" onClick={() => go(href.token(p.token.mint))}>Start a new order</button>
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
              <button className="btn" disabled={!!doing} onClick={() => retrySwap(p.id)}>{doing ? <Spinner /> : null} Try again</button>
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
      <KeySheet open={showKey} onClose={() => setShowKey(false)} p={p} onReveal={() => updatePosition(p.id, (x) => void (x.keyRevealed = true))} />
    </div>
  );
}

function KeySheet({ open, onClose, p, onReveal }: { open: boolean; onClose: () => void; p: Position; onReveal: () => void }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!open) setShown(false);
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
      {shown ? (
        <p className="mono card sunk">{exportKey(p)}</p>
      ) : (
        <button
          className="btn danger"
          onClick={() => {
            setShown(true);
            onReveal();
          }}
        >
          Show key
        </button>
      )}
    </Sheet>
  );
}

/** Phantom and Solflare take the 64-byte secret key (seed then public key) as base58. */
function exportKey(p: Position): string {
  const seed = fromB64(p.burner.seed);
  const full = new Uint8Array(64);
  full.set(seed, 0);
  full.set(pubkeyBytes(p.burner.pub), 32);
  seed.fill(0);
  const out = base58.encode(full);
  full.fill(0);
  return out;
}
