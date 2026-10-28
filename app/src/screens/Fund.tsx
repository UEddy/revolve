// Fund Revolve: add shielded ZEC once, get blind-signed credits, then buy
// with a passkey tap. One screen to start a funding, one to pay and follow it.

import { useState } from "react";
import { useCredits, KeyChanged } from "../state/credits.tsx";
import { useEngine } from "../state/engine.tsx";
import { AmountEntry, useAmount, useLimits, zecLabel } from "../components/AmountEntry.tsx";
import { PayCard } from "../components/PayCard.tsx";
import { CANCELLED_TEXT, CancelPayment, Sheet, Spinner, TopBar, errorText } from "../components/bits.tsx";
import { Check } from "../components/icons.tsx";
import { formatZec } from "../lib/amount.ts";
import { buildFundMemo, creditsToZats, FUND_MAX_ZATS, FUND_MIN_ZATS } from "../lib/credits.ts";
import { MOCK, ZEC_MINT } from "../lib/config.ts";
import { usd } from "../lib/format.ts";
import { go, href } from "../router.ts";
import type { Funding } from "../lib/model.ts";
import type { MintKey } from "../lib/mint.ts";

/** "0.020 ZEC · $24.49": a credit balance in both currencies. */
export function BalanceText({ credits }: { credits: number }) {
  const { prices } = useEngine();
  const zats = creditsToZats(credits);
  const px = prices[ZEC_MINT];
  return (
    <span className="num">
      {formatZec(zats)} ZEC{px !== undefined ? ` · ${usd((Number(zats) / 1e8) * px)}` : ""}
    </span>
  );
}

export function FundScreen() {
  const { balance, startFunding } = useCredits();
  const [state] = useLimits(true);
  // Funding has its own bounds (custody cap); only the USD rate comes from /limits.
  const limits = state.phase === "ready" ? { ...state.limits, min: FUND_MIN_ZATS, max: FUND_MAX_ZATS } : null;
  const a = useAmount(limits);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [keyChange, setKeyChange] = useState<KeyChanged | null>(null);

  const start = async (acceptKey?: MintKey) => {
    if (a.zats === null) return;
    setBusy(true);
    setError(null);
    try {
      const id = await startFunding(formatZec(a.zats), acceptKey);
      go(href.funding(id));
    } catch (e) {
      if (e instanceof KeyChanged) setKeyChange(e);
      else setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="screen">
      <TopBar title="Add funds" />
      <div className="card flat">
        <p style={{ margin: 0 }}>
          Add shielded ZEC once, then buy with a tap of your passkey. Revolve can't tell which funding paid for which buy:
          your balance is kept as blind-signed credits, sealed on this phone.
        </p>
        <p className="faint" style={{ marginBottom: 0 }}>
          Revolve holds the funds until you spend them, up to {zecLabel(FUND_MAX_ZATS)} per funding. Credits are in your vault backup;
          without a backup, losing this phone loses them.
        </p>
      </div>
      <div className="kv" style={{ margin: "14px 4px" }}>
        <span>Balance</span>
        <BalanceText credits={balance} />
      </div>
      <AmountEntry a={a} state={state} limits={limits} purpose="fund" />
      {error && <p className="err">{error}</p>}
      <div className="spacer" />
      <button className="btn" onClick={() => start()} disabled={busy || a.zats === null}>
        {busy ? <Spinner /> : null}{" "}
        {state.phase === "loading" ? "Loading rates…" : a.zats === null ? "Enter an amount" : `${MOCK ? "Continue (demo)" : "Continue"} with ${zecLabel(a.zats)}`}
      </button>

      <Sheet open={!!keyChange} onClose={() => setKeyChange(null)}>
        <h3 className="display" style={{ fontSize: 20 }}>Revolve's credit key changed</h3>
        <div className="warn high" style={{ margin: "12px 0" }}>
          <span className="dot" />
          <div>
            <b>Only continue if you expected this</b>
            <p>Credits are signed with this key. A key you didn't expect could mean you are not talking to the real Revolve.</p>
          </div>
        </div>
        <div className="card sunk small">
          <div className="kv"><span>Before</span><span className="mono">{keyChange?.pinnedFingerprint}</span></div>
          <div className="kv"><span>Now</span><span className="mono">{keyChange?.offeredFingerprint}</span></div>
        </div>
        <div className="spacer" />
        <div className="stack">
          <button className="btn ghost" onClick={() => setKeyChange(null)}>Cancel</button>
          <button
            className="btn danger"
            onClick={() => {
              const k = keyChange?.offered;
              setKeyChange(null);
              if (k) void start(k);
            }}
          >
            Trust the new key and continue
          </button>
        </div>
      </Sheet>
    </div>
  );
}

function fundingStep(f: Funding): number {
  return { awaiting_payment: 0, seen: 1, funded: 2, minted: 4, expired: 0, needs_review: 2, gone: 0 }[f.status];
}

export function FundingScreen({ id }: { id: string }) {
  const { credits, balance, cancelFunding } = useCredits();
  const [cancelled, setCancelled] = useState(false);
  const f = credits?.fundings.find((x) => x.fundId === id);
  if (!f && cancelled) {
    return (
      <div className="screen">
        <TopBar title="Add funds" />
        <div className="card flat">
          <h3>Payment cancelled</h3>
          <p className="muted">{CANCELLED_TEXT}</p>
          <a className="btn ghost" href={href.fund}>Start again</a>
        </div>
      </div>
    );
  }
  if (!f) return <div className="screen"><TopBar title="Add funds" /><p className="empty">This funding is not in your vault.</p></div>;
  const steps = ["Pay from your Zcash wallet", "Payment seen", "Confirming (3 blocks)", "Issuing credits"];
  const at = fundingStep(f);
  return (
    <div className="screen">
      <TopBar title="Add funds" right={f.demo ? <span className="badge caution">Demo</span> : undefined} />
      {f.cashin && f.status === "awaiting_payment" && (
        <div className="card flat">
          <h3>Cashing out to credits</h3>
          <p className="muted">
            {f.cashin.tx ? "Sent from your position. Revolve is checking the transfer on chain; your credits follow." : "Sending from your position…"}
          </p>
        </div>
      )}
      {!f.cashin && f.status === "awaiting_payment" && (
        <PayCard
          depositUa={f.depositUa}
          amountZec={f.amountZec}
          memo={() => buildFundMemo(f.fundId)}
          expiresAt={f.expiresAt}
          memoNote="The message only names this funding; it carries nothing about you and is encrypted on chain."
        />
      )}
      {!f.cashin && f.status === "awaiting_payment" && (
        <>
          <div className="spacer" />
          <CancelPayment what="funding" run={() => cancelFunding(f.fundId).then(() => setCancelled(true))} />
        </>
      )}
      {f.status === "minted" && (
        <div className="card">
          <div className="eyebrow">Added</div>
          <div className="display" style={{ fontSize: 30, margin: "6px 0 2px" }}>{f.credits} credits</div>
          <div className="muted">{f.amountZec} ZEC, ready to spend. Balance: <BalanceText credits={balance} /></div>
          <div className="spacer" />
          <a className="btn" href={href.discover}>Find something to buy</a>
        </div>
      )}
      {f.status === "expired" && (
        <div className="card flat">
          <h3>Quote expired</h3>
          <p className="muted">No payment arrived in time. Nothing was charged. If you did pay, it will be refunded by hand.</p>
          <a className="btn ghost" href={href.fund}>Start again</a>
        </div>
      )}
      {f.status === "needs_review" && (
        <div className="card flat">
          <h3>This funding needs a look</h3>
          <p className="muted">{f.error ?? "The payment didn't match this funding."} It will be sorted out by hand. Keep this id: <span className="mono">{f.fundId}</span></p>
        </div>
      )}
      {f.status !== "minted" && f.status !== "expired" && (
        <>
          <div className="spacer" />
          <div className="card flat">
            <ol className="steps">
              {steps.map((label, i) => (
                <li key={label} className={i < at ? "done" : i === at ? "now" : "todo"}>
                  <span className="node">{i < at && <Check />}</span>
                  <div>
                    <div className="label">{label}</div>
                    {i === at && f.status === "funded" && f.error && <div className="faint">{f.error}. Retrying…</div>}
                    {i === at && f.status === "funded" && !f.error && <div className="faint">Signing your credits blind: Revolve never sees them.</div>}
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </>
      )}
      <h2>Details</h2>
      <div className="card flat small">
        <div className="kv"><span>Funding</span><span className="mono">{f.fundId}</span></div>
        <div className="kv"><span>Amount</span><span>{f.amountZec} ZEC ({f.credits} credits)</span></div>
        <div className="kv"><span>Started</span><span>{new Date(f.createdAt).toLocaleString()}</span></div>
      </div>
    </div>
  );
}
