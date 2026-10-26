// First run (create the passkey vault) and unlock.

import { useRef, useState } from "react";
import { useVault } from "../state/vault.tsx";
import { Mark, Shield, Key, Eye, Lock } from "../components/icons.tsx";
import { Spinner, errorText } from "../components/bits.tsx";
import { passkeysAvailable } from "../lib/passkey.ts";

function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run, setError };
}

function RestoreButton({ run }: { run: (fn: () => Promise<void>) => Promise<void> }) {
  const { restore } = useVault();
  const file = useRef<HTMLInputElement>(null);
  return (
    <>
      <button className="btn ghost" onClick={() => file.current?.click()}>
        Restore from backup
      </button>
      <input
        ref={file}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void run(async () => restore(await f.text()));
        }}
      />
    </>
  );
}

export function Welcome() {
  const { create } = useVault();
  const { busy, error, run } = useAction();
  const supported = passkeysAvailable();
  return (
    <div className="welcome">
      <Mark className="mark" />
      <h1>Buy anything with shielded ZEC.</h1>
      <p className="muted" style={{ fontSize: 17, margin: 0 }}>
        Tokens and stocks, paid from Zodl, landing in wallets nobody can trace back to you.
      </p>
      <ul className="points">
        <li><Key /><span><b>No account.</b> A passkey on this phone is the only way in. No email, no password, no seed phrase.</span></li>
        <li><Shield /><span><b>Your payment stays shielded.</b> ZEC never leaves the private pool on the way in.</span></li>
        <li><Eye /><span><b>Every buy gets a fresh wallet.</b> Its key is sealed on this phone, so positions cannot be tied to each other or to you.</span></li>
      </ul>
      <div style={{ flex: 1, minHeight: 24 }} />
      <div className="stack">
        {!supported && <p className="err">Open Revolve over https in Chrome on Android or Safari on iPhone to create a passkey.</p>}
        {error && <p className="err">{error}</p>}
        <button className="btn" disabled={!supported || busy} onClick={() => run(create)}>
          {busy ? <Spinner /> : <Lock />} Create passkey
        </button>
        <RestoreButton run={run} />
        <p className="faint center">Your keys never leave this phone. Revolve has no servers that know who you are.</p>
      </div>
    </div>
  );
}

export function Unlock() {
  const { unlock } = useVault();
  const { busy, error, run } = useAction();
  return (
    <div className="welcome" style={{ justifyContent: "center", textAlign: "center", alignItems: "center" }}>
      <Mark className="mark" />
      <h1 style={{ fontSize: 30 }}>Welcome back</h1>
      <p className="muted" style={{ marginTop: 0 }}>Your wallets are sealed on this phone. Your passkey opens them.</p>
      <div className="spacer" />
      <div className="stack" style={{ width: "100%" }}>
        {error && <p className="err">{error}</p>}
        <button className="btn" disabled={busy} onClick={() => run(unlock)} autoFocus>
          {busy ? <Spinner /> : <Lock />} Unlock
        </button>
        <RestoreButton run={run} />
      </div>
    </div>
  );
}
