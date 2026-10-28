// Portfolio: every position as one wallet on screen, each a separate,
// unlinked wallet underneath.

import { useVault } from "../state/vault.tsx";
import { useEngine } from "../state/engine.tsx";
import { positionRisk } from "../lib/coach.ts";
import { ZEC_MINT } from "../lib/config.ts";
import { WithdrawSheet } from "./Withdraw.tsx";
import { cashOf } from "../lib/chain.ts";
import { amount, usd, units, ago } from "../lib/format.ts";
import type { Funding, Position } from "../lib/model.ts";
import { useCredits } from "../state/credits.tsx";
import { BalanceText } from "./Fund.tsx";
import { useEffect, useState } from "react";
import { href } from "../router.ts";
import { Meter, Spinner, TokenIcon, Wordmark } from "../components/bits.tsx";
import { Lock, Mark } from "../components/icons.tsx";

const PENDING_TEXT: Partial<Record<Position["stage"], string>> = {
  sending: "Placing your order",
  awaiting_payment: "Waiting for your payment",
  settling: "Payment received, settling privately",
  funded: "Buying now",
  swapping: "Buying now",
  swap_failed: "Buy failed, tap to retry",
  needs_review: "Needs review, refund by hand",
};

function value(p: Position, prices: Record<string, number>): { asset: number | null; cash: number } {
  const held = units(p.balance?.tokenRaw ?? p.swap?.outAmount, p.token.decimals);
  const px = prices[p.token.mint];
  const c = cashOf(p);
  return { asset: px === undefined ? null : held * px, cash: units(p.balance?.lamports, c.decimals) * (prices[c.mint] ?? 0) };
}

const FUNDING_TEXT: Partial<Record<Funding["status"], string>> = {
  awaiting_payment: "Waiting for your payment",
  seen: "Payment received, confirming",
  funded: "Issuing your credits",
  needs_review: "Needs review",
};

/** A cash-in (v1.5) is a funding paid from a position; it reads as such. */
const CASHIN_TEXT: Partial<Record<Funding["status"], string>> = {
  awaiting_payment: "Sending from your position",
  funded: "Issuing your credits",
  needs_review: "Needs review",
};

const WITHDRAW_TEXT = { sending: "Sending your request", queued: "Paying within about 2 hours", sent: "Sent, shielded", failed: "Needs a look" } as const;

function CreditsCard() {
  const { balance, credits } = useCredits();
  const [withdrawing, setWithdrawing] = useState(false);
  const open = (credits?.fundings ?? []).filter((f) => (f.cashin ? CASHIN_TEXT : FUNDING_TEXT)[f.status]);
  const day = Date.now() - 24 * 3600_000;
  const outs = (credits?.withdrawals ?? []).filter((w) => w.status !== "sent" || w.createdAt > day);
  return (
    <>
      <div className="card flat row" style={{ marginTop: 18 }}>
        <div className="grow">
          <div className="eyebrow">Credits</div>
          <div style={{ marginTop: 6, fontWeight: 600 }}><BalanceText credits={balance} /></div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          {balance > 0 && <button className="btn small ghost" onClick={() => setWithdrawing(true)}>Withdraw</button>}
          <a className="btn small" href={href.fund}>Add funds</a>
        </div>
      </div>
      {open.length > 0 && (
        <div className="list" style={{ marginTop: 10 }}>
          {open.map((f) => (
            <a key={f.fundId} className="trow" href={href.funding(f.fundId)}>
              <span className="ticon"><Mark style={{ width: 26, height: 26 }} /></span>
              <div className="grow">
                <div className="name">{f.cashin ? `Cashing out ${f.amountZec} ZEC to credits` : `Adding ${f.amountZec} ZEC`}</div>
                <div className="sub">{(f.cashin ? CASHIN_TEXT : FUNDING_TEXT)[f.status]}</div>
              </div>
              <div className="right">{f.status === "funded" || f.status === "seen" ? <Spinner /> : null}</div>
            </a>
          ))}
        </div>
      )}
      {outs.length > 0 && (
        <div className="list" style={{ marginTop: 10 }}>
          {outs.map((w) => (
            <div key={w.key} className="trow">
              <span className="ticon"><Mark style={{ width: 26, height: 26 }} /></span>
              <div className="grow">
                <div className="name">Withdrawing {w.amountZec} ZEC</div>
                <div className="sub">{w.error ?? WITHDRAW_TEXT[w.status]}</div>
              </div>
              <div className="right">{w.status === "sending" || w.status === "queued" ? <Spinner /> : null}</div>
            </div>
          ))}
        </div>
      )}
      <WithdrawSheet open={withdrawing} onClose={() => setWithdrawing(false)} />
    </>
  );
}

export function Home() {
  const { data, lock } = useVault();
  const { prices, busy, priceOf } = useEngine();
  useEffect(() => priceOf(ZEC_MINT), [priceOf]);
  const all = data?.positions ?? [];
  const holdings = all.filter((p) => p.stage === "held" || (p.stage === "closed" && BigInt(p.balance?.lamports ?? "0") > 10_000n));
  const pending = all.filter((p) => PENDING_TEXT[p.stage]);
  const totals = holdings.map((p) => value(p, prices));
  const total = totals.reduce((s, v) => s + (v.asset ?? 0) + v.cash, 0);
  const pricing = totals.some((v) => v.asset === null);

  return (
    <div className="screen">
      <div className="row" style={{ marginBottom: 6 }}>
        <span className="grow">
          <Wordmark height={28} />
        </span>
        <button className="icon-btn" onClick={lock} aria-label="Lock">
          <Lock />
        </button>
      </div>

      <div className="hero">
        <div className="eyebrow">Portfolio</div>
        <div className="total num" style={{ marginTop: 8 }}>
          {holdings.length ? usd(total) : "$0"}
          {pricing && <small> …</small>}
        </div>
        <div className="muted small" style={{ marginTop: 6 }}>
          {holdings.length
            ? `across ${holdings.length} private wallet${holdings.length === 1 ? "" : "s"}, none linked to another`
            : "Nothing here yet"}
        </div>
        <a className="small" href={href.history} style={{ display: "inline-block", marginTop: 8 }}>Transaction history</a>
      </div>

      <CreditsCard />

      {pending.length > 0 && (
        <>
          <h2>In progress</h2>
          <div className="list">
            {pending.map((p) => (
              <a key={p.id} className="trow" href={href.position(p.id)}>
                <TokenIcon src={p.token.icon} symbol={p.token.symbol} />
                <div className="grow">
                  <div className="name">{p.token.symbol}</div>
                  <div className="sub">{PENDING_TEXT[p.stage]}</div>
                </div>
                <div className="right">{busy[p.id] || p.stage === "settling" ? <Spinner /> : <span className="faint">{p.order.amountZec} ZEC</span>}</div>
              </a>
            ))}
          </div>
        </>
      )}

      <h2>Holdings</h2>
      {holdings.length ? (
        <div className="list">
          {holdings.map((p, i) => {
            const v = totals[i]!;
            const risk = positionRisk(p, all);
            const held = units(p.balance?.tokenRaw ?? p.swap?.outAmount, p.token.decimals);
            return (
              <a key={p.id} className="trow" href={href.position(p.id)}>
                <TokenIcon src={p.token.icon} symbol={p.token.symbol} />
                <div className="grow">
                  <div className="name">{p.stage === "closed" ? "Cash" : p.token.symbol} {p.demo && <span className="badge caution">Demo</span>}</div>
                  <div className="sub">
                    {p.stage === "closed" ? `from ${p.token.symbol}` : `${amount(held)} ${p.token.symbol}`} · {ago(p.createdAt)}
                  </div>
                </div>
                <div className="right">
                  <div className="num">{p.stage === "closed" ? usd(v.cash) : usd(v.asset)}</div>
                  <Meter level={risk.level} />
                </div>
              </a>
            );
          })}
        </div>
      ) : (
        <div className="card flat empty">
          <p style={{ marginTop: 0 }}>Buy a token or a stock with shielded ZEC. Each one lands in its own fresh wallet.</p>
          <a className="btn" href={href.discover}>Find something to buy</a>
        </div>
      )}

      <p className="faint center" style={{ marginTop: 22 }}>
        Balances refresh one wallet at a time, at random moments, through a relay, so nobody can tie your wallets together.
      </p>
    </div>
  );
}
