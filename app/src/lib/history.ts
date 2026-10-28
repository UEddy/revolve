// The history view: every transaction this phone made or received, newest
// first, with its hash. Built from what the vault already holds (no second
// copy), and cleared by deleting those hashes from the vault itself.

import { cashOf, txUrl } from "./chain.ts";
import type { Position, VaultData } from "./model.ts";

export type HistoryChain = "solana" | "base" | "zcash";

export type HistoryEntry = {
  key: string;
  at: number;
  title: string;
  detail: string;
  chain: HistoryChain;
  /** Absent when this phone never learns one (a shielded payment from Zodl, a funding). */
  hash?: string;
  positionId?: string;
};

/** Demo positions carry placeholder signatures, never real ones. */
const real = (sig: string | undefined): sig is string => !!sig && sig !== "demo" && !sig.startsWith("Mock");

export function explorerUrl(e: Pick<HistoryEntry, "chain" | "hash">): string | null {
  if (!e.hash) return null;
  if (e.chain === "zcash") return `https://mainnet.zcashexplorer.app/transactions/${e.hash}`;
  return txUrl({ chain: e.chain === "base" ? "base" : undefined }, e.hash);
}

function positionEntries(p: Position): HistoryEntry[] {
  const chain: HistoryChain = p.chain === "base" ? "base" : "solana";
  const coin = cashOf(p).symbol;
  const on = p.chain === "base" ? "Base" : "Solana";
  const out: HistoryEntry[] = [];
  const paid = p.paidWith === "credits" || p.order.status !== "awaiting_payment" || p.stage !== "awaiting_payment";
  if (paid && p.stage !== "expired" && p.stage !== "sending") {
    out.push({
      key: `${p.id}:order`,
      at: p.createdAt,
      title: p.paidWith === "credits" ? `Paid ${p.order.amountZec} ZEC in credits` : `Paid ${p.order.amountZec} ZEC from Zodl`,
      detail: `For ${p.token.symbol}. Shielded: there's no public trace to show.`,
      chain: "zcash",
      positionId: p.id,
    });
  }
  if (real(p.order.payoutSig)) {
    out.push({ key: `${p.id}:payout`, at: p.order.paidAt ?? p.swap?.at ?? p.createdAt, title: `${coin} payout received`, detail: `New ${on} wallet for ${p.token.symbol}`, chain, hash: p.order.payoutSig, positionId: p.id });
  }
  if (real(p.swap?.sig)) {
    out.push({ key: `${p.id}:buy`, at: p.swap!.at ?? p.createdAt, title: `Bought ${p.token.symbol}`, detail: `On ${on}, in its own wallet`, chain, hash: p.swap!.sig, positionId: p.id });
  }
  if (real(p.sale?.sig)) {
    out.push({ key: `${p.id}:sale`, at: p.sale!.at, title: `Sold ${p.token.symbol}`, detail: `To ${coin}, in the same wallet`, chain, hash: p.sale!.sig, positionId: p.id });
  }
  p.sends.forEach((s, i) => {
    if (!real(s.sig)) return;
    const title = s.cashin ? "Cashed out to credits" : s.cashout ? "Sent to Zodl's Swap" : s.what === "asset" ? `Sent ${p.token.symbol}` : `Sent ${coin}`;
    out.push({ key: `${p.id}:send:${i}`, at: s.at, title, detail: s.cashin ? "To Revolve's shared hot wallet, for blind-signed credits" : `To ${s.to.slice(0, 6)}…${s.to.slice(-6)}`, chain, hash: s.sig, positionId: p.id });
  });
  return out;
}

/** Everything newest first, leaving out what was cleared. */
export function buildHistory(d: VaultData | null | undefined): HistoryEntry[] {
  if (!d) return [];
  const since = d.historyClearedAt ?? 0;
  const out = d.positions.flatMap(positionEntries);
  for (const f of d.credits?.fundings ?? []) {
    if (f.status === "minted" && f.mintedAt && !f.cashin) {
      out.push({ key: `${f.fundId}:fund`, at: f.mintedAt, title: `Added ${f.amountZec} ZEC as credits`, detail: "Shielded payment from Zodl: there's no public trace to show.", chain: "zcash" });
    }
  }
  for (const w of d.credits?.withdrawals ?? []) {
    if (w.status === "sent" && w.txid) {
      out.push({ key: `${w.key}:withdraw`, at: w.createdAt, title: `Withdrew ${w.amountZec} ZEC`, detail: "Fully shielded, to your Zcash wallet", chain: "zcash", hash: w.txid });
    }
  }
  return out.filter((e) => e.at > since).sort((a, b) => b.at - a.at);
}

/**
 * Deletes the history from the vault: every finished transaction's hash, and
 * finished withdrawals. Kept: anything still in flight (a cash-in waiting to be
 * reported, a withdrawal not yet sent), balances, and the times and
 * destinations the privacy coach uses for its warnings.
 */
export function clearHistory(d: VaultData, now: number): void {
  for (const p of d.positions) {
    delete p.order.payoutSig;
    delete p.order.paidAt;
    if (p.swap) delete p.swap.sig;
    delete p.sale;
    for (const s of p.sends) s.sig = "";
  }
  for (const f of d.credits?.fundings ?? []) {
    if (f.cashin && f.status !== "awaiting_payment") delete f.cashin.tx;
  }
  if (d.credits?.withdrawals) d.credits.withdrawals = d.credits.withdrawals.filter((w) => w.status !== "sent" && w.status !== "failed");
  d.historyClearedAt = now;
}
