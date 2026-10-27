// First run (create the passkey vault) and unlock. Both use two zones: the
// wordmark alone near the top, and the title, text and buttons anchored to
// the lower part of the screen, with the space between absorbing the rest.

import { useRef, useState } from "react";
import { useVault } from "../state/vault.tsx";
import { Shield, Key, Eye, Lock } from "../components/icons.tsx";
import { Sheet, Spinner, Wordmark, errorText } from "../components/bits.tsx";
import { passkeysAvailable } from "../lib/passkey.ts";
import { InstallBanner } from "../components/InstallBanner.tsx";

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

/**
 * The top zone and the flexible gap below it. The install banner, when shown,
 * rides in the middle of the gap: it never covers a button and never moves
 * the title off its line.
 */
function WelcomeTop() {
  return (
    <>
      <div className="welcome-top">
        <Wordmark height={44} />
      </div>
      <div className="welcome-gap" aria-hidden />
      <InstallBanner inline />
      <div className="welcome-gap" aria-hidden />
    </>
  );
}

/** The first-run explainer, behind "How it works" so the welcome screen keeps the unlock layout. */
function HowItWorks({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Sheet open={open} onClose={onClose}>
      <h3 className="display" style={{ fontSize: 20 }}>How it works</h3>
      <ul className="points">
        <li><Key /><span><b>No account.</b> A passkey on this phone is the only way in. No email, no password, no seed phrase.</span></li>
        <li><Shield /><span><b>Your payment stays shielded.</b> ZEC never leaves the private pool on the way in.</span></li>
        <li><Eye /><span><b>Every buy gets a fresh wallet.</b> Its key is sealed on this phone, so positions cannot be tied to each other or to you.</span></li>
      </ul>
      <p className="faint" style={{ margin: "14px 0 18px" }}>Your keys never leave this phone. Revolve has no servers that know who you are.</p>
      <button className="btn ghost" onClick={onClose}>Close</button>
    </Sheet>
  );
}

export function Welcome() {
  const { create } = useVault();
  const { busy, error, run } = useAction();
  const supported = passkeysAvailable();
  const [how, setHow] = useState(false);
  return (
    <div className="welcome">
      <WelcomeTop />
      <div className="welcome-low">
        <h1 style={{ fontSize: 30 }}>Buy anything with shielded ZEC.</h1>
        <p className="muted" style={{ margin: 0 }}>
          Tokens and stocks, paid from Zodl, landing in wallets nobody can trace back to you.
        </p>
        <div className="stack" style={{ marginTop: 28 }}>
          {!supported && <p className="err">Open Revolve over https in Chrome on Android or Safari on iPhone to create a passkey.</p>}
          {error && <p className="err">{error}</p>}
          <button className="btn" disabled={!supported || busy} onClick={() => run(create)}>
            {busy ? <Spinner /> : <Lock />} Create passkey
          </button>
          <RestoreButton run={run} />
          <button className="textlink" onClick={() => setHow(true)} aria-haspopup="dialog">How it works</button>
        </div>
      </div>
      <HowItWorks open={how} onClose={() => setHow(false)} />
    </div>
  );
}

/**
 * Autofocus only with a mouse: on a phone a focused button on load just shows
 * a focus ring nobody asked for, and there is no keyboard to press Enter.
 */
const finePointer = () => matchMedia("(hover: hover) and (pointer: fine)").matches;

export function Unlock() {
  const { unlock } = useVault();
  const { busy, error, run } = useAction();
  return (
    <div className="welcome">
      <WelcomeTop />
      <div className="welcome-low" style={{ textAlign: "center", alignItems: "center" }}>
        <h1 style={{ fontSize: 30 }}>Welcome back</h1>
        <p className="muted" style={{ marginTop: 0 }}>Your wallets are sealed on this phone. Your passkey opens them.</p>
        <div className="stack" style={{ width: "100%", marginTop: 28 }}>
          {error && <p className="err">{error}</p>}
          <button className="btn" disabled={busy} onClick={() => run(unlock)} autoFocus={finePointer()}>
            {busy ? <Spinner /> : <Lock />} Unlock
          </button>
          <RestoreButton run={run} />
        </div>
      </div>
    </div>
  );
}
