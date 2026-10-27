import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { BUCKETS, MIN_ZAT, STEP_ZAT, isOrderId, onGrid, zatToZec, zecToZat, type OrderBook } from "./orders.ts";

export interface ServerDeps {
  book: OrderBook;
  appOrigin: string;
  depositUa: string;
  quoteTtlSecs: number;
  maxOpenOrders: number;
  /** Payout for an order amount, or null when no price is available. */
  quote: (amountZat: bigint) => bigint | null;
  /** Indicative USD per ZEC for display, or null when no price is available. */
  usdPerZec: () => string | null;
  /** Lamports free to promise to new orders, or null if unknown. */
  freeInventory: () => bigint | null;
}

const MAX_BODY = 1024;

// Deliberately no request logging: no IPs, user agents or timings are recorded.
export function createApi(deps: ServerDeps) {
  return createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", deps.appOrigin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");

    try {
      const path = new URL(req.url ?? "/", "http://x").pathname;
      if (req.method === "OPTIONS") {
        res.setHeader("Access-Control-Allow-Methods", "GET, POST");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
        res.setHeader("Access-Control-Max-Age", "600");
        return send(res, 204);
      }
      if (req.method === "GET" && path === "/limits") return getLimits(res, deps);
      if (req.method === "GET" && path === "/buckets") return getBuckets(res, deps);
      if (req.method === "POST" && path === "/orders") return await postOrder(req, res, deps);
      const m = /^\/orders\/([^/]+)$/.exec(path);
      if (req.method === "GET" && m) {
        const order = isOrderId(m[1]) ? deps.book.get(m[1]) : null;
        return order ? send(res, 200, order) : send(res, 404, { error: "not_found" });
      }
      send(res, 404, { error: "not_found" });
    } catch {
      send(res, 500, { error: "internal" });
    }
  });
}

/** An amount is available when there is a price and the hot wallet can cover its payout. */
function payoutIfAvailable(deps: ServerDeps, amountZat: bigint): bigint | null {
  const payout = deps.quote(amountZat);
  const free = deps.freeInventory();
  return payout !== null && free !== null && payout <= free ? payout : null;
}

/**
 * Largest grid amount whose payout (spread and swap fee allowance included) fits the
 * free inventory, which is already net of the reserve and open orders. Payouts grow
 * with the amount, so a doubling then binary search over whole steps finds it.
 */
function maxZat(deps: ServerDeps): bigint {
  const fits = (steps: bigint) => payoutIfAvailable(deps, steps * STEP_ZAT) !== null;
  if (!fits(1n)) return 0n;
  let lo = 1n;
  let hi = 2n;
  while (fits(hi) && hi < 1n << 40n) {
    lo = hi;
    hi *= 2n;
  }
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return lo * STEP_ZAT;
}

function getLimits(res: ServerResponse, deps: ServerDeps) {
  const usd = deps.usdPerZec();
  if (deps.freeInventory() === null || deps.quote(1n) === null || usd === null) {
    return send(res, 503, { error: "not_ready" });
  }
  send(res, 200, {
    min_zec: zatToZec(MIN_ZAT),
    max_zec: zatToZec(maxZat(deps)),
    step_zec: zatToZec(STEP_ZAT),
    indicative_usd_per_zec: usd,
  });
}

function getBuckets(res: ServerResponse, deps: ServerDeps) {
  // Until both a price and the hot wallet balance are known, say so rather than
  // reporting every bucket as unavailable.
  if (deps.freeInventory() === null || deps.quote(1n) === null) return send(res, 503, { error: "not_ready" });
  const buckets = Object.entries(BUCKETS).map(([bucket_zec, zat]) => ({
    bucket_zec,
    available: payoutIfAvailable(deps, zat) !== null,
  }));
  send(res, 200, { buckets });
}

async function postOrder(req: IncomingMessage, res: ServerResponse, deps: ServerDeps) {
  let body: { amount_zec?: unknown; bucket_zec?: unknown };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return send(res, 400, { error: "invalid_json" });
  }
  if (typeof body !== "object" || body === null) return send(res, 400, { error: "invalid_json" });
  // The legacy v1.1 form is treated as amount_zec, but keeps the error codes the
  // deployed v1.1 app knows until GET /buckets is removed.
  const legacy = body.amount_zec === undefined && body.bucket_zec !== undefined;
  const raw = legacy ? body.bucket_zec : body.amount_zec;
  const amountZat = typeof raw === "string" ? zecToZat(raw) : null;
  if (amountZat === null || !onGrid(amountZat)) {
    return send(res, 400, { error: legacy ? "invalid_bucket" : "invalid_amount" });
  }
  if (deps.book.openCount() >= deps.maxOpenOrders) return send(res, 503, { error: "busy" });

  if (deps.quote(amountZat) === null) return send(res, 503, { error: "no_price" });
  // Payouts grow with the amount, so this is exactly "above the current max_zec".
  const payout = payoutIfAvailable(deps, amountZat);
  if (payout === null) return send(res, 409, { error: legacy ? "bucket_unavailable" : "amount_unavailable" });

  const o = deps.book.create(amountZat, payout, deps.quoteTtlSecs);
  send(res, 201, {
    order_id: o.order_id,
    deposit_ua: deps.depositUa,
    amount_zec: o.amount_zec,
    payout_lamports: o.payout_lamports,
    quote_expires_at: o.quote_expires_at,
  });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      data += chunk;
      if (data.length > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body?: unknown) {
  if (body === undefined) {
    res.writeHead(status).end();
    return;
  }
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}
