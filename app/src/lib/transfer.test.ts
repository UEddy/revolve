import { test } from "node:test";
import assert from "node:assert/strict";
import { base58 } from "@scure/base";
import { ata, cashIx, compileMessage, tokenIxs, unsignedTx } from "./transfer.ts";
import { parseTx } from "./tx.ts";
import { newBurner } from "./burner.ts";

const OWNER = "S7vYFFWH6BjJyEsdrPQpqpYTqLTrPRK6KW3VwsJuRaS";

test("associated token addresses match mainnet for both token programs", async () => {
  assert.equal(await ata(OWNER, "8brQDTMizXaUB5LEYbkLnHJD6z6MEpWntUZXaNeVpump", "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), "2FVLuJ8APSB2uT55k6pvecdWUQaCKH5KcMmP5KjLKMca");
  assert.equal(await ata(OWNER, "Xs6debZjNw2y4JX8ryFWUhZgXCSjfbWdWe9r72jNjU1", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"), "1YzuLaosZaQZsPanr4PZ74temFqLQ4tvxofbU9YTeoJ");
});

test("compiled transfers put the payer first and order accounts by role", async () => {
  const me = newBurner().pub;
  const blockhash = base58.encode(new Uint8Array(32).fill(7));
  const cash = parseTx(unsignedTx(compileMessage(me, [cashIx(me, OWNER, 1000n)], blockhash), 1));
  assert.equal(cash.requiredSigners.length, 1);
  assert.equal(base58.encode(cash.requiredSigners[0]!), me);
  const msg = cash.message;
  assert.deepEqual([...msg.subarray(0, 3)], [1, 0, 1]); // 1 signer, system program read-only
  const ixs = await tokenIxs(me, OWNER, "Xs6debZjNw2y4JX8ryFWUhZgXCSjfbWdWe9r72jNjU1", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", base58.encode(new Uint8Array(32).fill(3)), 5n, 8);
  const tok = parseTx(unsignedTx(compileMessage(me, ixs, blockhash), 1));
  // payer + source + dest ata writable; owner, mint, system, token program, ata program read-only
  assert.deepEqual([...tok.message.subarray(0, 4)], [1, 0, 5, 8]);
});
