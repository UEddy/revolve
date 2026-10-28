import { createHash, randomBytes, randomInt } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { PublicKey } from "@solana/web3.js";
import { isChain, isValidRecipient, type Chain } from "./chains.ts";
import { FundBook, parseFundMemo } from "./funds.ts";

/** Deprecated fixed buckets, still served by GET /buckets (API_CONTRACT.md v1.2), in zatoshis. */
export const BUCKETS: Record<string, bigint> = {
  "0.002": 200_000n,
  "0.005": 500_000n,
  "0.01": 1_000_000n,
};

/** Order amount grid from API_CONTRACT.md v1.2, in zatoshis. */
export const MIN_ZAT = 200_000n;
export const STEP_ZAT = 100_000n;

export const REQUIRED_CONFS = 3;
/** Token orders are already backed, so they pay after a random delay instead of confirmations. */
const TOKEN_PAY_DELAY_SECS: [number, number] = [60, 300];
const PAID_CACHE_MS = 15 * 60 * 1000;
const GWEI = 1_000_000_000n;

/** One line from the watcher (solver/src/notes.rs). */
export interface NoteLine {
  txid: string;
  pool: string;
  output_index: number;
  value: number;
  memo: string | null;
  height: number;
  confirmations: number;
}

export type Status =
  | "awaiting_payment"
  | "seen"
  | "confirmed"
  | "paid_out"
  | "expired"
  | "needs_review";

/** Internal states; `paying` is reported as `confirmed`. */
type RowStatus = Exclude<Status, "paid_out"> | "paying";

interface OrderRow {
  order_id: string;
  bucket_zat: number;
  /** Lamports on Solana, wei on EVM chains. */
  payout_lamports: string;
  expires_at: number;
  status: RowStatus;
  burner: string | null;
  note_key: string | null;
  confirmations: number;
  pay_at_confs: number | null;
  payout_signature: string | null;
  payout_valid_until: number | null;
  pay_after: number | null;
  spend_key: string | null;
  chain: Chain | null;
  payout_raw: string | null;
  payout_nonce: number | null;
}

const chainOf = (r: Pick<OrderRow, "chain">): Chain => r.chain ?? "solana";
/** SQL for "this row's chain is ?", with NULL meaning Solana. */
const CHAIN_IS = "COALESCE(chain, 'solana') = ?";

export type SpendResult =
  | { kind: "created" | "retried"; orderId: string; payoutLamports: bigint }
  | { kind: "token_spent" | "amount_unavailable" | "busy" | "no_price" };

/** `cancelled` deleted the record; `not_found` covers unknown and already paid-out ids. */
export type CancelResult = "cancelled" | "not_found" | "payment_seen";

export interface DuePayout {
  orderId: string;
  burner: string;
  /** Lamports on Solana, wei on EVM chains. */
  lamports: bigint;
}

export interface ReviewNote {
  note_key: string;
  value_zat: number;
  reason: string;
  confirmations: number;
}

export interface InFlightPayout {
  orderId: string;
  signature: string;
  validUntilBlockHeight: number;
}

/** An EVM payout in flight: the signed transaction, its hash and its nonce, stored before broadcast. */
export interface InFlightEvmPayout {
  orderId: string;
  hash: string;
  raw: string;
  nonce: number;
}

// Lowercase Crockford base32: no i, l, o, u.
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const ORDER_ID_RE = /^rv_[0-9a-hjkmnp-tv-z]{10}$/;

export function newOrderId(): string {
  const bytes = randomBytes(10);
  let id = "rv_";
  for (const b of bytes) id += ALPHABET[b & 31];
  return id;
}

export function isOrderId(s: string): boolean {
  return ORDER_ID_RE.test(s);
}

/**
 * Memo formats: `rv1|<order_id>|<burner_solana_pubkey>` (v1.2, Solana) and
 * `rv1|<order_id>|<chain>|<recipient>` (v1.4). An unknown chain name comes back
 * as null, so the note goes to review as wrong_chain rather than malformed.
 */
export function parseMemo(memo: string | null): { orderId: string; chain: Chain | null; burner: string } | null {
  if (memo === null) return null;
  const parts = memo.replace(/\0+$/, "").trim().split("|");
  if (parts[0] !== "rv1" || !isOrderId(parts[1] ?? "")) return null;
  if (parts.length === 3) return { orderId: parts[1], chain: "solana", burner: parts[2] };
  if (parts.length === 4) return { orderId: parts[1], chain: isChain(parts[2]) ? parts[2] : null, burner: parts[3] };
  return null;
}

/** A burner must be a plain ed25519 key (on curve), never a PDA. */
export function isValidBurner(s: string): boolean {
  try {
    return PublicKey.isOnCurve(new PublicKey(s).toBytes());
  } catch {
    return false;
  }
}

/** Strict decimal ZEC string (at most 8 places, no sign or exponent) to zatoshis, else null. */
export function zecToZat(s: string): bigint | null {
  const m = /^(0|[1-9]\d{0,7})(?:\.(\d{1,8}))?$/.exec(s);
  if (!m) return null;
  return BigInt(m[1]) * 100_000_000n + BigInt((m[2] ?? "").padEnd(8, "0"));
}

/** True for an amount an order may be placed for: on the grid and at least the minimum. */
export const onGrid = (zat: bigint) => zat >= MIN_ZAT && zat % STEP_ZAT === 0n;

export function zatToZec(zat: bigint): string {
  const whole = zat / 100_000_000n;
  const frac = (zat % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** Deletes an unpaid row (no note seen) and records the id's hash; shared by orders and fundings. */
export function cancelRow(db: DatabaseSync, table: "orders" | "fund_orders", idCol: string, id: string): CancelResult {
  db.exec("BEGIN IMMEDIATE");
  try {
    const r = db
      .prepare(`DELETE FROM ${table} WHERE ${idCol} = ? AND note_key IS NULL AND status IN ('awaiting_payment','expired')`)
      .run(id);
    if (Number(r.changes) === 1) {
      db.prepare("INSERT OR IGNORE INTO cancelled_ids VALUES (?)").run(hash(id));
      db.exec("COMMIT");
      return "cancelled";
    }
    const exists = db.prepare(`SELECT 1 FROM ${table} WHERE ${idCol} = ?`).get(id);
    db.exec("COMMIT");
    return exists ? "payment_seen" : "not_found";
  } catch (e) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw e;
  }
}

export const wasCancelled = (db: DatabaseSync, id: string) =>
  db.prepare("SELECT 1 FROM cancelled_ids WHERE id_hash = ?").get(hash(id)) !== undefined;

const noteKey = (n: NoteLine) => `${n.txid}:${n.pool}:${n.output_index}`;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
/** The stats key of a UTC day's payout total per chain, e.g. paid_lamports_2026-10-27 or paid_wei_base_2026-10-27. */
export const dayKey = (ms: number, chain: Chain = "solana") =>
  `${chain === "solana" ? "paid_lamports" : `paid_wei_${chain}`}_${new Date(ms).toISOString().slice(0, 10)}`;

export class OrderBook {
  readonly funds: FundBook;
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  /** order_id -> payout signature (or EVM transaction hash), memory only, for a short while after payout. */
  private readonly paid = new Map<string, { signature: string; chain: Chain; until: number }>();

  constructor(db: DatabaseSync, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
    this.funds = new FundBook(db, now);
  }

  openCount(): number {
    const r = this.db
      .prepare("SELECT COUNT(*) AS n FROM orders WHERE status IN ('awaiting_payment','seen','confirmed','paying')")
      .get() as { n: number };
    return r.n;
  }

  /** Payout units (lamports, or wei on EVM chains) promised on one chain to orders that may still be paid out. */
  committedLamports(chain: Chain = "solana"): bigint {
    const rows = this.db
      .prepare(`SELECT payout_lamports FROM orders WHERE status IN ('awaiting_payment','seen','confirmed','paying') AND ${CHAIN_IS}`)
      .all(chain) as { payout_lamports: string }[];
    return rows.reduce((sum, r) => sum + BigInt(r.payout_lamports), 0n);
  }

  /** `amountZat` is the exact deposit the order matches; the bucket_zat column holds it. Solana rows keep chain NULL. */
  create(amountZat: bigint, payoutLamports: bigint, ttlSecs: number, chain: Chain = "solana") {
    const orderId = newOrderId();
    const expiresAt = Math.floor(this.now() / 1000) + ttlSecs;
    this.db
      .prepare(
        "INSERT INTO orders (order_id, bucket_zat, payout_lamports, expires_at, status, chain) VALUES (?, ?, ?, ?, 'awaiting_payment', ?)",
      )
      .run(orderId, Number(amountZat), payoutLamports.toString(), expiresAt, chain === "solana" ? null : chain);
    return {
      order_id: orderId,
      chain,
      amount_zec: zatToZec(amountZat),
      payout_lamports: payoutLamports.toString(),
      quote_expires_at: new Date(expiresAt * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    };
  }

  get(orderId: string): Record<string, unknown> | null {
    const cached = this.paid.get(orderId);
    if (cached) {
      if (cached.until > this.now()) {
        return cached.chain === "solana"
          ? { status: "paid_out", payout_signature: cached.signature }
          : { status: "paid_out", payout_signature: cached.signature, chain: cached.chain };
      }
      this.paid.delete(orderId);
    }
    const row = this.row(orderId);
    if (!row) return null;
    const out: Record<string, unknown> = {
      status: row.status === "paying" ? "confirmed" : row.status,
      confirmations: row.confirmations,
      payout_signature: null,
    };
    // v1.2 responses stay byte-for-byte the same for Solana orders.
    if (row.chain) out.chain = row.chain;
    return out;
  }

  expire(): void {
    this.db
      .prepare("UPDATE orders SET status = 'expired' WHERE status = 'awaiting_payment' AND expires_at <= ?")
      .run(Math.floor(this.now() / 1000));
    this.funds.expire();
    for (const [id, p] of this.paid) if (p.until <= this.now()) this.paid.delete(id);
  }

  /**
   * Cancels an unpaid order: allowed only while no note has been seen for it
   * (awaiting_payment, or expired unpaid). The row is deleted, which releases the
   * inventory it reserved, and only a hash of the id is kept so a payment that
   * still arrives goes to review. The check and delete are one statement, so a
   * note applied concurrently either lands first (payment_seen) or finds no order.
   */
  cancel(orderId: string): CancelResult {
    if (this.paid.has(orderId)) return "payment_seen";
    return cancelRow(this.db, "orders", "order_id", orderId);
  }

  /** Applies one watcher line. Lines are idempotent and repeat as confirmations grow. */
  onNote(n: NoteLine): void {
    const key = noteKey(n);
    if (this.db.prepare("SELECT 1 FROM settled_notes WHERE note_hash = ?").get(hash(key))) return;

    const existing = this.db.prepare("SELECT * FROM orders WHERE note_key = ?").get(key) as OrderRow | undefined;
    if (existing) {
      this.updateConfs(existing, n.confirmations);
      return;
    }
    if (this.funds.onKnownNote(key, n)) return;

    const fund = parseFundMemo(n.memo);
    if (fund) {
      const review = this.funds.onNote(key, n, fund.fundId);
      if (review) this.reviewNote(key, n, review);
      return;
    }

    const memo = parseMemo(n.memo);
    if (!memo) return this.reviewNote(key, n, "malformed_memo");
    const order = this.row(memo.orderId);
    if (!order) return this.reviewNote(key, n, wasCancelled(this.db, memo.orderId) ? "paid_after_cancel" : "unknown_order");
    if (order.status !== "awaiting_payment" && order.status !== "expired") {
      return this.reviewNote(key, n, "duplicate_payment");
    }

    let reason: string | null = null;
    if (order.status === "expired") reason = "paid_after_expiry";
    else if (BigInt(n.value) !== BigInt(order.bucket_zat)) reason = "wrong_amount";
    else if (memo.chain !== chainOf(order)) reason = "wrong_chain";
    else if (!isValidRecipient(memo.chain, memo.burner)) reason = "invalid_burner";

    this.db
      .prepare(
        "UPDATE orders SET status = ?, burner = ?, note_key = ?, confirmations = ?, pay_at_confs = ?, review_reason = ? WHERE order_id = ?",
      )
      .run(
        reason ? "needs_review" : "seen",
        memo.burner,
        key,
        n.confirmations,
        REQUIRED_CONFS + randomInt(2, 7),
        reason,
        order.order_id,
      );
    if (!reason) this.updateConfs(this.row(order.order_id)!, n.confirmations);
  }

  /** One chain's orders past their confirmations plus random 2-6 block delay, or token orders past their payout time. */
  due(chain: Chain = "solana"): DuePayout[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM orders WHERE status = 'confirmed' AND (confirmations >= pay_at_confs OR pay_after <= ?) AND ${CHAIN_IS}`,
      )
      .all(Math.floor(this.now() / 1000), chain) as unknown as OrderRow[];
    return rows.map((r) => ({ orderId: r.order_id, burner: r.burner!, lamports: BigInt(r.payout_lamports) }));
  }

  /**
   * Spends credit tokens for an order, in one transaction: an exact retry of an
   * earlier spend (same `spendKey`) returns that order; otherwise any spent token,
   * the open-order cap, a missing price or a short inventory (`fits` false, checked
   * inside the transaction so open orders are counted) aborts with nothing marked
   * spent. On success every token
   * hash is recorded and a confirmed order is created that pays `burner` after a
   * random 60-300 s delay. Signatures must already be verified.
   */
  spendTokens(p: {
    tokenHashes: string[];
    spendKey: string;
    amountZat: bigint;
    burner: string;
    chain?: Chain;
    maxOpen: number;
    quote: () => bigint | null;
    fits: (lamports: bigint) => boolean;
  }): SpendResult {
    const chain = p.chain ?? "solana";
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.db.prepare("SELECT order_id, payout_lamports FROM orders WHERE spend_key = ?").get(p.spendKey) as
        | { order_id: string; payout_lamports: string }
        | undefined;
      if (prior) {
        this.db.exec("COMMIT");
        return { kind: "retried", orderId: prior.order_id, payoutLamports: BigInt(prior.payout_lamports) };
      }
      const isSpent = this.db.prepare("SELECT 1 FROM spent_tokens WHERE token_hash = ?");
      if (p.tokenHashes.some((h) => isSpent.get(h))) {
        this.db.exec("ROLLBACK");
        return { kind: "token_spent" };
      }
      const fail = (kind: "busy" | "no_price" | "amount_unavailable"): SpendResult => {
        this.db.exec("ROLLBACK");
        return { kind };
      };
      if (this.openCount() >= p.maxOpen) return fail("busy");
      const payout = p.quote();
      if (payout === null) return fail("no_price");
      if (!p.fits(payout)) return fail("amount_unavailable");
      const markSpent = this.db.prepare("INSERT INTO spent_tokens (token_hash) VALUES (?)");
      for (const h of p.tokenHashes) markSpent.run(h);
      const orderId = newOrderId();
      const payAfter = Math.floor(this.now() / 1000) + randomInt(TOKEN_PAY_DELAY_SECS[0], TOKEN_PAY_DELAY_SECS[1] + 1);
      this.db
        .prepare(
          "INSERT INTO orders (order_id, bucket_zat, payout_lamports, expires_at, status, burner, pay_after, spend_key, chain) VALUES (?, ?, ?, 0, 'confirmed', ?, ?, ?, ?)",
        )
        .run(orderId, Number(p.amountZat), payout.toString(), p.burner, payAfter, p.spendKey, chain === "solana" ? null : chain);
      this.db.exec("COMMIT");
      return { kind: "created", orderId, payoutLamports: payout };
    } catch (e) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** Paid out so far today (UTC) on one chain, settled payouts only. */
  paidToday(chain: Chain = "solana"): bigint {
    const day = this.db.prepare("SELECT n FROM stats WHERE key = ?").get(dayKey(this.now(), chain)) as { n: number } | undefined;
    return BigInt(day?.n ?? 0) * (chain === "solana" ? 1n : GWEI);
  }

  /** Paid today plus everything in flight on that chain: what a new payout is checked against. */
  paidOrPayingToday(chain: Chain = "solana"): bigint {
    const paying = this.db.prepare(`SELECT payout_lamports FROM orders WHERE status = 'paying' AND ${CHAIN_IS}`).all(chain) as { payout_lamports: string }[];
    return this.paidToday(chain) + paying.reduce((s, r) => s + BigInt(r.payout_lamports), 0n);
  }

  inFlight(): InFlightPayout[] {
    const rows = this.db.prepare(`SELECT * FROM orders WHERE status = 'paying' AND ${CHAIN_IS}`).all("solana") as unknown as OrderRow[];
    return rows.map((r) => ({
      orderId: r.order_id,
      signature: r.payout_signature!,
      validUntilBlockHeight: r.payout_valid_until!,
    }));
  }

  /**
   * Claims a confirmed order for payout, persisted before broadcast so a crash can
   * never lead to paying twice. Returns false if another process claimed it first.
   */
  markPaying(orderId: string, signature: string, validUntilBlockHeight: number): boolean {
    const r = this.db
      .prepare(
        "UPDATE orders SET status = 'paying', payout_signature = ?, payout_valid_until = ? WHERE order_id = ? AND status = 'confirmed'",
      )
      .run(signature, validUntilBlockHeight, orderId);
    return Number(r.changes) === 1;
  }

  /** EVM payouts in flight on one chain (at most one, by the payout rules). */
  inFlightEvm(chain: Chain): InFlightEvmPayout[] {
    const rows = this.db.prepare(`SELECT * FROM orders WHERE status = 'paying' AND ${CHAIN_IS}`).all(chain) as unknown as OrderRow[];
    return rows.map((r) => ({ orderId: r.order_id, hash: r.payout_signature!, raw: r.payout_raw!, nonce: r.payout_nonce! }));
  }

  /**
   * Claims a confirmed EVM order for payout, storing the signed transaction,
   * its hash and nonce before broadcast. False if it was claimed first.
   */
  markPayingEvm(orderId: string, hash: string, raw: string, nonce: number): boolean {
    const r = this.db
      .prepare(
        "UPDATE orders SET status = 'paying', payout_signature = ?, payout_raw = ?, payout_nonce = ? WHERE order_id = ? AND status = 'confirmed'",
      )
      .run(hash, raw, nonce, orderId);
    return Number(r.changes) === 1;
  }

  /** The payout transaction expired unseen (or reverted without moving funds); it is safe to try again. */
  retryPayout(orderId: string): void {
    this.db
      .prepare(
        "UPDATE orders SET status = 'confirmed', payout_signature = NULL, payout_valid_until = NULL, payout_raw = NULL, payout_nonce = NULL WHERE order_id = ? AND status = 'paying'",
      )
      .run(orderId);
  }

  /** A payout whose outcome can't be settled automatically: held for the operator, never retried on its own. */
  holdForReview(orderId: string, reason: string): void {
    this.db.prepare("UPDATE orders SET status = 'needs_review', review_reason = ? WHERE order_id = ? AND status = 'paying'").run(reason, orderId);
  }

  /** Forgets the order -> burner link; only a note hash and counters remain. */
  markPaid(orderId: string, signature: string): void {
    const row = this.row(orderId);
    if (!row) return;
    this.db.exec("BEGIN");
    try {
      if (row.note_key) this.db.prepare("INSERT OR IGNORE INTO settled_notes VALUES (?)").run(hash(row.note_key));
      this.db.prepare("DELETE FROM orders WHERE order_id = ?").run(orderId);
      this.bump("paid_out");
      this.bump(`paid_out_zat_${row.bucket_zat}`);
      // One total per UTC day, nothing per order: enough to enforce the daily cap.
      // EVM totals are kept in gwei, rounded up: wei would pass 2^53 within a day.
      const evm = chainOf(row) !== "solana";
      const amount = evm ? (BigInt(row.payout_lamports) + GWEI - 1n) / GWEI : BigInt(row.payout_lamports);
      this.db
        .prepare("INSERT INTO stats VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET n = n + excluded.n")
        .run(dayKey(this.now(), chainOf(row)), Number(amount));
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    this.paid.set(orderId, { signature, chain: chainOf(row), until: this.now() + PAID_CACHE_MS });
  }

  // Operator actions (src/admin.ts only; never reachable over HTTP).

  reviewNotes(): ReviewNote[] {
    return this.db.prepare("SELECT * FROM review_notes ORDER BY note_key").all() as unknown as ReviewNote[];
  }

  reviewOrders(): { order_id: string; bucket_zat: number; burner: string | null; note_key: string | null; review_reason: string | null; chain: string }[] {
    return this.db
      .prepare("SELECT order_id, bucket_zat, burner, note_key, review_reason, COALESCE(chain, 'solana') AS chain FROM orders WHERE status = 'needs_review'")
      .all() as never;
  }

  /** The quote and state of an order, for binding a review note to it. */
  quoteOf(orderId: string): { status: string; bucketZat: bigint; lamports: bigint; noteKey: string | null; chain: Chain } | null {
    const r = this.row(orderId);
    return r
      ? { status: r.status, bucketZat: BigInt(r.bucket_zat), lamports: BigInt(r.payout_lamports), noteKey: r.note_key, chain: chainOf(r) }
      : null;
  }

  /**
   * Turns a review note into a confirmed order that is due now, paying `burner`.
   * With `orderId`, that unpaid order (and its quote) is reused; otherwise a new
   * internal order is made for `lamports`. Returns the order id to pay.
   */
  bindReviewNote(noteKey: string, burner: string, target: { orderId: string } | { lamports: bigint }): string {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const note = this.db.prepare("SELECT * FROM review_notes WHERE note_key = ?").get(noteKey) as ReviewNote | undefined;
      if (!note) throw new Error("no such review note");
      let orderId: string;
      if ("orderId" in target) {
        const o = this.row(target.orderId);
        if (!o || o.note_key !== null || (o.status !== "awaiting_payment" && o.status !== "expired")) {
          throw new Error("order must exist, be unpaid, and have no note");
        }
        orderId = o.order_id;
      } else {
        orderId = newOrderId();
        this.db
          .prepare("INSERT INTO orders (order_id, bucket_zat, payout_lamports, expires_at, status) VALUES (?, ?, ?, 0, 'expired')")
          .run(orderId, note.value_zat, target.lamports.toString());
      }
      this.db
        .prepare(
          "UPDATE orders SET status = 'confirmed', burner = ?, note_key = ?, confirmations = ?, pay_at_confs = 0, review_reason = NULL WHERE order_id = ?",
        )
        .run(burner, noteKey, note.confirmations, orderId);
      this.db.prepare("DELETE FROM review_notes WHERE note_key = ?").run(noteKey);
      this.db.exec("COMMIT");
      return orderId;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  private updateConfs(row: OrderRow, confs: number): void {
    let status = row.status;
    if (status === "seen" && confs >= REQUIRED_CONFS) status = "confirmed";
    this.db
      .prepare("UPDATE orders SET confirmations = ?, status = ? WHERE order_id = ?")
      .run(confs, status, row.order_id);
  }

  private reviewNote(key: string, n: NoteLine, reason: string): void {
    this.db
      .prepare(
        "INSERT INTO review_notes (note_key, value_zat, reason, confirmations) VALUES (?, ?, ?, ?) ON CONFLICT(note_key) DO UPDATE SET confirmations = excluded.confirmations",
      )
      .run(key, n.value, reason, n.confirmations);
  }

  private bump(key: string): void {
    this.db.prepare("INSERT INTO stats VALUES (?, 1) ON CONFLICT(key) DO UPDATE SET n = n + 1").run(key);
  }

  private row(orderId: string): OrderRow | undefined {
    return this.db.prepare("SELECT * FROM orders WHERE order_id = ?").get(orderId) as OrderRow | undefined;
  }
}
