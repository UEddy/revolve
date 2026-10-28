import { test } from "node:test";
import assert from "node:assert/strict";
import { buildHistory, clearHistory, explorerUrl } from "./history.ts";
import type { Position, VaultData } from "./model.ts";

const T = Date.parse("2026-10-28T10:00:00Z");

function position(over: Partial<Position> = {}): Position {
  return {
    id: "p1",
    createdAt: T,
    burner: { pub: "Burner111", seed: "" },
    token: { mint: "Mint", symbol: "BONK", name: "Bonk", decimals: 5, isStock: false, verified: true },
    order: { id: "rv_0123456789", amountZec: "0.005", depositUa: "u1x", payoutLamports: "1", quoteExpiresAt: "", status: "paid_out", confirmations: 9, payoutSig: "PAYOUT", paidAt: T + 60_000 },
    stage: "closed",
    swap: { sig: "BUY", at: T + 120_000, attempts: 1 },
    sale: { sig: "SALE", at: T + 3_600_000 },
    sends: [{ to: "HotWallet9999", at: T + 7_200_000, sig: "CASHIN", what: "cash", cashin: true }],
    ...over,
  };
}

function vault(): VaultData {
  return {
    v: 1,
    createdAt: T,
    positions: [position()],
    credits: {
      key: null,
      tokens: [],
      pending: [],
      fundings: [
        { fundId: "rf_1", depositUa: "u1", amountZec: "0.002", credits: 2, expiresAt: "", createdAt: T, status: "minted", keyId: "k", mintedAt: T + 30_000 },
        { fundId: "rf_2", depositUa: "", amountZec: "0.003", credits: 3, expiresAt: "", createdAt: T, status: "minted", keyId: "k", mintedAt: T + 7_300_000, cashin: { chain: "solana", positionId: "p1", payTo: "HotWallet9999", payAmount: "1", tx: "CASHIN" } },
        { fundId: "rf_3", depositUa: "", amountZec: "0.001", credits: 1, expiresAt: "", createdAt: T, status: "awaiting_payment", keyId: "k", cashin: { chain: "solana", positionId: "p1", payTo: "HotWallet9999", payAmount: "1", tx: "INFLIGHT" } },
      ],
      withdrawals: [
        { key: "w1", id: "rw_1", amountZec: "0.001", address: "", createdAt: T + 9_000_000, status: "sent", txid: "ZTX" },
        { key: "w2", id: "rw_2", amountZec: "0.001", address: "u1me", createdAt: T + 9_100_000, status: "queued" },
      ],
    },
  };
}

test("history lists every transaction newest first, with hashes where the phone knows one", () => {
  const h = buildHistory(vault());
  assert.deepEqual(
    h.map((e) => [e.title, e.chain, e.hash ?? null]),
    [
      ["Withdrew 0.001 ZEC", "zcash", "ZTX"],
      ["Cashed out to credits", "solana", "CASHIN"],
      ["Sold BONK", "solana", "SALE"],
      ["Bought BONK", "solana", "BUY"],
      ["SOL payout received", "solana", "PAYOUT"],
      ["Added 0.002 ZEC as credits", "zcash", null],
      ["Paid 0.005 ZEC from Zodl", "zcash", null],
    ],
  );
  assert.equal(explorerUrl(h[0]!), "https://mainnet.zcashexplorer.app/transactions/ZTX");
  assert.equal(explorerUrl(h[1]!), "https://solscan.io/tx/CASHIN");
  assert.equal(explorerUrl({ chain: "base", hash: "0xabc" }), "https://basescan.org/tx/0xabc");
});

test("an unpaid order and demo placeholders aren't history", () => {
  const d = vault();
  d.positions = [position({ stage: "awaiting_payment", order: { ...position().order, status: "awaiting_payment", payoutSig: undefined }, swap: { sig: "demo", at: T, attempts: 1 }, sale: undefined, sends: [] })];
  d.credits = undefined;
  assert.deepEqual(buildHistory(d), []);
});

test("clearing deletes the hashes from the vault, keeps what's in flight and what the coach needs", () => {
  const d = vault();
  clearHistory(d, T + 10_000_000);
  assert.deepEqual(buildHistory(d), []);
  const p = d.positions[0]!;
  assert.equal(p.order.payoutSig, undefined);
  assert.equal(p.swap?.sig, undefined);
  assert.equal(p.swap?.at, T + 120_000, "the buy time stays for the coach");
  assert.equal(p.sale, undefined);
  assert.deepEqual(p.sends[0], { to: "HotWallet9999", at: T + 7_200_000, sig: "", what: "cash", cashin: true });
  assert.equal(d.credits!.fundings[1]!.cashin!.tx, undefined, "a finished cash-in's transaction goes");
  assert.equal(d.credits!.fundings[2]!.cashin!.tx, "INFLIGHT", "one still to be reported stays");
  assert.deepEqual(d.credits!.withdrawals!.map((w) => w.key), ["w2"], "a queued withdrawal stays");
  assert.ok(!JSON.stringify(d).includes("PAYOUT") && !JSON.stringify(d).includes("ZTX") && !JSON.stringify(d).includes("SALE"));

  // New activity after clearing shows up again.
  d.positions[0]!.sale = { sig: "SALE2", at: T + 11_000_000 };
  assert.deepEqual(buildHistory(d).map((e) => e.hash), ["SALE2"]);
});
