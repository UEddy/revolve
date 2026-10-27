// Sending out of a position: the riskiest thing a user can do here, so the
// coach speaks first, a high-risk send needs an explicit confirm, and every
// send needs a fresh passkey check.

import { useEffect, useState } from "react";
import { useVault } from "../state/vault.tsx";
import { sendWarnings } from "../lib/coach.ts";
import { isSolanaPubkey } from "../lib/memo.ts";
import { lamports } from "../lib/solana.ts";
import { sendAllCash, sendAllToken } from "../lib/transfer.ts";
import type { Position } from "../lib/model.ts";
import { Sheet, Spinner, Warnings, errorText } from "../components/bits.tsx";

export function SendSheet({ open, onClose, p }: { open: boolean; onClose: () => void; p: Position }) {
  const { data, updatePosition, confirm } = useVault();
  const [what, setWhat] = useState<"asset" | "cash">("asset");
  const [to, setTo] = useState("");
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) {
      setTo("");
      setOk(false);
      setError(null);
    }
  }, [open]);

  const valid = isSolanaPubkey(to.trim());
  const self = to.trim() === p.burner.pub;
  const warnings = valid && !self ? sendWarnings(p, to.trim(), data?.positions ?? []) : [];
  const high = warnings.some((w) => w.level === "high");

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const dest = to.trim();
      if (p.demo) throw new Error("Demo positions hold no real funds");
      await confirm();
      const sig = what === "asset" ? await sendAllToken(p.burner, p.token.mint, dest) : await sendAllCash(p.burner, dest, await lamports(p.burner.pub));
      await updatePosition(p.id, (x) => {
        x.sends.push({ to: dest, at: Date.now(), sig, what });
        if (what === "asset") x.stage = "closed";
      });
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose}>
      <h3 className="display" style={{ fontSize: 20 }}>Send out</h3>
      <div className="seg" role="group">
        <button aria-pressed={what === "asset"} onClick={() => setWhat("asset")}>All {p.token.symbol}</button>
        <button aria-pressed={what === "cash"} onClick={() => setWhat("cash")}>Leftover cash</button>
      </div>
      <input
        className="input"
        placeholder="Destination address"
        value={to}
        onChange={(e) => {
          setTo(e.target.value);
          setOk(false);
        }}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
      />
      {to && !valid && <p className="err">That is not a valid address.</p>}
      {self && <p className="err">That is this position's own wallet.</p>}
      <div style={{ height: 12 }} />
      <Warnings items={warnings} />
      {high && (
        <label className="row small" style={{ margin: "12px 0" }}>
          <input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} />
          <span>I understand this links my positions</span>
        </label>
      )}
      {error && <p className="err">{error}</p>}
      <div style={{ height: 12 }} />
      <button className="btn" disabled={!valid || self || busy || (high && !ok)} onClick={send}>
        {busy ? <Spinner /> : null} Send
      </button>
    </Sheet>
  );
}
