import { readFileSync } from "node:fs";
import { createPublicClient, http, keccak256, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { base } from "viem/chains";
import type { Chain } from "./chains.ts";
import { secretPathProblem } from "./keypath.ts";
import type { OrderBook } from "./orders.ts";

// EVM payouts (API_CONTRACT.md v1.4, Base). One payout in flight per chain:
// the signed transaction, its hash and nonce are stored before broadcast, and
// an unknown outcome is settled by re-broadcasting that same transaction, which
// can never pay twice because its nonce can only be used once.

const TRANSFER_GAS = 21_000n;
/** How long one tick waits for a receipt before leaving the payout to the next tick's reconcile. */
const RECEIPT_WAIT_MS = 30_000;

/** What the payout loop needs from a chain; tests pass a simulated one. */
export interface EvmChain {
  readonly address: string;
  cachedBalance(): bigint | null;
  refreshBalance(): Promise<bigint>;
  /** The next nonce, from mined transactions only. */
  minedNonce(): Promise<number>;
  /** A signed EIP-1559 transfer with the given nonce, its hash, and the most its gas can cost. */
  signTransfer(to: string, wei: bigint, nonce: number): Promise<{ raw: Hex; hash: Hex; maxGasCost: bigint }>;
  /** Broadcasts; "already known" and "nonce too low" answers are not errors here (reconcile decides). */
  broadcast(raw: Hex): Promise<void>;
  /** "success" or "reverted" once mined, null while unknown. */
  receipt(hash: Hex): Promise<"success" | "reverted" | null>;
}

/** Reads the hex private key (0x + 64 hex) from a file outside the repo, like the mint key. */
export function loadEvmKey(path: string): PrivateKeyAccount {
  const problem = secretPathProblem(path);
  if (problem) throw new Error(`refusing the EVM hot wallet key: ${problem}`);
  const key = readFileSync(path, "utf8").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("EVM key file must hold 0x followed by 64 hex characters");
  return privateKeyToAccount(key as Hex);
}

export class BasePayer implements EvmChain {
  private readonly client: PublicClient;
  private readonly account: PrivateKeyAccount;
  private balance: bigint | null = null;

  constructor(rpcUrl: string, keyPath: string) {
    this.account = loadEvmKey(keyPath);
    this.client = createPublicClient({ chain: base, transport: http(rpcUrl, { timeout: 15_000, retryCount: 1 }) }) as PublicClient;
  }

  get address(): string {
    return this.account.address;
  }

  cachedBalance(): bigint | null {
    return this.balance;
  }

  async refreshBalance(): Promise<bigint> {
    this.balance = await this.client.getBalance({ address: this.account.address });
    return this.balance;
  }

  minedNonce(): Promise<number> {
    return this.client.getTransactionCount({ address: this.account.address, blockTag: "latest" });
  }

  async signTransfer(to: string, wei: bigint, nonce: number) {
    const fees = await this.client.estimateFeesPerGas();
    const raw = await this.account.signTransaction({
      type: "eip1559",
      chainId: base.id,
      to: to as Hex,
      value: wei,
      nonce,
      gas: TRANSFER_GAS,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    });
    return { raw, hash: keccak256(raw), maxGasCost: TRANSFER_GAS * fees.maxFeePerGas };
  }

  async broadcast(raw: Hex): Promise<void> {
    try {
      await this.client.request({ method: "eth_sendRawTransaction", params: [raw] });
    } catch (e) {
      if (/already known|known transaction|nonce too low|already imported/i.test(String((e as Error).message))) return;
      throw e;
    }
  }

  async receipt(hash: Hex): Promise<"success" | "reverted" | null> {
    try {
      return (await this.client.getTransactionReceipt({ hash })).status;
    } catch (e) {
      if ((e as Error).name === "TransactionReceiptNotFoundError") return null;
      throw e;
    }
  }
}

export type EvmLimits = { reserve: bigint; dailyCap: bigint; receiptWaitMs?: number };

/** Pays one chain's due orders, one at a time, never more than one in flight. */
export async function runEvmPayouts(book: OrderBook, chain: Chain, payer: EvmChain, limits: EvmLimits): Promise<void> {
  if (!(await reconcileEvm(book, chain, payer))) return;
  for (const due of book.due(chain)) {
    if (book.paidOrPayingToday(chain) + due.lamports > limits.dailyCap) {
      console.error(`${chain} payout waiting: daily payout cap reached`);
      return;
    }
    const balance = await payer.refreshBalance();
    const nonce = await payer.minedNonce();
    const tx = await payer.signTransfer(due.burner, due.lamports, nonce);
    if (balance < due.lamports + tx.maxGasCost + limits.reserve) {
      console.error(`${chain} payout waiting: hot wallet below payout plus gas plus reserve`);
      return;
    }
    // Another process may have claimed it; never send then.
    if (!book.markPayingEvm(due.orderId, tx.hash, tx.raw, nonce)) continue;
    try {
      await payer.broadcast(tx.raw);
    } catch (e) {
      console.error(`${chain} payout broadcast failed, reconciling later: ${(e as Error).message}`);
      return;
    }
    const outcome = await waitForReceipt(payer, tx.hash, limits.receiptWaitMs ?? RECEIPT_WAIT_MS);
    if (outcome === "success") book.markPaid(due.orderId, tx.hash);
    else if (outcome === "reverted") book.retryPayout(due.orderId);
    // Still pending: one in flight per chain, so stop here; the next tick reconciles.
    if (outcome !== "success") return;
  }
}

/**
 * Settles the payout in flight, if any. Returns true when nothing is in flight
 * any more (so a new payout may start).
 */
export async function reconcileEvm(book: OrderBook, chain: Chain, payer: EvmChain): Promise<boolean> {
  const [p] = book.inFlightEvm(chain);
  if (!p) return true;
  const settle = (r: "success" | "reverted") => {
    if (r === "success") book.markPaid(p.orderId, p.hash);
    else book.retryPayout(p.orderId); // status 0: nothing moved
    return true;
  };
  const first = await payer.receipt(p.hash as Hex);
  if (first) return settle(first);
  if ((await payer.minedNonce()) > p.nonce) {
    // The nonce is used. Ours may have just been mined: look once more.
    const again = await payer.receipt(p.hash as Hex);
    if (again) return settle(again);
    book.holdForReview(p.orderId, "nonce_reused");
    console.error(`${chain} payout held for review: a different transaction used its nonce`);
    return true;
  }
  await payer.broadcast(p.raw as Hex).catch((e: unknown) => console.error(`${chain} re-broadcast failed: ${(e as Error).message}`));
  return false;
}

async function waitForReceipt(payer: EvmChain, hash: Hex, ms: number): Promise<"success" | "reverted" | null> {
  const until = Date.now() + ms;
  for (;;) {
    const r = await payer.receipt(hash).catch(() => null);
    if (r || Date.now() >= until) return r;
    await new Promise((res) => setTimeout(res, Math.min(2_000, Math.max(0, until - Date.now()))));
  }
}
