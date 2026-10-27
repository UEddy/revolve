import { test } from "node:test";
import assert from "node:assert/strict";
import { checkCashOut, formatSol, maxSendable, parseSol, RENT_EXEMPT_LAMPORTS, ZODL_MIN_LAMPORTS } from "./cashout.ts";
import { cashOutWarnings, positionRisk } from "./coach.ts";
import type { Position, TokenRef } from "./model.ts";

const SELF = "3Ddy48qmCFuYuaeMRcnza1AFNWDmRionWYkKQXRVtuaW";
const DEPOSIT = "So11111111111111111111111111111111111111112";
const OTHER = "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr";

test("SOL amounts parse to lamports exactly, as Zodl shows them", () => {
  assert.equal(parseSol("0.0251"), 25_100_000n);
  assert.equal(parseSol("0,0251"), 25_100_000n);
  assert.equal(parseSol(" 1 "), 1_000_000_000n);
  assert.equal(parseSol(".5"), 500_000_000n);
  assert.equal(parseSol("0.123456789"), 123_456_789n);
  for (const bad of ["", ".", "-1", "1e-3", "0.1234567891", "1.2.3", "abc", "0x10"]) assert.equal(parseSol(bad), null, bad);
  assert.equal(formatSol(25_100_000n), "0.0251");
  assert.equal(formatSol(1_000_000_000n), "1");
  assert.equal(formatSol(0n), "0");
  assert.equal(maxSendable(30_000_000n), 29_995_000n);
  assert.equal(maxSendable(4_000n), 0n);
});

test("cash out: Solana deposit address, at least Zodl's minimum, within the balance, no dust left behind", () => {
  const bal = 30_000_000n; // 0.03 SOL
  assert.deepEqual(checkCashOut(DEPOSIT, "0.029995", bal, SELF), { ok: true, amount: 29_995_000n, leftover: 0n });
  const part = checkCashOut(DEPOSIT, "0.02", bal, SELF);
  assert.ok(part.ok && part.leftover === 9_995_000n);
  const err = (to: string, amt: string, b = bal) => {
    const r = checkCashOut(to, amt, b, SELF);
    return r.ok ? null : `${r.field}: ${r.error}`;
  };
  assert.match(err("t1abc", "0.02")!, /^to: That is not a Solana address/);
  assert.match(err("u1qwerty", "0.02")!, /^to: /);
  assert.match(err(SELF, "0.02")!, /^to: That is this position's own wallet/);
  assert.match(err(DEPOSIT, "")!, /^amount: Enter the SOL amount/);
  assert.match(err(DEPOSIT, "0")!, /^amount: Enter the SOL amount/);
  assert.match(err(DEPOSIT, "0.0169")!, /^amount: Zodl's minimum is about 0.017 SOL/);
  assert.equal(err(DEPOSIT, "0.017", 100_000_000n), null, "exactly the minimum is fine");
  assert.match(err(DEPOSIT, "0.03")!, /^amount: This wallet can send at most 0.029995 SOL/);
  // Leaves 0.0005 SOL: above zero but below rent exemption, which Solana rejects.
  assert.match(err(DEPOSIT, "0.029495")!, /which Solana doesn't allow. Send 0.029995 SOL \(everything\)/);
  assert.equal(err(DEPOSIT, formatSol(bal - 5_000n - RENT_EXEMPT_LAMPORTS)), null, "leaving exactly the rent minimum is fine");
  assert.match(err(DEPOSIT, "0.017", 10_000_000n)!, /at most 0.009995/);
  assert.equal(ZODL_MIN_LAMPORTS, 17_000_000n);
});

const token: TokenRef = { mint: "M1", symbol: "T", name: "T", decimals: 6, isStock: false, verified: true, holderCount: 50_000 };
const NOW = Date.parse("2026-10-27T12:00:00Z");
const pos = (id: string, o: Partial<Position> = {}): Position => ({
  id,
  createdAt: NOW - 3 * 24 * 3600_000,
  burner: { pub: `pub-${id}`, seed: "" },
  token,
  order: { id: "rv_aaaaaaaa", amountZec: "0.01", depositUa: "u1", payoutLamports: "1", quoteExpiresAt: "", status: "paid_out", confirmations: 3 },
  stage: "closed",
  sends: [],
  ...o,
});
const titles = (w: { title: string }[]) => w.map((x) => x.title);

test("cash-out coach: right after buying, and a whole large position at once", () => {
  const old = pos("a");
  assert.deepEqual(cashOutWarnings(old, DEPOSIT, 50_000_000n, 99_995_000n, [old], NOW, 100), [], "an old position, half of a small balance: quiet");
  const fresh = pos("b", { swap: { at: NOW - 12 * 60_000, attempts: 1 } });
  assert.deepEqual(titles(cashOutWarnings(fresh, DEPOSIT, 50_000_000n, 99_995_000n, [fresh], NOW, 100)), ["You bought this 12 minutes ago"]);
  // 3 SOL at $100 = $300, all of it: large and whole.
  assert.deepEqual(titles(cashOutWarnings(old, DEPOSIT, 2_999_995_000n, 2_999_995_000n, [old], NOW, 100)), ["This cashes out the whole position at once"]);
  // Whole but small ($30): no warning. Large but only half: no warning.
  assert.deepEqual(cashOutWarnings(old, DEPOSIT, 299_995_000n, 299_995_000n, [old], NOW, 100), []);
  assert.deepEqual(cashOutWarnings(old, DEPOSIT, 3_000_000_000n, 6_000_000_000n, [old], NOW, 100), []);
  // Without a SOL price, "large" falls back to 2 SOL.
  assert.equal(cashOutWarnings(old, DEPOSIT, 2_000_000_000n, 2_000_000_000n, [old], NOW).length, 1);
  assert.equal(cashOutWarnings(old, DEPOSIT, 1_000_000_000n, 1_000_000_000n, [old], NOW).length, 0);
});

test("cash-out coach: an own wallet or a reused deposit address is high risk", () => {
  const a = pos("a");
  const b = pos("b", { burner: { pub: OTHER, seed: "" } });
  assert.equal(cashOutWarnings(a, OTHER, 50_000_000n, 99_995_000n, [a, b], NOW, 100)[0]!.level, "high");
  const used = pos("c", { sends: [{ to: DEPOSIT, at: NOW - 3600_000, sig: "s", what: "cash", cashout: true }] });
  const w = cashOutWarnings(a, DEPOSIT, 50_000_000n, 99_995_000n, [a, used], NOW, 100);
  assert.deepEqual(titles(w), ["You sent to this address before"]);
  assert.equal(w[0]!.level, "high");
});

test("a cash-out shows in the position's linkability as what it is", () => {
  const p = pos("a", { sends: [{ to: DEPOSIT, at: NOW, sig: "s", what: "cash", cashout: true }] });
  const r = positionRisk(p, [p]);
  assert.ok(r.reasons.some((x) => /Cashed out to Zcash through Zodl's swap/.test(x.text)));
  assert.equal(r.score, 20);
});

test("an unconfirmed transfer still carries its signature, so it is recorded rather than resent", async () => {
  const { UnconfirmedTransfer } = await import("./transfer.ts");
  const e = new UnconfirmedTransfer("5igSig");
  assert.ok(e instanceof Error);
  assert.equal(e.sig, "5igSig");
  assert.match(e.message, /sent but not confirmed yet/);
});
