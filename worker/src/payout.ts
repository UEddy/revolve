import { readFileSync } from "node:fs";
import bs58 from "bs58";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import type { OrderBook } from "./orders.ts";
import { repriced } from "./pricing.ts";

/** Pays SOL from the capped hot wallet. The key file lives outside the repo. */
export class Payer {
  readonly conn: Connection;
  private readonly key: Keypair;
  private balance: bigint | null = null;

  constructor(rpcUrl: string, keypairPath: string) {
    this.conn = new Connection(rpcUrl, "confirmed");
    const secret = Uint8Array.from(JSON.parse(readFileSync(keypairPath, "utf8")) as number[]);
    this.key = Keypair.fromSecretKey(secret);
  }

  /** The hot wallet's address: where Solana cash-ins (v1.5) are paid. */
  get address(): string {
    return this.key.publicKey.toBase58();
  }

  /** Last known balance; refreshed by `refreshBalance`, never per request. */
  cachedBalance(): bigint | null {
    return this.balance;
  }

  async refreshBalance(): Promise<bigint> {
    this.balance = BigInt(await this.conn.getBalance(this.key.publicKey));
    return this.balance;
  }

  /** Signs a transfer and returns it unsent, with its signature and expiry height. */
  async build(to: string, lamports: bigint) {
    const { blockhash, lastValidBlockHeight } = await this.conn.getLatestBlockhash();
    const tx = new Transaction({ feePayer: this.key.publicKey, blockhash, lastValidBlockHeight }).add(
      SystemProgram.transfer({ fromPubkey: this.key.publicKey, toPubkey: new PublicKey(to), lamports }),
    );
    tx.sign(this.key);
    return { raw: tx.serialize(), signature: bs58.encode(tx.signature!), blockhash, lastValidBlockHeight };
  }
}

/**
 * Pays every due order, one at a time. Each order is marked `paying` with its
 * signature before broadcast, so a crash or timeout is resolved by looking the
 * signature up, never by sending a second transfer.
 */
export type PayoutLimits = { reserve: bigint; dailyCap: bigint; quote?: (amountZat: bigint) => bigint | null; maxMoveBps?: number };

/**
 * What can still be promised to new orders: the hot wallet balance, but never
 * more than its cap, less the reserve; and never more than today's payout cap
 * allows; less everything already promised to open orders.
 */
export function freeInventory(
  balance: bigint,
  book: Pick<OrderBook, "committedLamports" | "paidToday">,
  cfg: { solReserveLamports: bigint; hotWalletCapLamports: bigint; dailyPayoutCapLamports: bigint },
): bigint {
  const wallet = (balance < cfg.hotWalletCapLamports ? balance : cfg.hotWalletCapLamports) - cfg.solReserveLamports;
  const today = cfg.dailyPayoutCapLamports - book.paidToday();
  // Committed covers open orders and payouts in flight alike.
  return (wallet < today ? wallet : today) - book.committedLamports();
}

/** The same rule for any chain, in its own units: min(balance, cap) - reserve, never above today's cap, less what open orders hold. */
export function freeOnChain(balance: bigint, committed: bigint, paidToday: bigint, cfg: { reserve: bigint; cap: bigint; dailyCap: bigint }): bigint {
  const wallet = (balance < cfg.cap ? balance : cfg.cap) - cfg.reserve;
  const today = cfg.dailyCap - paidToday;
  return (wallet < today ? wallet : today) - committed;
}

export async function runPayouts(book: OrderBook, payer: Payer, limits: PayoutLimits, onlyOrderId?: string): Promise<void> {
  const { reserve, dailyCap } = limits;
  await reconcile(book, payer);
  for (const quoted of book.due()) {
    if (onlyOrderId !== undefined && quoted.orderId !== onlyOrderId) continue;
    // Checked against the price now: a stale quote is re-priced, never paid at a loss.
    const due = repriced(book, "solana", quoted, limits);
    if (due === null) return;
    if (book.paidOrPayingToday() + due.lamports > dailyCap) {
      console.error("payout waiting: daily payout cap reached");
      return;
    }
    const balance = await payer.refreshBalance();
    if (balance < due.lamports + reserve) {
      console.error("payout waiting: hot wallet below payout plus reserve");
      return;
    }
    const tx = await payer.build(due.burner, due.lamports);
    // Another process (worker or admin CLI) may have claimed it; never send then.
    if (!book.markPaying(due.orderId, tx.signature, tx.lastValidBlockHeight)) continue;
    try {
      await payer.conn.sendRawTransaction(tx.raw, { maxRetries: 5 });
      const res = await payer.conn.confirmTransaction(
        { signature: tx.signature, blockhash: tx.blockhash, lastValidBlockHeight: tx.lastValidBlockHeight },
        "confirmed",
      );
      if (res.value.err) {
        // Landed but failed (no funds moved). Nothing was paid, so it can run again.
        book.retryPayout(due.orderId);
        console.error("payout transaction failed on chain; will retry");
      } else {
        book.markPaid(due.orderId, tx.signature);
      }
    } catch (e) {
      // Unknown outcome: leave it `paying` and let reconcile decide.
      console.error(`payout outcome unknown, reconciling later: ${(e as Error).message}`);
    }
  }
}

async function reconcile(book: OrderBook, payer: Payer): Promise<void> {
  const inFlight = book.inFlight();
  if (inFlight.length === 0) return;
  const { value } = await payer.conn.getSignatureStatuses(
    inFlight.map((p) => p.signature),
    { searchTransactionHistory: true },
  );
  const height = await payer.conn.getBlockHeight("confirmed");
  inFlight.forEach((p, i) => {
    const st = value[i];
    if (st && !st.err && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) {
      book.markPaid(p.orderId, p.signature);
    } else if (st?.err || (!st && height > p.validUntilBlockHeight)) {
      // Failed, or its blockhash expired without landing: safe to pay again.
      book.retryPayout(p.orderId);
    }
  });
}
