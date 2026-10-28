import assert from "node:assert/strict";
import { test } from "node:test";
import { Keypair, type Connection } from "@solana/web3.js";
import { MEMO_PROGRAM, solanaRail } from "../src/cashin.ts";
import { PublicKey } from "@solana/web3.js";

const hot = Keypair.generate().publicKey;
const sender = Keypair.generate().publicKey;
const sig = "5".repeat(87) + "1";

const memo = new PublicKey(MEMO_PROGRAM);
const FUND = "rf_0123456789";

/** A connection that knows one transaction: the sender, the hot wallet (unless left out) and a memo naming `memoText`. */
function conn(tx: null | { err?: unknown; pre: number; post: number; blockTime: number | null; hotIndex?: number; memoText?: string }): Connection {
  return {
    getTransaction: async () =>
      tx && {
        blockTime: tx.blockTime,
        meta: { err: tx.err ?? null, preBalances: [1e9, tx.pre, 0], postBalances: [9e8, tx.post, 0], loadedAddresses: undefined },
        transaction: {
          message: {
            getAccountKeys: () => ({ keySegments: () => [[sender, tx.hotIndex === -1 ? sender : hot, memo]] }),
            compiledInstructions: [{ programIdIndex: 2, accountKeyIndexes: [], data: Buffer.from(tx.memoText ?? FUND) }],
          },
        },
      },
  } as unknown as Connection;
}

test("Solana cash-in check: the hot wallet's own balance rise, in the quote's window, on a successful transaction", async () => {
  const v = (c: Connection) => solanaRail(c, hot.toBase58(), () => 1n).verify(sig, 264_000n, 1_000, 2_000, FUND);
  assert.equal(await v(conn(null)), "pending");
  assert.equal(await v(conn({ pre: 5, post: 264_005, blockTime: 1_500 })), "ok");
  assert.equal(await v(conn({ pre: 5, post: 264_004, blockTime: 1_500 })), "bad", "one lamport short");
  assert.equal(await v(conn({ pre: 5, post: 264_005, blockTime: 999 })), "bad", "before the quote");
  assert.equal(await v(conn({ pre: 5, post: 264_005, blockTime: 2_001 })), "bad", "after the grace window");
  assert.equal(await v(conn({ pre: 5, post: 264_005, blockTime: null })), "bad");
  assert.equal(await v(conn({ err: { InstructionError: [0, "x"] }, pre: 5, post: 264_005, blockTime: 1_500 })), "bad");
  assert.equal(await v(conn({ pre: 5, post: 264_005, blockTime: 1_500, hotIndex: -1 })), "bad", "the hot wallet isn't in it");
  assert.equal(await v(conn({ pre: 5, post: 264_005, blockTime: 1_500, memoText: "rf_someoneelse" })), "bad", "a transfer naming another cash-in can't be claimed");
  const rail = solanaRail(conn(null), hot.toBase58(), () => 1n);
  assert.equal(rail.normalizeTx(sig), sig);
  assert.equal(rail.normalizeTx("0x" + "ab".repeat(32)), null);
});
