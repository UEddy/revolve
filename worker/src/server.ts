import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { BUCKETS, isOrderId, type OrderBook } from "./orders.ts";

export interface ServerDeps {
  book: OrderBook;
  appOrigin: string;
  depositUa: string;
  quoteTtlSecs: number;
  maxOpenOrders: number;
  /** Payout for a bucket, or null when no price is available. */
  quote: (bucketZat: bigint) => bigint | null;
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

async function postOrder(req: IncomingMessage, res: ServerResponse, deps: ServerDeps) {
  let body: { bucket_zec?: unknown };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return send(res, 400, { error: "invalid_json" });
  }
  const bucket = typeof body.bucket_zec === "string" ? body.bucket_zec : "";
  const bucketZat = BUCKETS[bucket];
  if (bucketZat === undefined) return send(res, 400, { error: "invalid_bucket" });
  if (deps.book.openCount() >= deps.maxOpenOrders) return send(res, 503, { error: "busy" });

  const payout = deps.quote(bucketZat);
  if (payout === null) return send(res, 503, { error: "no_price" });
  const free = deps.freeInventory();
  if (free === null || payout > free) return send(res, 409, { error: "bucket_unavailable" });

  const o = deps.book.create(bucket, payout, deps.quoteTtlSecs);
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
