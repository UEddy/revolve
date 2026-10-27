// The recreated flows, built from the app's own components (PayCard,
// TopBar, TokenIcon, Meter, icons) and its own markup and CSS classes, with
// the texts the live app shows. Shown only inside a captioned phone.
//
// Data here is illustrative but real in kind: token names and prices come
// from the live snapshot; the deposit address is a placeholder with the shape
// of a unified address (an invalid checksum, so a viewer can't pay to it).

import type { ReactNode } from "react";
import { PayCard } from "../../../app/src/components/PayCard.tsx";
import { Meter, Spinner, TokenIcon, TopBar } from "../../../app/src/components/bits.tsx";
import { Check, Lock } from "../../../app/src/components/icons.tsx";
import { buildFundMemo } from "../../../app/src/lib/credits.ts";
import wordmarkDark from "../../../app/src/assets/brand/revolve-wordmark-dark.svg";
import type { JupToken } from "../../../app/src/lib/jupiter.ts";
import { PRICES, pick } from "./data";
import { Tabs } from "./Discover";

const BECH32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
/** Unified-address shaped, 106 characters, not a real address. */
export const PLACEHOLDER_UA = "u1" + Array.from({ length: 104 }, (_, i) => BECH32[(i * 7 + 3 * (i % 5)) % 32]).join("");
const FUND_ID = "rf_7h2kq9mxw4";
const ZEC = PRICES["A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS"] ?? 1260;

/** The buy shown: a trending token from the live snapshot. */
export const BUY_TOKEN = pick("STONK");
const usd = (v: number) => `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const BUY_ZEC = 0.004;
const HELD = (BUY_ZEC * ZEC * 0.97) / (BUY_TOKEN.usdPrice ?? 1);

/** Scrolls a screen's content by `y` CSS px (the video's clock decides). */
export function Scroll({ y, children }: { y: number; children: ReactNode }) {
  return <div style={{ translate: `0 ${-y}px` }}>{children}</div>;
}

export function AddFunds() {
  return (
    <div className="screen">
      <TopBar title="Add funds" />
      <PayCard
        depositUa={PLACEHOLDER_UA}
        amountZec="0.01"
        memo={() => buildFundMemo(FUND_ID)}
        expiresAt={new Date(Date.now() + 15 * 60_000).toISOString()}
        memoNote="The message only names this funding; it carries nothing about you and is encrypted on chain."
      />
    </div>
  );
}

export function CreditsAdded() {
  return (
    <div className="screen">
      <TopBar title="Add funds" />
      <div className="card">
        <div className="eyebrow">Added</div>
        <div className="display" style={{ fontSize: 30, margin: "6px 0 2px" }}>10 credits</div>
        <div className="muted">
          0.01 ZEC, ready to spend. Balance: <span className="num">0.01 ZEC · {usd(0.01 * ZEC)}</span>
        </div>
        <div className="spacer" />
        <a className="btn">Find something to buy</a>
      </div>
    </div>
  );
}

function TokenHeader({ t }: { t: JupToken }) {
  return (
    <div className="row">
      <TokenIcon src={t.icon} symbol={t.symbol} large />
      <div className="grow">
        <div className="eyebrow">Token</div>
        <h1 style={{ margin: "4px 0 0", fontSize: 26 }}>{t.name}</h1>
        <a className="small">{t.symbol}</a>
      </div>
    </div>
  );
}

/** The token page with the buy sheet open, paying with credits. `pressed` shows the button busy. */
export function BuySheet({ pressed }: { pressed: boolean }) {
  const t = BUY_TOKEN;
  return (
    <div className="screen">
      <TopBar title="" />
      <TokenHeader t={t} />
      <div className="scrim" />
      <div className="sheet" role="dialog">
        <div className="grab" />
        <div className="row" style={{ marginBottom: 14 }}>
          <TokenIcon src={t.icon} symbol={t.symbol} />
          <div className="grow">
            <h3>Buy {t.symbol}</h3>
            <div className="faint">Enter how much to spend.</div>
          </div>
        </div>
        <div className="amount">
          <div className="row">
            <input className="amount-input num" value="0.004" readOnly />
            <span className="amount-unit">ZEC</span>
          </div>
          <div className="seg unit" role="group">
            <button aria-pressed="false">USD</button>
            <button aria-pressed="true">ZEC</button>
          </div>
        </div>
        <p className="faint amount-msg">About {usd(BUY_ZEC * ZEC)}</p>
        <div className="card sunk" style={{ margin: "14px 0" }}>
          <div className="kv"><span>You pay</span><strong className="num">0.004 ZEC</strong></div>
          <div className="kv"><span>You get about</span><span className="num">{Math.round(HELD).toLocaleString("en-US")} {t.symbol}</span></div>
          <div className="kv"><span>Goes to</span><span>A new wallet, only on this phone</span></div>
          <div className="kv"><span>Your credits</span><span className="num">0.01 ZEC · {usd(0.01 * ZEC)}</span></div>
        </div>
        <button className="btn">{pressed ? <Spinner /> : null} Buy with credits · 0.004 ZEC</button>
        <div style={{ height: 8 }} />
        <button className="btn ghost">Pay from your Zcash wallet instead</button>
      </div>
    </div>
  );
}

/** The position while a credits order settles: the app's own steps for that path. */
export function BuySteps({ at }: { at: number }) {
  const t = BUY_TOKEN;
  const list = [
    { label: "Paid with credits", detail: "Sending your order (retried with the same credits if the network drops)" },
    { label: "Privacy delay", detail: "A random 1 to 5 minute wait, so timing can't pair your tap with the payout" },
    { label: "Delivered to your new wallet" },
    { label: `Bought ${t.symbol}` },
  ];
  return (
    <div className="screen">
      <TopBar title="" />
      <TokenHeader t={t} />
      <div className="spacer" />
      <div className="card flat">
        <ol className="steps">
          {list.map((s, i) => (
            <li key={s.label} className={i < at ? "done" : i === at ? "now" : "todo"}>
              <span className="node">{i < at && <Check />}</span>
              <div>
                <div className="label">{s.label}</div>
                {i === at && s.detail && <div className="faint">{s.detail}</div>}
              </div>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

/** Portfolio: wordmark header, total, credits, holdings (the bought token on top). */
export function Portfolio() {
  const t = BUY_TOKEN;
  const value = HELD * (t.usdPrice ?? 0);
  return (
    <div className="screen">
      <div className="row" style={{ marginBottom: 6 }}>
        <span className="grow">
          <img src={wordmarkDark} alt="Revolve" height={28} width={115} style={{ display: "block" }} />
        </span>
        <button className="icon-btn" aria-label="Lock"><Lock /></button>
      </div>
      <div className="hero">
        <div className="eyebrow">Portfolio</div>
        <div className="total num" style={{ marginTop: 8 }}>{usd(value)}</div>
        <div className="muted small" style={{ marginTop: 6 }}>across 1 private wallet, none linked to another</div>
      </div>
      <div className="card flat row" style={{ marginTop: 18 }}>
        <div className="grow">
          <div className="eyebrow">Credits</div>
          <div style={{ marginTop: 6, fontWeight: 600 }}><span className="num">0.006 ZEC · {usd(0.006 * ZEC)}</span></div>
        </div>
        <a className="btn small">Add funds</a>
      </div>
      <h2>Holdings</h2>
      <div className="list">
        <a className="trow">
          <TokenIcon src={t.icon} symbol={t.symbol} />
          <div className="grow">
            <div className="name">{t.symbol}</div>
            <div className="sub">{Math.round(HELD).toLocaleString("en-US")} {t.symbol} · just now</div>
          </div>
          <div className="right">
            <div className="num">{usd(value)}</div>
            <Meter level="low" />
          </div>
        </a>
      </div>
      <Tabs at="home" />
    </div>
  );
}

/** A sold position's page with the Cash out sheet: Zodl's steps and the filled form, or the review. */
export function CashOutSheet({ step }: { step: "position" | "form" | "review" }) {
  const t = BUY_TOKEN;
  const deposit = "9wQkP3vXr7Zm2LhT5bNcYd8sJf4GaE6uKqWo1RtVyBzA"; // Solana-shaped placeholder
  return (
    <div className="screen">
      <TopBar title="" />
      <TokenHeader t={t} />
      <div className="hero" style={{ textAlign: "left", padding: "18px 0 6px" }}>
        <div className="total num">{usd(0.0249 * (PRICES["So11111111111111111111111111111111111111112"] ?? 100))}</div>
        <div className="muted num">Sold. The cash stays in this wallet.</div>
      </div>
      <div className="spacer" />
      <div className="stack">
        <button className="btn">Cash out to Zcash</button>
      </div>
      {step !== "position" && (
        <>
          <div className="scrim" />
          <div className="sheet" role="dialog">
            <div className="grab" />
            <h3 className="display" style={{ fontSize: 20 }}>Cash out to Zcash</h3>
            {step === "form" ? (
              <>
                <ol className="howto">
                  <li>Open <b>Zodl</b> and tap <b>Swap</b>.</li>
                  <li>Choose <b>SOL on Solana</b> as what you pay with, and ZEC to receive.</li>
                  <li>Enter the amount below (up to <span className="num">0.0249</span> SOL), and continue.</li>
                  <li>Copy the <b>deposit address</b> and the <b>exact amount</b> Zodl shows, and paste them here.</li>
                </ol>
                <label className="field-label">Zodl's deposit address (Solana)</label>
                <div className="row">
                  <input className="input grow" value={deposit} readOnly />
                  <button className="btn small ghost">Paste</button>
                </div>
                <label className="field-label">Exact amount (SOL)</label>
                <div className="row">
                  <input className="input grow num" value="0.0249" readOnly />
                  <button className="btn small ghost">Paste</button>
                </div>
                <div style={{ height: 16 }} />
                <button className="btn">Review</button>
              </>
            ) : (
              <>
                <div className="card flat small">
                  <div className="kv"><span>Send</span><strong className="num">0.0249 SOL</strong></div>
                  <div className="kv"><span>Network fee</span><span className="num">0.000005 SOL</span></div>
                  <div className="kv" style={{ display: "block" }}>
                    <span>To Zodl's deposit address</span>
                    <p className="mono" style={{ margin: "6px 0 0" }}>{deposit}</p>
                  </div>
                  <div className="kv"><span>Afterwards</span><span>This wallet will be empty</span></div>
                </div>
                <p className="faint small">Check the address and amount match Zodl exactly. A transfer can't be undone.</p>
                <div className="stack">
                  <button className="btn">Confirm with passkey and send</button>
                  <button className="btn ghost">Back</button>
                </div>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
