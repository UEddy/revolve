// History: every transaction this phone made or received, newest first, with
// its hash to copy. Opening a block explorer is possible but warned about: the
// explorer then sees that transaction together with this phone's IP. Clear
// deletes the hashes from the vault itself.

import { useEffect, useState } from "react";
import { useVault } from "../state/vault.tsx";
import { buildHistory, clearHistory, explorerUrl, type HistoryEntry } from "../lib/history.ts";
import { href } from "../router.ts";
import { Sheet, TopBar, errorText } from "../components/bits.tsx";

const CHAIN_LABEL = { solana: "Solana", base: "Base", zcash: "Zcash" } as const;

function Row({ e }: { e: HistoryEntry }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2_000);
    return () => clearTimeout(t);
  }, [copied]);
  const url = explorerUrl(e);
  return (
    <div className="hrow">
      <div className="row" style={{ alignItems: "baseline" }}>
        <b className="grow">{e.title}</b>
        <span className="faint small">{new Date(e.at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</span>
      </div>
      <div className="faint small">
        {CHAIN_LABEL[e.chain]} · {e.detail}
        {e.positionId && (
          <>
            {" · "}
            <a href={href.position(e.positionId)}>Position</a>
          </>
        )}
      </div>
      {e.hash && (
        <div className="row hash">
          <span className="mono grow">{e.hash.slice(0, 10)}…{e.hash.slice(-8)}</span>
          <button className="btn small ghost" onClick={() => navigator.clipboard.writeText(e.hash!).then(() => setCopied(true), () => {})}>
            {copied ? "Copied" : "Copy"}
          </button>
          {url && (
            <a className="btn small ghost" href={url} target="_blank" rel="noopener noreferrer">
              Explorer
            </a>
          )}
        </div>
      )}
    </div>
  );
}

export function HistoryScreen() {
  const { data, update } = useVault();
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const entries = buildHistory(data);
  return (
    <div className="screen">
      <TopBar title="History" />
      <p className="faint small" style={{ marginTop: 0 }}>
        Kept only on this phone, sealed in your vault. <b>Copy</b> a hash to check it anywhere; <b>Explorer</b> opens the chain's public
        explorer, which then sees that transaction together with this phone's IP.
      </p>
      {entries.length === 0 ? (
        <p className="empty">Nothing here yet{data?.historyClearedAt ? " since you last cleared it" : ""}.</p>
      ) : (
        <div className="list">
          {entries.map((e) => (
            <Row key={e.key} e={e} />
          ))}
        </div>
      )}
      {error && <p className="err">{error}</p>}
      <div className="spacer" />
      <button className="btn ghost" disabled={entries.length === 0} onClick={() => setAsking(true)}>
        Clear history
      </button>
      <Sheet open={asking} onClose={() => setAsking(false)}>
        <h3 className="display" style={{ fontSize: 20 }}>Clear history?</h3>
        <p className="muted">
          Every transaction hash is deleted from this phone's vault, and finished withdrawals are removed. Your positions, balances and credits
          stay, and so does what the privacy coach needs to warn you (when and where you sent things). The transactions themselves stay on their
          public chains; only this phone's record of them goes.
        </p>
        <p className="faint small">A backup saved before now still holds the old history.</p>
        <div className="stack">
          <button className="btn ghost" onClick={() => setAsking(false)}>Keep it</button>
          <button
            className="btn danger"
            onClick={() => {
              setAsking(false);
              setError(null);
              update((d) => clearHistory(d, Date.now())).catch((e: unknown) => setError(errorText(e)));
            }}
          >
            Clear history
          </button>
        </div>
      </Sheet>
    </div>
  );
}
