import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Keypair } from "@solana/web3.js";
import { openDb } from "../src/db.ts";
import { OrderBook, dayKey } from "../src/orders.ts";
import { freeInventory, runPayouts, type Payer } from "../src/payout.ts";
import { Bucket, createApi } from "../src/server.ts";

const dir = mkdtempSync(join(tmpdir(), "revolve-hardening-"));
after(() => rmSync(dir, { recursive: true, force: true }));

async function withApi(limits: { write: Bucket; read: Bucket } | undefined, fn: (base: string) => Promise<void>) {
  const server = createApi({
    book: new OrderBook(openDb(":memory:")),
    appOrigin: "https://app.test",
    depositUa: "u1test",
    quoteTtlSecs: 900,
    maxOpenOrders: 10,
    quote: (zat) => zat * 100n,
    usdPerZec: () => "1000",
    freeInventory: () => 10n ** 12n,
    mint: null,
    limits,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
  }
}

test("every API response is JSON that can't be sniffed or framed, with timeouts set", async () => {
  await withApi(undefined, async (base) => {
    for (const path of ["/limits", "/nope", "/orders/rv_0000000000"]) {
      const res = await fetch(base + path);
      assert.equal(res.headers.get("x-content-type-options"), "nosniff", path);
      assert.equal(res.headers.get("content-security-policy"), "default-src 'none'; frame-ancestors 'none'", path);
      assert.equal(res.headers.get("access-control-allow-origin"), "https://app.test", path);
    }
  });
  const s = createApi({ book: new OrderBook(openDb(":memory:")), appOrigin: "x", depositUa: "u", quoteTtlSecs: 1, maxOpenOrders: 1, quote: () => null, usdPerZec: () => null, freeInventory: () => null, mint: null });
  assert.equal(s.requestTimeout, 15_000);
  assert.equal(s.headersTimeout, 10_000);
});

test("global rate limits: writes and reads have separate budgets, over budget is 503 busy", async () => {
  await withApi({ write: new Bucket(0, 2), read: new Bucket(0, 3) }, async (base) => {
    const post = () => fetch(`${base}/orders`, { method: "POST", body: JSON.stringify({ amount_zec: "0.002" }) });
    assert.equal((await post()).status, 201);
    assert.equal((await post()).status, 201);
    const third = await post();
    assert.equal(third.status, 503);
    assert.equal(third.headers.get("retry-after"), "1");
    assert.deepEqual(await third.json(), { error: "busy" });
    // Reads still have their own budget.
    assert.equal((await fetch(`${base}/limits`)).status, 200);
    assert.equal((await fetch(`${base}/limits`)).status, 200);
    assert.equal((await fetch(`${base}/limits`)).status, 200);
    assert.equal((await fetch(`${base}/limits`)).status, 503);
    // Preflights are never limited.
    assert.equal((await fetch(`${base}/orders`, { method: "OPTIONS" })).status, 204);
  });
});

const cfg = { solReserveLamports: 10n, hotWalletCapLamports: 1_000n, dailyPayoutCapLamports: 600n };

test("inventory never exceeds the hot wallet cap or what today's payout cap still allows", () => {
  const book = (committed: bigint, paidToday: bigint) => ({ committedLamports: () => committed, paidToday: () => paidToday });
  assert.equal(freeInventory(500n, book(0n, 0n), cfg), 490n, "a small wallet: its balance less the reserve");
  assert.equal(freeInventory(5_000n, book(0n, 0n), { ...cfg, dailyPayoutCapLamports: 10_000n }), 990n, "an overfunded wallet counts only up to its cap");
  assert.equal(freeInventory(5_000n, book(0n, 0n), cfg), 600n, "the daily cap binds before the wallet cap");
  assert.equal(freeInventory(5_000n, book(100n, 400n), cfg), 100n, "less today's payouts and open commitments");
  assert.ok(freeInventory(5_000n, book(0n, 700n), cfg) < 0n, "over the cap: nothing can be promised");
});

test("a payout that would cross the daily cap waits, before the hot wallet is even asked", async () => {
  const untouchable = new Proxy({}, { get: () => assert.fail("the payer must not be used") }) as unknown as Payer;
  const fake = {
    inFlight: () => [],
    due: () => [{ orderId: "rv_aaaaaaaaaa", burner: "x", lamports: 300n }],
    paidOrPayingToday: () => 400n,
  };
  await runPayouts(fake as unknown as OrderBook, untouchable, { reserve: 0n, dailyCap: 600n });
});

test("each payout adds to one per-day total, and nothing per order is kept", () => {
  const db = openDb(":memory:");
  let now = Date.parse("2026-10-27T10:00:00Z");
  const book = new OrderBook(db, () => now);
  const pay = (zat: bigint, payout: bigint, tx: string) => {
    const o = book.create(zat, payout, 900);
    const burner = Keypair.generate().publicKey.toBase58();
    book.onNote({ txid: tx.repeat(64), pool: "ironwood", output_index: 0, value: Number(zat), memo: `rv1|${o.order_id}|${burner}`, height: 1, confirmations: 20 });
    const due = book.due().find((d) => d.orderId === o.order_id)!;
    assert.ok(book.markPaying(due.orderId, `sig${tx}`, 100));
    assert.equal(book.paidOrPayingToday(), book.paidToday() + payout, "in flight counts against the cap");
    book.markPaid(due.orderId, `sig${tx}`);
  };
  pay(200_000n, 1_000n, "a");
  pay(300_000n, 2_500n, "b");
  assert.equal(book.paidToday(), 3_500n);
  assert.equal((db.prepare("SELECT n FROM stats WHERE key = ?").get(dayKey(now)) as { n: number }).n, 3_500);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM orders").get() as { n: number }).n, 0, "paid orders are deleted");
  now += 24 * 3600_000;
  assert.equal(book.paidToday(), 0n, "a new UTC day starts at zero");
});

test("the database and its directory are private to the service", () => {
  const path = join(dir, "data", "worker.sqlite");
  const db = openDb(path);
  db.exec("INSERT INTO stats VALUES ('x', 1)");
  assert.equal(statSync(join(dir, "data")).mode & 0o777, 0o700);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  db.close();
});
