// Order API client (API_CONTRACT.md v1). The server only ever learns a
// bucket; what the user buys and where it lands stay on the device.

import { ORDER_API } from "./config.ts";
import type { Bucket } from "./config.ts";
import type { OrderStatus } from "./model.ts";
import { random } from "./bytes.ts";
import { base32nopad } from "@scure/base";

export type Quote = {
  order_id: string;
  deposit_ua: string;
  amount_zec: string;
  payout_lamports: string;
  quote_expires_at: string;
};

export type OrderState = { status: OrderStatus; confirmations?: number; payout_signature: string | null };

export class OrderApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const ORDER_ID = /^[A-Za-z0-9_]{8,64}$/;

const ERRORS: Record<string, string> = {
  bucket_unavailable: "That amount is sold out right now. Try a smaller one.",
  busy: "Lots of orders open right now. Try again in a minute.",
  no_price: "Prices are updating. Try again in a moment.",
  invalid_bucket: "That amount is not offered.",
  not_found: "Order not found",
};

function checkQuote(q: Quote, bucket: Bucket): Quote {
  if (!ORDER_ID.test(q.order_id)) throw new OrderApiError("server sent a malformed order id", 502);
  if (q.amount_zec !== bucket) throw new OrderApiError("server quoted a different amount than asked", 502);
  if (!/^\d+$/.test(q.payout_lamports) || BigInt(q.payout_lamports) <= 0n) throw new OrderApiError("server sent a bad payout", 502);
  if (!/^u1[02-9ac-hj-np-z]{20,}$/.test(q.deposit_ua)) throw new OrderApiError("server sent a bad deposit address", 502);
  return q;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  if (!ORDER_API || ORDER_API === "mock") throw new OrderApiError("order service not configured", 0);
  const res = await fetch(`${ORDER_API}${path}`, {
    ...init,
    credentials: "omit",
    referrerPolicy: "no-referrer",
    cache: "no-store",
    headers: init?.body ? { "content-type": "application/json" } : undefined,
  });
  if (!res.ok) {
    let msg = `Order service unavailable (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) msg = ERRORS[body.error] ?? msg;
    } catch {}
    throw new OrderApiError(msg, res.status);
  }
  return (await res.json()) as T;
}

export async function createOrder(bucket: Bucket): Promise<Quote> {
  if (import.meta.env.DEV && ORDER_API === "mock") return checkQuote(mock.create(bucket), bucket);
  return checkQuote(await call<Quote>("/orders", { method: "POST", body: JSON.stringify({ bucket_zec: bucket }) }), bucket);
}

/** Which amounts the payout inventory can cover right now. Missing buckets count as unavailable. */
export async function getBuckets(): Promise<Record<string, boolean>> {
  if (import.meta.env.DEV && ORDER_API === "mock") return { "0.005": true, "0.01": true, "0.05": true };
  const r = await call<{ buckets: { bucket_zec: string; available: boolean }[] }>("/buckets");
  return Object.fromEntries(r.buckets.map((b) => [b.bucket_zec, b.available === true]));
}

/** `null` once the server has forgotten the order (404 after payout). */
export async function getOrder(orderId: string): Promise<OrderState | null> {
  if (import.meta.env.DEV && ORDER_API === "mock") return mock.get(orderId);
  try {
    return await call<OrderState>(`/orders/${encodeURIComponent(orderId)}`);
  } catch (e) {
    if (e instanceof OrderApiError && e.status === 404) return null;
    throw e;
  }
}

// ---- demo mode: a timeline that walks every status, never touches money ----

const MOCK_UA = "u1" + "mockdepositaddressqpzry9x8gf2tvdw0s3jn54khce6mua7l".replace(/[^02-9ac-hj-np-z]/g, "q").repeat(2);
const MOCK_KEY = "revolve.mock.orders";

const mock = {
  load(): Record<string, { created: number; bucket: string }> {
    try {
      return JSON.parse(sessionStorage.getItem(MOCK_KEY) ?? "{}");
    } catch {
      return {};
    }
  },
  create(bucket: Bucket): Quote {
    const id = "rv_" + base32nopad.encode(random(5)).toLowerCase();
    const all = mock.load();
    all[id] = { created: Date.now(), bucket };
    sessionStorage.setItem(MOCK_KEY, JSON.stringify(all));
    const lamports = BigInt(Math.round(Number(bucket) * 12.2 * 1e9));
    return {
      order_id: id,
      deposit_ua: MOCK_UA,
      amount_zec: bucket,
      payout_lamports: lamports.toString(),
      quote_expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
    };
  },
  get(id: string): OrderState | null {
    const o = mock.load()[id];
    if (!o) return null;
    const s = (Date.now() - o.created) / 1000;
    if (s < 25) return { status: "awaiting_payment", confirmations: 0, payout_signature: null };
    if (s < 55) return { status: "seen", confirmations: Math.min(2, Math.floor((s - 25) / 10)), payout_signature: null };
    if (s < 75) return { status: "confirmed", confirmations: 3, payout_signature: null };
    return { status: "paid_out", payout_signature: "MockPayoutSignature" };
  },
};
