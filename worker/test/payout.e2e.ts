// Manual e2e against a local validator: `solana-test-validator --reset`, then
// `node test/payout.e2e.ts <throwaway-keypair.json>`. Not part of `npm test`.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { openDb } from "../src/db.ts";
import { OrderBook } from "../src/orders.ts";
import { Payer, runPayouts } from "../src/payout.ts";

const [keyPath] = process.argv.slice(2);
const payer = new Payer("http://127.0.0.1:8899", keyPath);
const hot = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keyPath, "utf8"))));
const sig = await payer.conn.requestAirdrop(hot.publicKey, 2 * LAMPORTS_PER_SOL);
await payer.conn.confirmTransaction(sig, "confirmed");
console.log("hot balance", await payer.refreshBalance());

const book = new OrderBook(openDb(":memory:"));
const burner = Keypair.generate().publicKey.toBase58();
const o = book.create(1_000_000n, 30_000_000n, 1800);
const memo = `rv1|${o.order_id}|${burner}`;
const line = (c: number) => ({ txid: "cd".repeat(32), pool: "ironwood", output_index: 0, value: 1_000_000, memo, height: 1, confirmations: c });

book.onNote(line(4));
await runPayouts(book, payer, { reserve: 0n, dailyCap: 10n ** 15n });
assert.equal(book.get(o.order_id)!.status, "confirmed", "still inside the random delay");

book.onNote(line(9));
await runPayouts(book, payer, { reserve: 0n, dailyCap: 10n ** 15n });
const res = book.get(o.order_id)!;
console.log("after payout", res);
assert.equal(res.status, "paid_out");
const got = await payer.conn.getBalance(new PublicKey(burner));
assert.equal(got, 30_000_000);
await runPayouts(book, payer, { reserve: 0n, dailyCap: 10n ** 15n });
book.onNote(line(10));
assert.equal(await payer.conn.getBalance(new PublicKey(burner)), 30_000_000, "no double pay");
console.log("burner received", got, "lamports; e2e ok");
