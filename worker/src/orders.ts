import { createHash, randomBytes, randomInt } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { PublicKey } from "@solana/web3.js";

/** Fixed buckets from API_CONTRACT.md, in zatoshis. */
export const BUCKETS: Record<string, bigint> = {
  "0.005": 500_000n,
  "0.01": 1_000_000n,
  "0.05": 5_000_000n,
};

export const REQUIRED_CONFS = 3;
const PAID_CACHE_MS = 15 * 60 * 1000;

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
  payout_lamports: string;
  expires_at: number;
  status: RowStatus;
  burner: string | null;
  note_key: string | null;
  confirmations: number;
  pay_at_confs: number | null;
  payout_signature: string | null;
  payout_valid_until: number | null;
}

export interface DuePayout {
  orderId: string;
  burner: string;
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

/** Memo format: `rv1|<order_id>|<burner_solana_pubkey>`. */
export function parseMemo(memo: string | null): { orderId: string; burner: string } | null {
  if (memo === null) return null;
  const parts = memo.replace(/\0+$/, "").trim().split("|");
  if (parts.length !== 3 || parts[0] !== "rv1" || !isOrderId(parts[1])) return null;
  return { orderId: parts[1], burner: parts[2] };
}

/** A burner must be a plain ed25519 key (on curve), never a PDA. */
export function isValidBurner(s: string): boolean {
  try {
    return PublicKey.isOnCurve(new PublicKey(s).toBytes());
  } catch {
    return false;
  }
}

export function zatToZec(zat: bigint): string {
  const whole = zat / 100_000_000n;
  const frac = (zat % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

const noteKey = (n: NoteLine) => `${n.txid}:${n.pool}:${n.output_index}`;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");

export class OrderBook {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  /** order_id -> payout signature, memory only, for a short while after payout. */
  private readonly paid = new Map<string, { signature: string; until: number }>();

  constructor(db: DatabaseSync, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
  }

  openCount(): number {
    const r = this.db
      .prepare("SELECT COUNT(*) AS n FROM orders WHERE status IN ('awaiting_payment','seen','confirmed','paying')")
      .get() as { n: number };
    return r.n;
  }

  /** Lamports promised to orders that may still be paid out. */
  committedLamports(): bigint {
    const rows = this.db
      .prepare("SELECT payout_lamports FROM orders WHERE status IN ('awaiting_payment','seen','confirmed','paying')")
      .all() as { payout_lamports: string }[];
    return rows.reduce((sum, r) => sum + BigInt(r.payout_lamports), 0n);
  }

  create(bucketZec: string, payoutLamports: bigint, ttlSecs: number) {
    const bucketZat = BUCKETS[bucketZec];
    const orderId = newOrderId();
    const expiresAt = Math.floor(this.now() / 1000) + ttlSecs;
    this.db
      .prepare(
        "INSERT INTO orders (order_id, bucket_zat, payout_lamports, expires_at, status) VALUES (?, ?, ?, ?, 'awaiting_payment')",
      )
      .run(orderId, Number(bucketZat), payoutLamports.toString(), expiresAt);
    return {
      order_id: orderId,
      amount_zec: zatToZec(bucketZat),
      payout_lamports: payoutLamports.toString(),
      quote_expires_at: new Date(expiresAt * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    };
  }

  get(orderId: string): Record<string, unknown> | null {
    const cached = this.paid.get(orderId);
    if (cached) {
      if (cached.until > this.now()) return { status: "paid_out", payout_signature: cached.signature };
      this.paid.delete(orderId);
    }
    const row = this.row(orderId);
    if (!row) return null;
    return {
      status: row.status === "paying" ? "confirmed" : row.status,
      confirmations: row.confirmations,
      payout_signature: null,
    };
  }

  expire(): void {
    this.db
      .prepare("UPDATE orders SET status = 'expired' WHERE status = 'awaiting_payment' AND expires_at <= ?")
      .run(Math.floor(this.now() / 1000));
    for (const [id, p] of this.paid) if (p.until <= this.now()) this.paid.delete(id);
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

    const memo = parseMemo(n.memo);
    if (!memo) return this.reviewNote(key, n, "malformed_memo");
    const order = this.row(memo.orderId);
    if (!order) return this.reviewNote(key, n, "unknown_order");
    if (order.status !== "awaiting_payment" && order.status !== "expired") {
      return this.reviewNote(key, n, "duplicate_payment");
    }

    let reason: string | null = null;
    if (order.status === "expired") reason = "paid_after_expiry";
    else if (BigInt(n.value) !== BigInt(order.bucket_zat)) reason = "wrong_amount";
    else if (!isValidBurner(memo.burner)) reason = "invalid_burner";

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

  /** Orders past their confirmations plus random 2-6 block delay. */
  due(): DuePayout[] {
    const rows = this.db
      .prepare("SELECT * FROM orders WHERE status = 'confirmed' AND confirmations >= pay_at_confs")
      .all() as unknown as OrderRow[];
    return rows.map((r) => ({ orderId: r.order_id, burner: r.burner!, lamports: BigInt(r.payout_lamports) }));
  }

  inFlight(): InFlightPayout[] {
    const rows = this.db.prepare("SELECT * FROM orders WHERE status = 'paying'").all() as unknown as OrderRow[];
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

  /** The payout transaction expired unseen; it is safe to try again. */
  retryPayout(orderId: string): void {
    this.db
      .prepare(
        "UPDATE orders SET status = 'confirmed', payout_signature = NULL, payout_valid_until = NULL WHERE order_id = ? AND status = 'paying'",
      )
      .run(orderId);
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
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    this.paid.set(orderId, { signature, until: this.now() + PAID_CACHE_MS });
  }

  // Operator actions (src/admin.ts only; never reachable over HTTP).

  reviewNotes(): ReviewNote[] {
    return this.db.prepare("SELECT * FROM review_notes ORDER BY note_key").all() as unknown as ReviewNote[];
  }

  reviewOrders(): { order_id: string; bucket_zat: number; burner: string | null; note_key: string | null; review_reason: string | null }[] {
    return this.db
      .prepare("SELECT order_id, bucket_zat, burner, note_key, review_reason FROM orders WHERE status = 'needs_review'")
      .all() as never;
  }

  /** The quote and state of an order, for binding a review note to it. */
  quoteOf(orderId: string): { status: string; bucketZat: bigint; lamports: bigint; noteKey: string | null } | null {
    const r = this.row(orderId);
    return r
      ? { status: r.status, bucketZat: BigInt(r.bucket_zat), lamports: BigInt(r.payout_lamports), noteKey: r.note_key }
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
