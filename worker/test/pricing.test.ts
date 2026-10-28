import { test } from "node:test";
import assert from "node:assert/strict";
import { Pricing } from "../src/pricing.ts";

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
