// Backup, lock, what each party can know, and wiping the vault.

import { useState } from "react";
import { useVault } from "../state/vault.tsx";
import { MOCK } from "../lib/config.ts";
import { errorText } from "../components/bits.tsx";
import { href } from "../router.ts";

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export function Settings() {
  const { lock, exportBackup, destroy, data, confirm: confirmUser } = useVault();
  const [confirm, setConfirm] = useState("");
  const [eraseError, setEraseError] = useState<string | null>(null);
  const count = data?.positions.length ?? 0;
  return (
    <div className="screen">
      <h1 style={{ marginTop: 6 }}>Settings</h1>

      <h2>History</h2>
      <div className="card flat row">
        <p className="muted grow" style={{ margin: 0 }}>Every transaction with its hash, kept only on this phone. Clear it whenever you like.</p>
        <a className="btn small ghost" href={href.history}>Open</a>
      </div>

      <h2>Backup</h2>
      <div className="card flat stack">
        <p className="muted" style={{ margin: 0 }}>
          Your wallets and credits live only on this phone. A backup file is the same sealed vault: useless without your passkey, so it is
          safe to keep in your files or cloud. If you lose this phone, restore it on a new one signed in to the same passkey
          account.
        </p>
        <button className="btn" onClick={() => {
          const b = exportBackup();
          if (b) download(`revolve-backup-${new Date().toISOString().slice(0, 10)}.json`, b);
        }}>
          Save encrypted backup
        </button>
        <button className="btn ghost" onClick={lock}>Lock now</button>
      </div>

      <h2>Who knows what</h2>
      <div className="card flat small">
        <div className="kv"><span>Zcash chain</span><span style={{ textAlign: "right" }}>A shielded payment. Not who, not how much, not why.</span></div>
        <div className="kv"><span>Revolve's payout service</span><span style={{ textAlign: "right" }}>An order id and which new wallet to pay, until the payout. Then it forgets. Never what you buy.</span></div>
        <div className="kv"><span>Public ledger</span><span style={{ textAlign: "right" }}>A Revolve payout to a fresh wallet, then a trade. Not linked to you or your other wallets.</span></div>
        <div className="kv"><span>Revolve credits</span><span style={{ textAlign: "right" }}>That you added funds, and later that some credits were spent. Blind signatures stop it from telling which funding paid for which buy. Timing and amounts can still pair them; the coach warns you.</span></div>
        <div className="kv"><span>Revolve relay</span><span style={{ textAlign: "right" }}>Carries price and balance requests so data providers never see your IP. Keeps no logs.</span></div>
        <div className="kv"><span>This phone</span><span style={{ textAlign: "right" }}>Everything, sealed under your passkey.</span></div>
      </div>
      <p className="faint">
        Between your payment and the payout (minutes) the service holds the funds. Patterns you create yourself, like sending
        from several wallets to one address, can still link positions; the coach warns you when that is about to happen.
      </p>

      {MOCK && (
        <>
          <h2>Demo mode</h2>
          <p className="muted">This build talks to a pretend payout service. Orders pay themselves after a minute and no money moves. Prices and quotes are real.</p>
        </>
      )}

      <h2>Erase</h2>
      <div className="card flat stack">
        <p className="muted" style={{ margin: 0 }}>
          Removes the vault from this phone. Without a backup, the {count} wallet{count === 1 ? "" : "s"} in it and anything they
          hold are gone for good.
        </p>
        <input className="input" placeholder='Type "erase" to confirm' value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        {eraseError && <p className="err">{eraseError}</p>}
        <button
          className="btn danger"
          disabled={confirm.trim().toLowerCase() !== "erase"}
          onClick={() => {
            setEraseError(null);
            // Erasing loses every wallet without a backup: the passkey has to agree, not just the screen.
            confirmUser().then(destroy, (e: unknown) => setEraseError(errorText(e)));
          }}
        >
          Erase vault
        </button>
      </div>
    </div>
  );
}
