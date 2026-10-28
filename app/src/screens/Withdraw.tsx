// Withdraw credits to shielded ZEC (CREDITS_CONTRACT.md v1.5): an amount, a
// shielded address from Zodl's Receive screen, the coach's timing and amount
// warnings, then a fresh passkey check. Revolve pays after a random 20 to 120
// minutes, from its withdrawal hot wallet, never linked to where the credits came from.

import { useEffect, useState } from "react";
import { useCredits, SpendRefused } from "../state/credits.tsx";
import { withdrawWarnings } from "../lib/coach.ts";
import { Sheet, Spinner, Warnings, errorText } from "../components/bits.tsx";

/** A mainnet unified address; the server's own decoder makes the final call (it must carry an Orchard receiver). */
const UA = /^u1[02-9ac-hj-np-z]{100,}$/;

export function WithdrawSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { balance, credits, withdrawTo } = useCredits();
  const [amount, setAmount] = useState("");
  const [address, setAddress] = useState("");
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setAmount("");
    setAddress("");
    setOk(false);
    setDone(false);
    setError(null);
  }, [open]);

  const n = /^\d+$/.test(amount.trim()) ? Number(amount.trim()) : null;
  const validAmount = n !== null && n >= 1 && n <= balance;
  const addr = address.trim();
  const validAddress = UA.test(addr);
  const warnings = validAmount ? withdrawWarnings(n!, credits, Date.now()) : [];
  const high = warnings.some((w) => w.level === "high");

  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      await withdrawTo(n!, addr);
      setDone(true);
    } catch (e) {
      setError(e instanceof SpendRefused ? e.message : errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose}>
      <h3 className="display" style={{ fontSize: 20 }}>Withdraw to Zcash</h3>
      {done ? (
        <>
          <p className="muted">
            Queued. Revolve sends it to your shielded address after a random 20 to 120 minutes, so it can't be paired with where your credits came
            from. You can follow it on the Portfolio tab.
          </p>
          <button className="btn" onClick={onClose}>Done</button>
        </>
      ) : (
        <>
          <p className="faint small" style={{ marginTop: 0 }}>
            Credits are blind-signed: Revolve can't tell which funding or cash-out they came from. The ZEC arrives fully shielded; Revolve pays the
            network fee.
          </p>
          <label className="field-label" htmlFor="wd-amt">Credits to withdraw (1 credit = 0.001 ZEC)</label>
          <div className="row">
            <input id="wd-amt" className="input grow num" value={amount} onChange={(e) => { setAmount(e.target.value); setOk(false); }} inputMode="numeric" autoComplete="off" placeholder={`Up to ${balance}`} />
            <button className="btn small ghost" onClick={() => setAmount(String(balance))} disabled={balance === 0}>All</button>
          </div>
          {amount && !validAmount && <p className="err">Enter a whole number of credits, from 1 to {balance}.</p>}
          {validAmount && <p className="faint small">{(n! / 1000).toFixed(3)} ZEC</p>}

          <label className="field-label" htmlFor="wd-to">Your shielded address</label>
          <input id="wd-to" className="input" value={address} onChange={(e) => setAddress(e.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} placeholder="u1… from Zodl's Receive screen" />
          {addr && !validAddress && <p className="err">Use a shielded unified address (starts with u1). Transparent t-addresses aren't accepted.</p>}

          <div style={{ height: 10 }} />
          <Warnings items={warnings} />
          {high && (
            <label className="row small" style={{ margin: "12px 0" }}>
              <input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} />
              <span>I understand and want to withdraw now</span>
            </label>
          )}
          {error && <p className="err">{error}</p>}
          <div className="sheet-actions">
            <button className="btn" disabled={busy || !validAmount || !validAddress || (high && !ok)} onClick={go}>
              {busy ? <Spinner /> : null} Confirm with passkey and withdraw
            </button>
          </div>
        </>
      )}
    </Sheet>
  );
}
