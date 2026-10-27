import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { buyWarnings, positionRisk, sendWarnings } from "./coach.ts";
import { Stagger } from "./stagger.ts";
import type { Position, TokenRef } from "./model.ts";

const token = (o: Partial<TokenRef> = {}): TokenRef => ({ mint: "M1", symbol: "T", name: "T", decimals: 6, isStock: false, verified: true, holderCount: 50_000, ...o });
const pos = (id: string, o: Partial<Position> = {}): Position => ({
  id,
  createdAt: Date.parse("2026-10-26T12:00:00Z"),
  burner: { pub: `pub-${id}`, seed: "" },
  token: token(),
  order: { id: "rv_aaaaaaaa", amountZec: "0.01", depositUa: "u1", payoutLamports: "1", quoteExpiresAt: "", status: "paid_out", confirmations: 3 },
  stage: "held",
  sends: [],
  ...o,
});

test("a quiet position in a big token scores low", () => {
  const p = pos("a");
  const r = positionRisk(p, [p]);
  assert.equal(r.level, "low");
  assert.equal(r.score, 10);
});

test("launch sniping in a tiny token scores high", () => {
  const p = pos("a", { token: token({ launchedAt: "2026-10-26T11:57:00Z", holderCount: 40 }) });
  const r = positionRisk(p, [p]);
  assert.equal(r.level, "high");
  assert.ok(r.reasons.some((x) => /10 minutes/.test(x.text)));
});

test("two wallets sending to one address are flagged as joined", () => {
  const a = pos("a", { sends: [{ to: "DEST", at: 1, sig: "s", what: "asset" }] });
  const b = pos("b", { sends: [{ to: "DEST", at: 2, sig: "t", what: "asset" }] });
  const r = positionRisk(a, [a, b]);
  assert.ok(r.reasons.some((x) => x.points === 40));
  assert.equal(sendWarnings(pos("c"), "DEST", [a, b])[0]!.level, "high");
  assert.equal(sendWarnings(a, "pub-b", [a, b])[0]!.title, "That is another of your wallets");
});

test("buy warnings fire at the moment of risk", () => {
  const now = Date.parse("2026-10-26T12:00:00Z");
  const w = buyWarnings(token({ launchedAt: "2026-10-26T11:58:00Z", holderCount: 12, verified: false }), [pos("x", { stage: "settling" })], now);
  assert.deepEqual(w.map((x) => x.level), ["high", "medium", "medium", "medium", "low"]);
  assert.equal(buyWarnings(token(), [], now).length, 0);
});

test("stagger never checks two burners within the minimum gap, and keeps checking each", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  try {
    const runs: { id: string; at: number }[] = [];
    const s = new Stagger(async (id) => void runs.push({ id, at: Date.now() }), {
      firstDelay: [0, 1_000],
      interval: [10_000, 20_000],
      gap: [2_000, 3_000],
    });
    s.sync(["a", "b", "c", "d", "e"]);
    for (let t = 0; t < 120_000; t += 250) {
      mock.timers.tick(250);
      await Promise.resolve();
      await Promise.resolve();
    }
    s.stop();
    for (let i = 1; i < runs.length; i++) assert.ok(runs[i]!.at - runs[i - 1]!.at >= 2_000, `gap at ${i}`);
    for (const id of "abcde") assert.ok(runs.filter((r) => r.id === id).length >= 3, id);
  } finally {
    mock.timers.reset();
  }
});
