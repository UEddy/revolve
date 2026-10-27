import { test } from "node:test";
import assert from "node:assert/strict";
import { checkAmount, formatZec, parseLimits, parseZec, roundToStep, usdToZats, zecToUsd, type Limits } from "./amount.ts";
import { amountNote } from "./coach.ts";

const limits: Limits = parseLimits({ min_zec: "0.002", max_zec: "0.007", step_zec: "0.001", indicative_usd_per_zec: "1224.50" });
const z = (s: string) => parseZec(s)!;

test("parse and format ZEC exactly", () => {
  assert.equal(parseZec("0.004"), 400_000n);
  assert.equal(parseZec("0,004"), 400_000n);
  assert.equal(parseZec(".5"), 50_000_000n);
  assert.equal(parseZec("1"), 100_000_000n);
  for (const bad of ["", ".", "abc", "1.2.3", "-1", "0.000000001", "1e-3"]) assert.equal(parseZec(bad), null, bad);
  assert.equal(formatZec(400_000n), "0.004");
  assert.equal(formatZec(100_000_000n), "1");
  assert.equal(formatZec(125_000_000n), "1.25");
});

test("rounding goes to the nearest 0.001 step", () => {
  assert.equal(roundToStep(z("0.0044"), z("0.001")), z("0.004"));
  assert.equal(roundToStep(z("0.0045"), z("0.001")), z("0.005"));
  assert.equal(roundToStep(z("0.004"), z("0.001")), z("0.004"));
});

test("USD converts through the indicative rate and back", () => {
  assert.equal(formatZec(roundToStep(usdToZats("5", limits)!, limits.step)), "0.004"); // 5 / 1224.50 = 0.00408
  assert.equal(usdToZats("5.123", limits), null); // cents only
  assert.ok(Math.abs(zecToUsd(z("0.004"), limits) - 4.898) < 1e-9);
});

test("checkAmount: ok, rounded, empty, invalid, below min, above max", () => {
  assert.deepEqual(checkAmount("0.004", "ZEC", limits), { kind: "ok", zats: z("0.004"), rounded: false });
  assert.deepEqual(checkAmount("0.0042", "ZEC", limits), { kind: "ok", zats: z("0.004"), rounded: true });
  assert.deepEqual(checkAmount("5", "USD", limits), { kind: "ok", zats: z("0.004"), rounded: true });
  assert.equal(checkAmount("  ", "ZEC", limits).kind, "empty");
  assert.equal(checkAmount("four", "USD", limits).kind, "invalid");
  assert.deepEqual(checkAmount("0.001", "ZEC", limits), { kind: "below_min", zats: z("0.001") });
  assert.deepEqual(checkAmount("0.0004", "ZEC", limits), { kind: "below_min", zats: 0n });
  assert.deepEqual(checkAmount("20", "USD", limits), { kind: "above_max", zats: z("0.016") });
});

test("max below min means temporarily unavailable, whatever is typed", () => {
  const closed = { ...limits, max: z("0.001") };
  assert.equal(checkAmount("0.004", "ZEC", closed).kind, "unavailable");
  assert.equal(checkAmount("", "ZEC", closed).kind, "unavailable");
});

test("bad /limits bodies are refused", () => {
  assert.throws(() => parseLimits({ min_zec: "0.002", max_zec: "x", step_zec: "0.001", indicative_usd_per_zec: "1" }));
  assert.throws(() => parseLimits({ min_zec: "0.002", max_zec: "0.007", step_zec: "0", indicative_usd_per_zec: "1" }));
  assert.throws(() => parseLimits({ min_zec: 0.002, max_zec: "0.007", step_zec: "0.001", indicative_usd_per_zec: "1" }));
});

test("the large-amount note is gentle and only fires near the max", () => {
  const roomy = { ...limits, max: z("0.05") };
  assert.equal(amountNote(z("0.01"), roomy), null);
  const note = amountNote(z("0.04"), roomy);
  assert.equal(note?.level, "low");
  assert.equal(amountNote(z("0.035"), roomy)?.level, "low"); // exactly 70%
  // A small max makes every amount "near the max"; no note then.
  assert.equal(amountNote(z("0.007"), limits), null);
});
