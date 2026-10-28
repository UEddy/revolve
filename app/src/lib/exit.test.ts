import { test } from "node:test";
import assert from "node:assert/strict";
import { creditsAffordable, keepFor, MAX_PART_CREDITS, planParts } from "./exit.ts";
import { withdrawWarnings } from "./coach.ts";
import { RENT_EXEMPT_LAMPORTS } from "./cashout.ts";
import type { Credits, Funding } from "./model.ts";

/** A seeded generator, so each run checks the same plans. */
function seeded(seed: number) {
  return () => ((seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31);
}

test("credits affordable: whole credits after what must stay; Solana keeps the rent minimum and every part's fee", () => {
  const keep = keepFor("solana", 3);
  assert.ok(keep > RENT_EXEMPT_LAMPORTS);
  assert.equal(creditsAffordable(keep + 3n * 12_400_000n - 1n, 12_400_000n, keep), 2);
  assert.equal(creditsAffordable(keep + 3n * 12_400_000n, 12_400_000n, keep), 3);
  assert.equal(creditsAffordable(keep, 12_400_000n, keep), 0);
  assert.equal(keepFor("base", 2, 1_000n), 4_000n, "Base: twice each transfer's gas");
});

test("all now: as few parts as the 0.05 ZEC cap allows, all due at once", () => {
  assert.deepEqual(planParts(7, "now", 1_000), [{ credits: 7, at: 1_000 }]);
  assert.deepEqual(planParts(120, "now", 0).map((p) => p.credits), [50, 50, 20]);
  assert.deepEqual(planParts(0, "now", 0), []);
});

test("gradual: 3 to 6 parts of varied sizes, none over the cap, summing exactly, first 15-45 min out, all within ~8 h", () => {
  const MIN = 60_000;
  for (let seed = 1; seed <= 200; seed++) {
    const credits = 3 + (seed * 37) % 240;
    const parts = planParts(credits, "gradual", 0, seeded(seed));
    assert.equal(parts.reduce((n, p) => n + p.credits, 0), credits, `seed ${seed}`);
    assert.ok(parts.length >= Math.min(3, credits) && parts.length <= Math.max(6, Math.ceil(credits / MAX_PART_CREDITS)), `count, seed ${seed}`);
    assert.ok(parts.every((p) => p.credits >= 1 && p.credits <= MAX_PART_CREDITS), `sizes, seed ${seed}`);
    assert.ok(parts[0]!.at >= 15 * MIN && parts[0]!.at <= 45 * MIN, `first, seed ${seed}`);
    assert.ok(parts.every((p, i) => i === 0 || p.at >= parts[i - 1]!.at), "in time order");
    assert.ok(parts.at(-1)!.at <= (45 + 480) * MIN);
  }
  assert.equal(planParts(2, "gradual", 0, seeded(3)).length, 2, "never more parts than credits");
});

test("withdrawal coach: right after credits came in, the same amount, or the whole balance", () => {
  const now = Date.parse("2026-10-28T12:00:00Z");
  const f = (credits: number, minsAgo: number, cashin = false): Funding =>
    ({ fundId: "rf_x", depositUa: "", amountZec: "0", credits, expiresAt: "", createdAt: 0, status: "minted", keyId: "k", mintedAt: now - minsAgo * 60_000, ...(cashin ? { cashin: { chain: "solana", positionId: "p", payTo: "x", payAmount: "1" } } : {}) }) as Funding;
  const c = (fundings: Funding[], tokens: number): Credits => ({ key: null, tokens: Array.from({ length: tokens }, () => ({ msg: "", sig: "", keyId: "k" })), fundings, pending: [] });

  const soon = withdrawWarnings(5, c([f(12, 30, true)], 20), now);
  assert.deepEqual(soon.map((w) => [w.level, w.title]), [["high", "Credits came in 30 minutes ago"]]);
  assert.match(soon[0]!.body, /cash-out/);
  assert.deepEqual(withdrawWarnings(12, c([f(12, 300)], 20), now).map((w) => w.title), ["Same amount as a recent cash-in"]);
  assert.deepEqual(withdrawWarnings(20, c([f(12, 300)], 20), now).map((w) => w.level), ["medium"]);
  assert.deepEqual(withdrawWarnings(5, c([f(12, 3000)], 20), now), [], "a day later, a different part: nothing to warn about");
});
