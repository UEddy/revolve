import assert from "node:assert/strict";
import { test } from "node:test";
import { Keypair } from "@solana/web3.js";
import { openDb } from "../src/db.ts";
import { OrderBook, isOrderId, newOrderId, onGrid, parseMemo, zatToZec, zecToZat, type NoteLine } from "../src/orders.ts";

const burner = Keypair.generate().publicKey.toBase58();

function setup() {
  let now = Date.parse("2026-10-27T10:00:00Z");
  const book = new OrderBook(openDb(":memory:"), () => now);
  return { book, advance: (ms: number) => (now += ms) };
}

function note(memo: string | null, value: number, confirmations: number, txid = "aa".repeat(32)): NoteLine {
  return { txid, pool: "ironwood", output_index: 0, value, memo, height: 3_600_000, confirmations };
}

test("order ids are random base32 with the rv_ prefix", () => {
  const a = newOrderId();
  assert.ok(isOrderId(a), a);
  assert.notEqual(a, newOrderId());
});

test("memo parsing", () => {
  assert.deepEqual(parseMemo(`rv1|rv_0123456789|${burner}`), { orderId: "rv_0123456789", chain: "solana", burner });
  assert.deepEqual(parseMemo(`rv1|rv_0123456789|base|0xAbC`), { orderId: "rv_0123456789", chain: "base", burner: "0xAbC" });
  assert.deepEqual(parseMemo(`rv1|rv_0123456789|tron|x`), { orderId: "rv_0123456789", chain: null, burner: "x" });
  assert.equal(parseMemo(`rv1|rv_0123456789|base|0xAbC|extra`), null);
  assert.equal(parseMemo("rv2|rv_0123456789|x"), null);
  assert.equal(parseMemo("rv1|bad|x"), null);
  assert.equal(parseMemo(null), null);
});

test("zec formatting", () => {
  assert.equal(zatToZec(500_000n), "0.005");
  assert.equal(zatToZec(100_000_000n), "1");
});

test("zec parsing is strict decimal", () => {
  assert.equal(zecToZat("0.004"), 400_000n);
  assert.equal(zecToZat("0.0040"), 400_000n);
  assert.equal(zecToZat("1"), 100_000_000n);
  assert.equal(zecToZat("12.00000001"), 1_200_000_001n);
  for (const bad of ["", ".004", "0.", "-0.004", "+1", "1e-3", "0x10", "00.004", " 0.004", "0.000000001", "123456789"]) {
    assert.equal(zecToZat(bad), null, bad);
  }
});

test("order amount grid", () => {
  assert.ok(onGrid(200_000n));
  assert.ok(onGrid(400_000n));
  assert.ok(!onGrid(100_000n), "below min");
  assert.ok(!onGrid(450_000n), "off grid");
});

test("happy path: seen, confirmed, delayed payout, then mapping deleted", () => {
  const { book } = setup();
  const o = book.create(1_000_000n, 123n, 1800);
  assert.equal(o.amount_zec, "0.01");
  assert.equal(o.quote_expires_at, "2026-10-27T10:30:00Z");
  assert.equal(book.get(o.order_id)!.status, "awaiting_payment");

  const memo = `rv1|${o.order_id}|${burner}`;
  book.onNote(note(memo, 1_000_000, 1));
  assert.deepEqual(book.get(o.order_id), { status: "seen", confirmations: 1, payout_signature: null });

  book.onNote(note(memo, 1_000_000, 3));
  assert.equal(book.get(o.order_id)!.status, "confirmed");
  assert.equal(book.due().length, 0, "random delay of at least 2 blocks");

  book.onNote(note(memo, 1_000_000, 9));
  const due = book.due();
  assert.deepEqual(due, [{ orderId: o.order_id, burner, lamports: 123n }]);

  book.markPaying(o.order_id, "sig1", 100);
  assert.equal(book.get(o.order_id)!.status, "confirmed");
  assert.equal(book.due().length, 0);

  book.markPaid(o.order_id, "sig1");
  assert.deepEqual(book.get(o.order_id), { status: "paid_out", payout_signature: "sig1" });

  // A re-emitted line for the settled note changes nothing and is not flagged.
  book.onNote(note(memo, 1_000_000, 10));
  assert.equal(book.due().length, 0);
});

test("paid cache expires to 404", () => {
  const { book, advance } = setup();
  const o = book.create(500_000n, 1n, 1800);
  const memo = `rv1|${o.order_id}|${burner}`;
  book.onNote(note(memo, 500_000, 20));
  book.markPaying(o.order_id, "s", 1);
  book.markPaid(o.order_id, "s");
  advance(16 * 60 * 1000);
  assert.equal(book.get(o.order_id), null);
});

test("wrong amount goes to needs_review", () => {
  const { book } = setup();
  const o = book.create(1_000_000n, 1n, 1800);
  book.onNote(note(`rv1|${o.order_id}|${burner}`, 999_999, 5));
  assert.equal(book.get(o.order_id)!.status, "needs_review");
  assert.equal(book.due().length, 0);
});

test("a free amount on the grid matches exactly, nothing else", () => {
  const { book } = setup();
  const o = book.create(400_000n, 52_345_678n, 1800);
  assert.equal(o.amount_zec, "0.004");
  book.onNote(note(`rv1|${o.order_id}|${burner}`, 400_000, 1));
  assert.equal(book.get(o.order_id)!.status, "seen");

  const near = book.create(400_000n, 1n, 1800);
  book.onNote(note(`rv1|${near.order_id}|${burner}`, 400_001, 5, "bb".repeat(32)));
  assert.equal(book.get(near.order_id)!.status, "needs_review");
});

test("invalid burner goes to needs_review", () => {
  const { book } = setup();
  const o = book.create(1_000_000n, 1n, 1800);
  book.onNote(note(`rv1|${o.order_id}|notakey`, 1_000_000, 5));
  assert.equal(book.get(o.order_id)!.status, "needs_review");
});

test("expiry, and payment after expiry needs review", () => {
  const { book, advance } = setup();
  const o = book.create(1_000_000n, 1n, 60);
  advance(61_000);
  book.expire();
  assert.equal(book.get(o.order_id)!.status, "expired");
  book.onNote(note(`rv1|${o.order_id}|${burner}`, 1_000_000, 1));
  assert.equal(book.get(o.order_id)!.status, "needs_review");
});

test("second payment to the same order does not pay twice", () => {
  const { book } = setup();
  const o = book.create(1_000_000n, 1n, 1800);
  const memo = `rv1|${o.order_id}|${burner}`;
  book.onNote(note(memo, 1_000_000, 20, "aa".repeat(32)));
  book.onNote(note(memo, 1_000_000, 20, "bb".repeat(32)));
  assert.equal(book.due().length, 1);
});

test("expired in-flight payout can be retried", () => {
  const { book } = setup();
  const o = book.create(1_000_000n, 1n, 1800);
  book.onNote(note(`rv1|${o.order_id}|${burner}`, 1_000_000, 20));
  book.markPaying(o.order_id, "s", 50);
  assert.deepEqual(book.inFlight(), [{ orderId: o.order_id, signature: "s", validUntilBlockHeight: 50 }]);
  book.retryPayout(o.order_id);
  assert.equal(book.due().length, 1);
});

test("a payout can be claimed by only one process", () => {
  const { book } = setup();
  const o = book.create(1_000_000n, 1n, 1800);
  book.onNote(note(`rv1|${o.order_id}|${burner}`, 1_000_000, 20));
  assert.equal(book.markPaying(o.order_id, "first", 50), true);
  assert.equal(book.markPaying(o.order_id, "second", 50), false);
  assert.equal(book.inFlight()[0].signature, "first");
});

test("review note confirmations follow re-emitted lines", () => {
  const { book } = setup();
  book.onNote(note("Love", 500_000, 1));
  book.onNote(note("Love", 500_000, 4));
  assert.deepEqual(book.reviewNotes().map((n) => [n.reason, n.confirmations]), [["malformed_memo", 4]]);
});

test("bind a review note to an expired order's quote, pay once", () => {
  const { book, advance } = setup();
  const o = book.create(500_000n, 65_000_000n, 60);
  advance(61_000);
  book.expire();
  book.onNote(note("Love", 500_000, 5));
  const key = book.reviewNotes()[0].note_key;

  const id = book.bindReviewNote(key, burner, { orderId: o.order_id });
  assert.equal(id, o.order_id);
  assert.deepEqual(book.reviewNotes(), []);
  assert.deepEqual(book.due(), [{ orderId: o.order_id, burner, lamports: 65_000_000n }]);
  assert.throws(() => book.bindReviewNote(key, burner, { lamports: 1n }), /no such review note/);

  // The re-emitted line now belongs to the order and is not reviewed again.
  book.onNote(note("Love", 500_000, 6));
  assert.deepEqual(book.reviewNotes(), []);
  book.markPaying(id, "s", 1);
  book.markPaid(id, "s");
  book.onNote(note("Love", 500_000, 7));
  assert.deepEqual(book.reviewNotes(), [], "settled note stays settled");
});

test("bind refuses an order that already has a note", () => {
  const { book } = setup();
  const o = book.create(500_000n, 1n, 1800);
  book.onNote(note(`rv1|${o.order_id}|${burner}`, 500_000, 5, "aa".repeat(32)));
  book.onNote(note("Love", 500_000, 5, "bb".repeat(32)));
  const key = book.reviewNotes()[0].note_key;
  assert.throws(() => book.bindReviewNote(key, burner, { orderId: o.order_id }), /must exist, be unpaid/);
  assert.equal(book.reviewNotes().length, 1, "rolled back");
});

test("bind with explicit lamports creates an internal order", () => {
  const { book } = setup();
  book.onNote(note("Love", 50_000, 5));
  const id = book.bindReviewNote(book.reviewNotes()[0].note_key, burner, { lamports: 7n });
  assert.deepEqual(book.due(), [{ orderId: id, burner, lamports: 7n }]);
});
