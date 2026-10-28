import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_PRICE_MOVE_BPS, Pricing, exceedsBy, guardPayout } from "../src/pricing.ts";

test("a payout is the order's value less the spread, with nothing added for gas", () => {
  // 12 SOL per ZEC, 1.5% spread: 0.005 ZEC is worth 0.06 SOL, and pays 0.0591 SOL.
  const p = new Pricing({ lamportsPerZec: 12_000_000_000n, spreadBps: 150, weiPerZec: 400_000_000_000_000_000n });
  assert.equal(p.payoutLamports(500_000n), 59_100_000n);
  // 0.4 ETH per ZEC: 0.005 ZEC is worth 0.002 ETH, and pays 0.00197 ETH.
  assert.equal(p.payoutWei(500_000n), 1_970_000_000_000_000n);
  // Revolve never pays out more than the order is worth, at any size.
  for (const zat of [200_000n, 500_000n, 5_000_000n]) assert.ok(p.payoutLamports(zat)! < (zat * 12_000_000_000n) / 100_000_000n);
});

test("a cash-in credit costs the spread the other way", () => {
  const p = new Pricing({ lamportsPerZec: 12_000_000_000n, spreadBps: 150 });
  // 0.001 ZEC is worth 0.012 SOL; a credit costs 1.5% more.
  assert.equal(p.cashinPerCredit("solana", 100_000n), 12_180_000n);
});

test("a quote is paid as quoted unless the market moved against Revolve by more than 3%; then at today's rate", () => {
  assert.equal(MAX_PRICE_MOVE_BPS, 300);
  // Quoted 100; the same order is worth 98 now (2% against Revolve): the quote stands.
  assert.equal(guardPayout(100n, 98n, 300), 100n);
  // Worth 96 now (over 3% against Revolve): paid at today's 96.
  assert.equal(guardPayout(100n, 96n, 300), 96n);
  // Worth more now (the user's favour): the quote stands.
  assert.equal(guardPayout(100n, 120n, 300), 100n);
  // No fresh price: wait.
  assert.equal(guardPayout(100n, null, 300), null);
  assert.equal(exceedsBy(1030n, 1000n, 300), false, "exactly 3% is still within");
  assert.equal(exceedsBy(1031n, 1000n, 300), true);
});

test("a cash-in is priced from the rates seen when its transfer landed", () => {
  const p = new Pricing({ lamportsPerZec: null, spreadBps: 150 });
  const t0 = Date.parse("2026-10-28T12:00:00Z");
  p.record({ lamportsPerZec: 12e9, weiPerZec: null, usdPerZec: 1200 }, t0);
  p.record({ lamportsPerZec: 13e9, weiPerZec: null, usdPerZec: 1200 }, t0 + 60_000);
  const at = (ms: number) => Math.floor(ms / 1000);
  assert.equal(p.cashinPerCreditAt("solana", 100_000n, at(t0 + 30_000)), 12_180_000n, "the rate in force then");
  assert.equal(p.cashinPerCreditAt("solana", 100_000n, at(t0 + 90_000)), 13_195_000n);
  assert.equal(p.cashinPerCreditAt("solana", 100_000n, at(t0 - 1_000)), null, "before anything was seen");
  assert.equal(p.cashinPerCreditAt("solana", 100_000n, at(t0 + 60_000 + 11 * 60_000)), null, "too long after the last rate");
  assert.equal(p.cashinPerCreditAt("base", 100_000n, at(t0 + 30_000)), null, "no ETH price was seen");
});
