import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { CREDIT_ZAT } from "./mint.ts";
import { REQUIRED_CONFS, cancelRow, wasCancelled, type CancelResult, type NoteLine } from "./orders.ts";

// Credit fundings (CREDITS_CONTRACT.md v1.3). A funding is matched like an order,
// on memo fund_id and exact amount, and becomes `funded` at 3 confirmations. Its
// row never holds the blinded messages, only that it was `minted`.

/** Custody cap per funding, in zatoshis. */
export const FUND_MAX_ZAT = 5_000_000n;

export type FundStatus = "awaiting_payment" | "seen" | "funded" | "minted" | "expired" | "needs_review";

interface FundRow {
  fund_id: string;
  amount_zat: number;
  expires_at: number;
  status: FundStatus;
  note_key: string | null;
  confirmations: number;
  review_reason: string | null;
  blinded_hash: string | null;
  /** v1.5 cash-ins: the chain paid on; NULL for a ZEC funding. */
  source: string | null;
  pay_amount: string | null;
}

/** A cash-in's quote, as POST /cashins/:id/sent checks a transaction against it. */
export type CashinQuote = { status: FundStatus; source: string; payAmount: bigint; expiresAt: number };

/** How long after its quote expires a cash-in transfer is still accepted (its transaction may land late). */
export const CASHIN_GRACE_SECS = 600;

// Same alphabet as order ids: lowercase Crockford base32.
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const FUND_ID_RE = /^rf_[0-9a-hjkmnp-tv-z]{10}$/;

export function newFundId(): string {
  let id = "rf_";
  for (const b of randomBytes(10)) id += ALPHABET[b & 31];
  return id;
}

export function isFundId(s: string): boolean {
  return FUND_ID_RE.test(s);
}

/** Memo format: `rv1f|<fund_id>`. Returns the fund id, or null if this is not a funding memo. */
export function parseFundMemo(memo: string | null): { fundId: string | null } | null {
  if (memo === null) return null;
  const parts = memo.replace(/\0+$/, "").trim().split("|");
  if (parts[0] !== "rv1f") return null;
  return { fundId: parts.length === 2 && isFundId(parts[1]) ? parts[1] : null };
}

export class FundBook {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(db: DatabaseSync, now: () => number) {
    this.db = db;
    this.now = now;
  }

  /** Fundings still waiting for a deposit to arrive or confirm. */
  openCount(): number {
    const r = this.db
      .prepare("SELECT COUNT(*) AS n FROM fund_orders WHERE status IN ('awaiting_payment','seen')")
      .get() as { n: number };
    return r.n;
  }

  create(amountZat: bigint, ttlSecs: number) {
    const fundId = newFundId();
    const expiresAt = Math.floor(this.now() / 1000) + ttlSecs;
    this.db
      .prepare("INSERT INTO fund_orders (fund_id, amount_zat, expires_at, status) VALUES (?, ?, ?, 'awaiting_payment')")
      .run(fundId, Number(amountZat), expiresAt);
    return {
      fund_id: fundId,
      credits: Number(amountZat / CREDIT_ZAT),
      expires_at: new Date(expiresAt * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    };
  }

  get(fundId: string): { status: FundStatus; confirmations: number } | null {
    const r = this.row(fundId);
    return r ? { status: r.status, confirmations: r.confirmations } : null;
  }

  /** What /sign needs: status, the number of credits, and the hash of the set signed when minted. */
  signState(fundId: string): { status: FundStatus; credits: number; blindedHash: string | null } | null {
    const r = this.row(fundId);
    return r ? { status: r.status, credits: Number(BigInt(r.amount_zat) / CREDIT_ZAT), blindedHash: r.blinded_hash } : null;
  }

  /**
   * Moves funded -> minted, recording the hash of the signed blinded set. False if
   * it was not `funded` (already minted, or never funded).
   */
  claimMinted(fundId: string, blindedHash: string): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.row(fundId);
      const r = this.db
        .prepare("UPDATE fund_orders SET status = 'minted', blinded_hash = ?, note_key = NULL WHERE fund_id = ? AND status = 'funded'")
        .run(blindedHash, fundId);
      // Like a paid order: once minted, which Zcash note paid it is forgotten; only its
      // hash stays, so a re-emitted watcher line for that note is ignored.
      if (Number(r.changes) === 1 && row?.note_key) {
        this.db.prepare("INSERT OR IGNORE INTO settled_notes VALUES (?)").run(createHash("sha256").update(row.note_key).digest("hex"));
      }
      this.db.exec("COMMIT");
      return Number(r.changes) === 1;
    } catch (e) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** A cash-in (v1.5): a funding paid by a transfer of `payAmount` on `chain` instead of a ZEC note. */
  createCashin(chain: string, credits: number, payAmount: bigint, ttlSecs: number) {
    const fundId = newFundId();
    const expiresAt = Math.floor(this.now() / 1000) + ttlSecs;
    this.db
      .prepare("INSERT INTO fund_orders (fund_id, amount_zat, expires_at, status, source, pay_amount) VALUES (?, ?, ?, 'awaiting_payment', ?, ?)")
      .run(fundId, Number(BigInt(credits) * CREDIT_ZAT), expiresAt, chain, payAmount.toString());
    return { fund_id: fundId, expires_at: new Date(expiresAt * 1000).toISOString().replace(/\.\d{3}Z$/, "Z") };
  }

  cashinQuote(fundId: string): CashinQuote | null {
    const r = this.row(fundId);
    return r?.source ? { status: r.status, source: r.source, payAmount: BigInt(r.pay_amount!), expiresAt: r.expires_at } : null;
  }

  /**
   * Funds a cash-in with a verified transaction, once: false when that
   * transaction was already used, or the cash-in is no longer awaiting payment.
   */
  fundCashin(fundId: string, txHash: string): "funded" | "tx_used" | "not_awaiting" {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.db.prepare("SELECT 1 FROM used_cashin_txs WHERE tx_hash = ?").get(txHash)) {
        this.db.exec("ROLLBACK");
        return "tx_used";
      }
      const r = this.db.prepare("UPDATE fund_orders SET status = 'funded', confirmations = ? WHERE fund_id = ? AND source IS NOT NULL AND status = 'awaiting_payment'").run(REQUIRED_CONFS, fundId);
      if (Number(r.changes) !== 1) {
        this.db.exec("ROLLBACK");
        return "not_awaiting";
      }
      this.db.prepare("INSERT INTO used_cashin_txs VALUES (?)").run(txHash);
      this.db.exec("COMMIT");
      return "funded";
    } catch (e) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** Cancels an unpaid funding, as OrderBook.cancel does for orders. */
  cancel(fundId: string): CancelResult {
    return cancelRow(this.db, "fund_orders", "fund_id", fundId);
  }

  expire(): void {
    // A cash-in keeps the grace window open for a transfer that landed just in time.
    this.db
      .prepare("UPDATE fund_orders SET status = 'expired' WHERE status = 'awaiting_payment' AND expires_at + (CASE WHEN source IS NULL THEN 0 ELSE ? END) <= ?")
      .run(CASHIN_GRACE_SECS, Math.floor(this.now() / 1000));
  }

  /** True if this note already belongs to a funding (its confirmations were updated). */
  onKnownNote(key: string, n: NoteLine): boolean {
    const row = this.db.prepare("SELECT * FROM fund_orders WHERE note_key = ?").get(key) as FundRow | undefined;
    if (!row) return false;
    this.updateConfs(row, n.confirmations);
    return true;
  }

  /**
   * Applies a new note carrying a funding memo, with the same review rules as
   * orders. Returns a review-note reason when the note matches no open funding.
   */
  onNote(key: string, n: NoteLine, fundId: string | null): string | null {
    if (fundId === null) return "malformed_memo";
    const fund = this.row(fundId);
    if (!fund) return wasCancelled(this.db, fundId) ? "paid_after_cancel" : "unknown_fund";
    // A cash-in is paid on its own chain, never with ZEC.
    if (fund.source) return "wrong_rail";
    if (fund.status !== "awaiting_payment" && fund.status !== "expired") return "duplicate_payment";

    let reason: string | null = null;
    if (fund.status === "expired") reason = "paid_after_expiry";
    else if (BigInt(n.value) !== BigInt(fund.amount_zat)) reason = "wrong_amount";

    this.db
      .prepare("UPDATE fund_orders SET status = ?, note_key = ?, confirmations = ?, review_reason = ? WHERE fund_id = ?")
      .run(reason ? "needs_review" : "seen", key, n.confirmations, reason, fundId);
    if (!reason) this.updateConfs(this.row(fundId)!, n.confirmations);
    return null;
  }

  reviewFunds(): { fund_id: string; amount_zat: number; note_key: string | null; review_reason: string | null }[] {
    return this.db
      .prepare("SELECT fund_id, amount_zat, note_key, review_reason FROM fund_orders WHERE status = 'needs_review'")
      .all() as never;
  }

  private updateConfs(row: FundRow, confs: number): void {
    let status = row.status;
    if (status === "seen" && confs >= REQUIRED_CONFS) status = "funded";
    this.db.prepare("UPDATE fund_orders SET confirmations = ?, status = ? WHERE fund_id = ?").run(confs, status, row.fund_id);
  }

  private row(fundId: string): FundRow | undefined {
    return this.db.prepare("SELECT * FROM fund_orders WHERE fund_id = ?").get(fundId) as FundRow | undefined;
  }
}
