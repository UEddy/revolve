import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { openDb } from "../src/db.ts";
import { OrderBook } from "../src/orders.ts";
import { Bucket, createApi } from "../src/server.ts";

async function withApi(
  free: bigint | null,
  fn: (base: string) => Promise<void>,
  over: { quote?: (zat: bigint) => bigint | null; usd?: string | null } = {},
) {
  const server = createApi({
    book: new OrderBook(openDb(":memory:")),
    appOrigin: "https://app.test",
    depositUa: "u1test",
    quoteTtlSecs: 1800,
    maxOpenOrders: 10,
    quote: over.quote ?? ((zat) => zat * 100n), // 0.002 -> 20M, 0.005 -> 50M, 0.01 -> 100M lamports
    usdPerZec: () => (over.usd === undefined ? "1224.50" : over.usd),
    freeInventory: () => free,
    mint: null,
    limits: { write: new Bucket(1e9, 1e9), read: new Bucket(1e9, 1e9) },
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
  }
}

test("GET /buckets reflects inventory", () =>
  withApi(60_000_000n, async (base) => {
    const res = await fetch(`${base}/buckets`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), "https://app.test");
    assert.deepEqual(await res.json(), {
      buckets: [
        { bucket_zec: "0.002", available: true },
        { bucket_zec: "0.005", available: true },
        { bucket_zec: "0.01", available: false },
      ],
    });
  }));

test("POST /orders: 201 for an available bucket, 409 otherwise", () =>
  withApi(60_000_000n, async (base) => {
    const post = (bucket_zec: string) =>
      fetch(`${base}/orders`, { method: "POST", body: JSON.stringify({ bucket_zec }) });

    const ok = await post("0.005");
    assert.equal(ok.status, 201);
    const body = (await ok.json()) as Record<string, string>;
    assert.equal(body.deposit_ua, "u1test");
    assert.equal(body.amount_zec, "0.005");
    assert.equal(body.payout_lamports, "50000000");

    const status = await fetch(`${base}/orders/${body.order_id}`);
    assert.deepEqual(await status.json(), { status: "awaiting_payment", confirmations: 0, payout_signature: null });

    const full = await post("0.01");
    assert.equal(full.status, 409);
    assert.deepEqual(await full.json(), { error: "bucket_unavailable" });

    // The legacy form takes any grid amount, with the v1.1 error codes.
    const legacyOver = await post("0.05");
    assert.equal(legacyOver.status, 409);
    assert.deepEqual(await legacyOver.json(), { error: "bucket_unavailable" });
    const offGrid = await post("0.0025");
    assert.equal(offGrid.status, 400);
    assert.deepEqual(await offGrid.json(), { error: "invalid_bucket" });
  }));

test("GET /buckets is 503 until price and balance are loaded", () =>
  withApi(null, async (base) => {
    const res = await fetch(`${base}/buckets`);
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: "not_ready" });
  }));

const post = (base: string, body: unknown) => fetch(`${base}/orders`, { method: "POST", body: JSON.stringify(body) });

test("GET /limits: grid, max rounded down to the step after the fee allowance", () =>
  // 0.005 pays 50M + 5M = 55M and fits 57M; 0.006 pays 65M and does not.
  withApi(
    57_000_000n,
    async (base) => {
      const res = await fetch(`${base}/limits`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("access-control-allow-origin"), "https://app.test");
      assert.deepEqual(await res.json(), {
        min_zec: "0.002",
        max_zec: "0.005",
        step_zec: "0.001",
        indicative_usd_per_zec: "1224.50",
      });
    },
    { quote: (zat) => zat * 100n + 5_000_000n },
  ));

test("GET /limits: max below min when inventory is short, large max when plentiful", async () => {
  await withApi(10_000_000n, async (base) => {
    assert.deepEqual(await (await fetch(`${base}/limits`)).json(), {
      min_zec: "0.002",
      max_zec: "0.001",
      step_zec: "0.001",
      indicative_usd_per_zec: "1224.50",
    });
  });
  await withApi(5_000_000n, async (base) => {
    assert.equal(((await (await fetch(`${base}/limits`)).json()) as { max_zec: string }).max_zec, "0");
  }, { quote: (zat) => zat * 100n + 5_000_001n });
  // 1 SOL at 100 lamports per zat covers 10,000,000 zat: 0.1 ZEC.
  await withApi(1_000_000_000n, async (base) => {
    assert.equal(((await (await fetch(`${base}/limits`)).json()) as { max_zec: string }).max_zec, "0.1");
  });
});

test("GET /limits is 503 until price, balance and USD price are loaded", async () => {
  for (const [free, over] of [
    [null, {}],
    [100_000_000n, { quote: () => null }],
    [100_000_000n, { usd: null }],
  ] as const) {
    await withApi(free, async (base) => {
      const res = await fetch(`${base}/limits`);
      assert.equal(res.status, 503);
      assert.deepEqual(await res.json(), { error: "not_ready" });
    }, over);
  }
});

test("POST /orders with amount_zec: quote per amount, 400 off grid, 409 above max", () =>
  withApi(45_000_000n, async (base) => {
    const ok = await post(base, { amount_zec: "0.004" });
    assert.equal(ok.status, 201);
    const body = (await ok.json()) as Record<string, string>;
    assert.equal(body.amount_zec, "0.004");
    assert.equal(body.payout_lamports, "40000000");

    for (const bad of ["0.0045", "0.001", "abc", "", "-0.004", "1e-3", 0.004, null]) {
      const r = await post(base, { amount_zec: bad });
      assert.equal(r.status, 400, String(bad));
      assert.deepEqual(await r.json(), { error: "invalid_amount" });
    }

    // max_zec is 0.004 here (45M free): 0.005 needs 50M.
    const over = await post(base, { amount_zec: "0.005" });
    assert.equal(over.status, 409);
    assert.deepEqual(await over.json(), { error: "amount_unavailable" });
  }));

test("POST /orders: amount_zec wins over bucket_zec; legacy form takes any grid amount", () =>
  withApi(60_000_000n, async (base) => {
    const both = await post(base, { amount_zec: "0.003", bucket_zec: "0.005" });
    assert.equal(((await both.json()) as { amount_zec: string }).amount_zec, "0.003");
    const legacy = await post(base, { bucket_zec: "0.002" });
    assert.equal(legacy.status, 201);
    assert.equal(((await legacy.json()) as { amount_zec: string }).amount_zec, "0.002");
    assert.equal((await post(base, "0.004")).status, 400);
    assert.equal((await post(base, null)).status, 400);
  }));
