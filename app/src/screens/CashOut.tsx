// "Cash out to Zcash": sell to SOL in this wallet if needed, then hand off to
// Zodl's own Swap (source: SOL on Solana). The user copies Zodl's deposit
// address and exact amount here; Revolve sends from this position's wallet
// after a fresh passkey check. Revolve never contacts the swap provider.

import { useEffect, useRef, useState } from "react";
import { useVault } from "../state/vault.tsx";
import { useEngine } from "../state/engine.tsx";
import { cashOutWarnings } from "../lib/coach.ts";
import { checkCashOut, formatSol, maxSendable, NETWORK_FEE_LAMPORTS, ZODL_MIN_LAMPORTS } from "../lib/cashout.ts";
import { SOL_MINT } from "../lib/config.ts";
import { lamports } from "../lib/solana.ts";
import { sendCash, UnconfirmedTransfer } from "../lib/transfer.ts";
import type { Position } from "../lib/model.ts";
import { Sheet, Spinner, Warnings, errorText } from "../components/bits.tsx";

type Step = "sell" | "form" | "review" | "done";

async function paste(set: (v: string) => void) {
  try {
    set((await navigator.clipboard.readText()).trim());
  } catch {
    // No clipboard permission: the field still takes a long-press paste.
  }
}

export function CashOutSheet({ open, onClose, p }: { open: boolean; onClose: () => void; p: Position }) {
  const { data, updatePosition, confirm } = useVault();
  const { sell, prices, busy: engineBusy } = useEngine();
  const [step, setStep] = useState<Step>("form");
  const [balance, setBalance] = useState<bigint | null>(null);
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sig, setSig] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, setPending] = useState(false);
  const draft = useRef({ to, amount });
  draft.current = { to, amount };

  const loadBalance = async () => {
    const b = p.demo ? BigInt(p.balance?.lamports ?? p.order.payoutLamports) : await lamports(p.burner.pub);
    setBalance(b);
    return b;
  };

  // Opening: restore a draft, or prefill the whole balance minus the fee.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setSig(null);
    setOk(false);
    setCopied(false);
    setPending(false);
    setTo(p.cashoutDraft?.to ?? "");
    if (p.stage === "held") {
      setStep("sell");
      return;
    }
    setStep("form");
    loadBalance().then(
      (b) => setAmount(p.cashoutDraft?.amount || formatSol(maxSendable(b))),
      (e) => setError(errorText(e)),
    );
    // Once per opening.
  }, [open]);

  // Switching to Zodl hides the app (and may lock it): keep what was typed.
  useEffect(() => {
    if (!open || step !== "form") return;
    const save = () => {
      if (document.visibilityState !== "hidden") return;
      const d = draft.current;
      if (d.to || d.amount) void updatePosition(p.id, (x) => void (x.cashoutDraft = { to: d.to, amount: d.amount }));
    };
    document.addEventListener("visibilitychange", save);
    return () => document.removeEventListener("visibilitychange", save);
  }, [open, step, p.id, updatePosition]);

  const sellFirst = async () => {
    setBusy(true);
    setError(null);
    try {
      await sell(p.id);
      const b = await loadBalance();
      setAmount(formatSol(maxSendable(b)));
      setStep("form");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const check = balance === null ? null : checkCashOut(to, amount, balance, p.burner.pub);
  const warnings = check?.ok ? cashOutWarnings(p, to.trim(), check.amount, maxSendable(balance!), data?.positions ?? [], Date.now(), prices[SOL_MINT]) : [];
  const high = warnings.some((w) => w.level === "high");
  const show = (field: "to" | "amount") => (check && !check.ok && check.field === field && (field === "to" ? to : amount) ? check.error : null);

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      if (p.demo) throw new Error("Demo positions hold no real funds");
      await confirm();
      // The balance may have moved since the form: check again right before signing.
      const fresh = checkCashOut(to, amount, await loadBalance(), p.burner.pub);
      if (!fresh.ok) throw new Error(fresh.error);
      const dest = to.trim();
      // Not confirmed in time still means sent: record it, so a retry can't send twice.
      const s = await sendCash(p.burner, dest, fresh.amount).catch((e: unknown) => {
        if (!(e instanceof UnconfirmedTransfer)) throw e;
        setPending(true);
        return e.sig;
      });
      await updatePosition(p.id, (x) => {
        x.sends.push({ to: dest, at: Date.now(), sig: s, what: "cash", cashout: true });
        delete x.cashoutDraft;
        if (x.balance) x.balance = { ...x.balance, lamports: fresh.leftover.toString(), at: Date.now() };
      });
      setSig(s);
      setStep("done");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose}>
      <h3 className="display" style={{ fontSize: 20 }}>Cash out to Zcash</h3>

      {step === "sell" && (
        <>
          <p className="muted">First, all your {p.token.symbol} is sold to SOL inside this same wallet. Then you send that SOL to Zodl's Swap, which pays you shielded ZEC.</p>
          {error && <p className="err">{error}</p>}
          <button className="btn" disabled={busy || !!engineBusy[p.id]} onClick={sellFirst}>
            {busy ? <Spinner /> : null} Sell {p.token.symbol} to SOL
          </button>
        </>
      )}

      {step === "form" && (
        <>
          <ol className="howto">
            <li>Open <b>Zodl</b> and tap <b>Swap</b>.</li>
            <li>Choose <b>SOL on Solana</b> as what you pay with, and ZEC to receive.</li>
            <li>Enter the amount below{balance !== null ? <> (up to <span className="num">{formatSol(maxSendable(balance))}</span> SOL)</> : null}, and continue.</li>
            <li>Copy the <b>deposit address</b> and the <b>exact amount</b> Zodl shows, and paste them here.</li>
          </ol>
          <p className="faint small">Use a new swap in Zodl every time: each one has its own deposit address.</p>

          <label className="field-label" htmlFor="co-to">Zodl's deposit address (Solana)</label>
          <div className="row">
            <input id="co-to" className="input grow" value={to} onChange={(e) => { setTo(e.target.value); setOk(false); }} autoCapitalize="off" autoCorrect="off" spellCheck={false} placeholder="Paste the address" />
            <button className="btn small ghost" onClick={() => paste(setTo)}>Paste</button>
          </div>
          {show("to") && <p className="err">{show("to")}</p>}

          <label className="field-label" htmlFor="co-amt">Exact amount (SOL)</label>
          <div className="row">
            <input id="co-amt" className="input grow num" value={amount} onChange={(e) => { setAmount(e.target.value); setOk(false); }} inputMode="decimal" autoComplete="off" />
            <button className="btn small ghost" onClick={() => paste(setAmount)}>Paste</button>
          </div>
          {show("amount") ? (
            <p className="err">{show("amount")}</p>
          ) : (
            <p className="faint small">
              Prefilled with everything in this wallet minus the {formatSol(NETWORK_FEE_LAMPORTS)} SOL network fee. Change it to match Zodl exactly.
              Zodl's minimum is about {formatSol(ZODL_MIN_LAMPORTS)} SOL.
            </p>
          )}

          <div style={{ height: 8 }} />
          <Warnings items={warnings} />
          {high && (
            <label className="row small" style={{ margin: "12px 0" }}>
              <input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} />
              <span>I understand the risk and want to send anyway</span>
            </label>
          )}
          {error && <p className="err">{error}</p>}
          <div style={{ height: 12 }} />
          <button className="btn" disabled={!check?.ok || (high && !ok)} onClick={() => setStep("review")}>
            Review
          </button>
        </>
      )}

      {step === "review" && check?.ok && (
        <>
          <div className="card flat small">
            <div className="kv"><span>Send</span><strong className="num">{formatSol(check.amount)} SOL</strong></div>
            <div className="kv"><span>Network fee</span><span className="num">{formatSol(NETWORK_FEE_LAMPORTS)} SOL</span></div>
            <div className="kv" style={{ display: "block" }}>
              <span>To Zodl's deposit address</span>
              <p className="mono" style={{ margin: "6px 0 0" }}>{to.trim()}</p>
            </div>
            <div className="kv">
              <span>Afterwards</span>
              <span>{check.leftover === 0n ? "This wallet will be empty" : <><span className="num">{formatSol(check.leftover)}</span> SOL stays here</>}</span>
            </div>
          </div>
          <p className="faint small">Check the address and amount match Zodl exactly. A transfer can't be undone.</p>
          {error && <p className="err">{error}</p>}
          <div className="stack">
            <button className="btn" disabled={busy} onClick={send}>{busy ? <Spinner /> : null} Confirm with passkey and send</button>
            <button className="btn ghost" disabled={busy} onClick={() => setStep("form")}>Back</button>
          </div>
        </>
      )}

      {step === "done" && sig && (
        <>
          <p className="muted">
            {pending ? "Sent, but not confirmed yet: it usually lands within a minute. Don't send again. " : "Sent. "}
            Back in Zodl, the swap shows its progress; the ZEC arrives shielded in a few minutes.
          </p>
          <div className="card flat small">
            <div className="kv" style={{ display: "block" }}>
              <span>Signature</span>
              <p className="mono" style={{ margin: "6px 0 0" }}>{sig}</p>
            </div>
          </div>
          <div className="stack" style={{ marginTop: 12 }}>
            <button className="btn ghost" onClick={() => navigator.clipboard.writeText(sig).then(() => setCopied(true), () => setCopied(false))}>
              {copied ? "Copied" : "Copy signature"}
            </button>
            <button className="btn" onClick={onClose}>Done</button>
          </div>
        </>
      )}
    </Sheet>
  );
}
