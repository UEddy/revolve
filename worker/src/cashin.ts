import { Connection } from "@solana/web3.js";
import bs58 from "bs58";

/** The SPL Memo program (v2). */
export const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

// Cash-ins (CREDITS_CONTRACT.md v1.5): a position's SOL or ETH comes back to the
// hot wallet for blind-signed credits. The worker never trusts the app's word
// for a transfer: it looks the transaction up and checks it against the quote.

export type Verdict = "ok" | "pending" | "bad";

/** One chain's cash-in rail: where to pay, what a credit costs, and how a transfer is checked. */
export interface CashinRail {
  payTo: string;
  /** Lamports or wei per credit, spread included; null without a price. */
  perCredit(): bigint | null;
  /** The transaction id in its canonical form, or null if it can't be one on this chain. */
  normalizeTx(tx: string): string | null;
  /**
   * ok: succeeded and confirmed, raised payTo by at least `min`, mined within
   * [notBefore, notAfter] (unix seconds), and names `fundId` (a memo on Solana,
   * input data on Base). Transfers to the hot wallet are public: without the
   * name, anyone could report someone else's transfer against their own quote.
   */
  verify(tx: string, min: bigint, notBefore: number, notAfter: number, fundId: string): Promise<Verdict>;
}

export function solanaRail(conn: Connection, payTo: string, perCredit: () => bigint | null): CashinRail {
  return {
    payTo,
    perCredit,
    normalizeTx: (tx) => {
      try {
        return bs58.decode(tx).length === 64 ? tx : null;
      } catch {
        return null;
      }
    },
    async verify(sig, min, notBefore, notAfter, fundId) {
      const tx = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      if (!tx) return "pending";
      if (!tx.meta || tx.meta.err) return "bad";
      const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses ?? undefined });
      const all = keys.keySegments().flat();
      const i = all.findIndex((k) => k.toBase58() === payTo);
      if (i < 0) return "bad";
      const named = tx.transaction.message.compiledInstructions.some(
        (ix) => all[ix.programIdIndex]?.toBase58() === MEMO_PROGRAM && Buffer.from(ix.data).toString("utf8") === fundId,
      );
      if (!named) return "bad";
      // The hot wallet's own balance change: whatever instructions moved it, this is what arrived.
      const delta = BigInt(tx.meta.postBalances[i]!) - BigInt(tx.meta.preBalances[i]!);
      const t = tx.blockTime;
      return delta >= min && t != null && t >= notBefore && t <= notAfter ? "ok" : "bad";
    },
  };
}
