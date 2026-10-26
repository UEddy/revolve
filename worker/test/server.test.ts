import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { openDb } from "../src/db.ts";
import { OrderBook } from "../src/orders.ts";
import { createApi } from "../src/server.ts";

async function withApi(free: bigint, fn: (base: string) => Promise<void>) {
  const server = createApi({
    book: new OrderBook(openDb(":memory:")),
    appOrigin: "https://app.test",
    depositUa: "u1test",
    quoteTtlSecs: 1800,
    maxOpenOrders: 10,
    quote: (zat) => zat * 100n, // 0.005 -> 50M, 0.01 -> 100M, 0.05 -> 500M lamports
    freeInventory: () => free,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
  }
}

test("GET /buckets reflects inventory", () =>
  withApi(200_000_000n, async (base) => {
    const res = await fetch(`${base}/buckets`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), "https://app.test");
    assert.deepEqual(await res.json(), {
      buckets: [
        { bucket_zec: "0.005", available: true },
        { bucket_zec: "0.01", available: true },
        { bucket_zec: "0.05", available: false },
      ],
    });
  }));

test("POST /orders: 201 for an available bucket, 409 otherwise", () =>
  withApi(200_000_000n, async (base) => {
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

    const full = await post("0.05");
    assert.equal(full.status, 409);
    assert.deepEqual(await full.json(), { error: "bucket_unavailable" });

    assert.equal((await post("0.02")).status, 400);
  }));
