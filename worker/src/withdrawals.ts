import { randomBytes, randomInt } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

// Credit withdrawals to shielded ZEC (CREDITS_CONTRACT.md v1.5). Credits are
// spent and the withdrawal queued in one transaction; it pays after a random
// delay, one at a time, from the separate ZEC hot wallet. Once sent the row,
// and with it the address, is deleted; only the txid stays in memory a while.

/** Random wait before a withdrawal pays, so it can't be paired with a cash-in or funding by timing. */
export const WITHDRAW_DELAY_SECS: [number, number] = [20 * 60, 120 * 60];
const SENT_CACHE_MS = 24 * 3600 * 1000;
/** After a failed send, the next try waits this long (the payer is idempotent per id, so retrying is safe). */
const RETRY_SECS = 5 * 60;

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const WITHDRAWAL_ID_RE = /^rw_[0-9a-hjkmnp-tv-z]{10}$/;

export function newWithdrawalId(): string {
  let id = "rw_";
  for (const b of randomBytes(10)) id += ALPHABET[b & 31];
  return id;
}

export const isWithdrawalId = (s: string) => WITHDRAWAL_ID_RE.test(s);

/** Shape check only (mainnet unified address); the payer's own decoder decides (payer-check-address). */
export const looksLikeUa = (s: string) => /^u1[02-9ac-hj-np-z]{100,600}$/.test(s);

type Row = { withdrawal_id: string; amount_zat: number; address: string; pay_after: number; status: "queued" | "sending"; spend_key: string };

export type WithdrawResult = { kind: "created" | "retried"; id: string; amountZat: bigint } | { kind: "token_spent" | "withdraw_unavailable" };

/** The stats key of a UTC day's withdrawn total, in zatoshis. */
const dayKey = (ms: number) => `withdrawn_zat_${new Date(ms).toISOString().slice(0, 10)}`;

export class WithdrawBook {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly sent = new Map<string, { txid: string; until: number }>();

  constructor(db: DatabaseSync, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
  }

  /** Zatoshis queued or being sent: promised to withdrawals already. */
  committed(): bigint {
    const r = this.db.prepare("SELECT COALESCE(SUM(amount_zat), 0) AS n FROM withdrawals").get() as { n: number };
    return BigInt(r.n);
  }

  withdrawnToday(): bigint {
    const r = this.db.prepare("SELECT n FROM stats WHERE key = ?").get(dayKey(this.now())) as { n: number } | undefined;
    return BigInt(r?.n ?? 0);
  }

  /**
   * Spends credit tokens on a withdrawal, in one transaction, like a spend:
   * an exact retry returns the same withdrawal; any spent token, or `fits`
   * false (checked inside, so queued withdrawals count), aborts with nothing spent.
   */
  create(p: { tokenHashes: string[]; spendKey: string; amountZat: bigint; address: string; fits: (zat: bigint) => boolean }): WithdrawResult {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.db.prepare("SELECT withdrawal_id, amount_zat FROM withdrawals WHERE spend_key = ?").get(p.spendKey) as
        | { withdrawal_id: string; amount_zat: number }
        | undefined;
      if (prior) {
        this.db.exec("COMMIT");
        return { kind: "retried", id: prior.withdrawal_id, amountZat: BigInt(prior.amount_zat) };
      }
      const isSpent = this.db.prepare("SELECT 1 FROM spent_tokens WHERE token_hash = ?");
      if (p.tokenHashes.some((h) => isSpent.get(h))) {
        this.db.exec("ROLLBACK");
        return { kind: "token_spent" };
      }
      if (!p.fits(p.amountZat)) {
        this.db.exec("ROLLBACK");
        return { kind: "withdraw_unavailable" };
      }
      const markSpent = this.db.prepare("INSERT INTO spent_tokens (token_hash) VALUES (?)");
      for (const h of p.tokenHashes) markSpent.run(h);
      const id = newWithdrawalId();
      const payAfter = Math.floor(this.now() / 1000) + randomInt(WITHDRAW_DELAY_SECS[0], WITHDRAW_DELAY_SECS[1] + 1);
      this.db
        .prepare("INSERT INTO withdrawals (withdrawal_id, amount_zat, address, pay_after, status, spend_key) VALUES (?, ?, ?, ?, 'queued', ?)")
        .run(id, Number(p.amountZat), p.address, payAfter, p.spendKey);
      this.db.exec("COMMIT");
      return { kind: "created", id, amountZat: p.amountZat };
    } catch (e) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw e;
    }
  }

  get(id: string): { status: "queued" | "sending" } | { status: "sent"; txid: string } | null {
    const s = this.sent.get(id);
    if (s && s.until > this.now()) return { status: "sent", txid: s.txid };
    const r = this.db.prepare("SELECT status FROM withdrawals WHERE withdrawal_id = ?").get(id) as { status: "queued" | "sending" } | undefined;
    return r ? { status: r.status } : null;
  }

  /**
   * The next withdrawal to pay. One already `sending` (a crash or a failed send)
   * blocks every other until it is settled: one at a time, always.
   */
  next(): { id: string; address: string; amountZat: bigint } | null {
    const now = Math.floor(this.now() / 1000);
    const sending = this.db.prepare("SELECT * FROM withdrawals WHERE status = 'sending' LIMIT 1").get() as Row | undefined;
    const r = sending
      ? sending.pay_after <= now
        ? sending
        : undefined
      : (this.db.prepare("SELECT * FROM withdrawals WHERE status = 'queued' AND pay_after <= ? ORDER BY pay_after LIMIT 1").get(now) as Row | undefined);
    return r ? { id: r.withdrawal_id, address: r.address, amountZat: BigInt(r.amount_zat) } : null;
  }

  markSending(id: string): void {
    this.db.prepare("UPDATE withdrawals SET status = 'sending' WHERE withdrawal_id = ?").run(id);
  }

  /** A failed send waits a while before the (idempotent) retry. */
  deferRetry(id: string): void {
    this.db.prepare("UPDATE withdrawals SET pay_after = ? WHERE withdrawal_id = ?").run(Math.floor(this.now() / 1000) + RETRY_SECS, id);
  }

  /** Forgets the address: only the day's total and the txid (in memory, for a day) remain. */
  markSent(id: string, txid: string): void {
    const r = this.db.prepare("SELECT amount_zat FROM withdrawals WHERE withdrawal_id = ?").get(id) as { amount_zat: number } | undefined;
    if (!r) return;
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM withdrawals WHERE withdrawal_id = ?").run(id);
      this.db.prepare("INSERT INTO stats VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET n = n + excluded.n").run(dayKey(this.now()), r.amount_zat);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    this.sent.set(id, { txid, until: this.now() + SENT_CACHE_MS });
  }
}

/** The ZEC hot wallet, as the worker drives it (the revolve-watcher payer-* commands); tests pass a fake. */
export interface ZecPayer {
  checkAddress(ua: string): boolean;
  /** Spendable zatoshis as of the last refresh, or null before the first one. */
  cachedSpendable(): bigint | null;
  refreshBalance(): Promise<bigint>;
  /** Idempotent per id: a retry re-broadcasts the transaction signed the first time. */
  send(id: string, ua: string, zat: bigint): Promise<string>;
}

/** Pays the next due withdrawal, if any, within the daily cap. One per call. */
export async function runWithdrawals(book: WithdrawBook, payer: ZecPayer, dailyCap: bigint): Promise<void> {
  const w = book.next();
  if (!w) return;
  if (book.withdrawnToday() + w.amountZat > dailyCap) {
    console.error("withdrawal waiting: daily withdrawal cap reached");
    return;
  }
  book.markSending(w.id);
  try {
    book.markSent(w.id, await payer.send(w.id, w.address, w.amountZat));
  } catch (e) {
    // Still `sending`: retried later with the same id, which re-broadcasts rather than pays again.
    book.deferRetry(w.id);
    console.error(`withdrawal send failed, will retry: ${(e as Error).message}`);
  }
}
