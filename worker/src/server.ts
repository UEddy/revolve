import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { FUND_MAX_ZAT, isFundId } from "./funds.ts";
import { CREDIT_ZAT, TOKEN_MSG_BYTES, b64, type Mint } from "./mint.ts";
import {
  BUCKETS,
  MIN_ZAT,
  STEP_ZAT,
  isOrderId,
  isValidBurner,
  onGrid,
  zatToZec,
  zecToZat,
  type OrderBook,
} from "./orders.ts";

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
  /** The credits mint, or null when no mint key is configured (the /mint routes then answer 503). */
  mint: Mint | null;
}

const MAX_BODY = 1024;
// Token spends and sign requests carry one ~450 / ~350 byte entry per credit.
const MAX_TOKEN_BODY = 128 * 1024;

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
      if (req.method === "GET" && path === "/mint/key") return getMintKey(res, deps);
      if (req.method === "POST" && path === "/mint/orders") return await postFund(req, res, deps);
      const f = /^\/mint\/orders\/([^/]+)(\/sign)?$/.exec(path);
      if (f && isFundId(f[1])) {
        if (req.method === "GET" && !f[2]) {
          const fund = deps.book.funds.get(f[1]);
          return fund ? send(res, 200, fund) : send(res, 404, { error: "not_found" });
        }
        if (req.method === "POST" && f[2]) return await postSign(req, res, deps, f[1]);
      }
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
  const body = await readJson(req, MAX_TOKEN_BODY);
  if (body === null) return send(res, 400, { error: "invalid_json" });
  if (body.tokens !== undefined) return await postTokenOrder(res, deps, body);
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

/**
 * Spend form (CREDITS_CONTRACT.md v1.3). Every signature is verified before the
 * database is touched; the spent check, spend record and order creation then run
 * in one transaction, so any failure leaves every token unspent.
 */
async function postTokenOrder(res: ServerResponse, deps: ServerDeps, body: Record<string, unknown>) {
  if (deps.mint === null) return send(res, 503, { error: "mint_unavailable" });
  const amountZat = typeof body.amount_zec === "string" ? zecToZat(body.amount_zec) : null;
  if (amountZat === null || !onGrid(amountZat)) return send(res, 400, { error: "invalid_amount" });
  if (typeof body.burner !== "string" || !isValidBurner(body.burner)) return send(res, 400, { error: "invalid_burner" });

  const tokens = parseTokens(body.tokens, deps.mint.kLen);
  if (tokens === null || BigInt(tokens.length) * CREDIT_ZAT !== amountZat) return send(res, 400, { error: "invalid_tokens" });
  const hashes = tokens.map((t) => sha256(t.msg));
  if (new Set(hashes).size !== hashes.length) return send(res, 400, { error: "invalid_tokens" });
  for (const t of tokens) {
    if (!(await deps.mint.verify(t.msg, t.sig))) return send(res, 400, { error: "invalid_tokens" });
  }

  const r = deps.book.spendTokens({
    tokenHashes: hashes,
    spendKey: sha256(Buffer.from(`${[...hashes].sort().join(",")}|${amountZat}|${body.burner}`)),
    amountZat,
    burner: body.burner,
    maxOpen: deps.maxOpenOrders,
    quote: () => deps.quote(amountZat),
    fits: (lamports) => {
      const free = deps.freeInventory();
      return free !== null && lamports <= free;
    },
  });
  if (r.kind === "created" || r.kind === "retried") {
    return send(res, 201, { order_id: r.orderId, payout_lamports: r.payoutLamports.toString() });
  }
  // token_spent and amount_unavailable are 409; busy and no_price are 503. Nothing was spent.
  send(res, r.kind === "busy" || r.kind === "no_price" ? 503 : 409, { error: r.kind });
}

function parseTokens(raw: unknown, kLen: number): { msg: Buffer; sig: Buffer }[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: { msg: Buffer; sig: Buffer }[] = [];
  for (const t of raw) {
    if (typeof t !== "object" || t === null) return null;
    const msg = b64((t as { msg?: unknown }).msg);
    const sig = b64((t as { sig?: unknown }).sig);
    if (!msg || !sig || msg.length !== TOKEN_MSG_BYTES || sig.length !== kLen) return null;
    out.push({ msg, sig });
  }
  return out;
}

function getMintKey(res: ServerResponse, deps: ServerDeps) {
  if (deps.mint === null) return send(res, 503, { error: "mint_unavailable" });
  send(res, 200, {
    key_id: deps.mint.keyId,
    public_key_spki_b64: deps.mint.publicKeySpkiB64,
    denomination_zec: zatToZec(CREDIT_ZAT),
  });
}

async function postFund(req: IncomingMessage, res: ServerResponse, deps: ServerDeps) {
  if (deps.mint === null) return send(res, 503, { error: "mint_unavailable" });
  const body = await readJson(req, MAX_BODY);
  if (body === null) return send(res, 400, { error: "invalid_json" });
  const amountZat = typeof body.amount_zec === "string" ? zecToZat(body.amount_zec) : null;
  if (amountZat === null || !onGrid(amountZat) || amountZat > FUND_MAX_ZAT) {
    return send(res, 400, { error: "invalid_amount" });
  }
  if (deps.book.funds.openCount() >= deps.maxOpenOrders) return send(res, 503, { error: "busy" });
  const f = deps.book.funds.create(amountZat, deps.quoteTtlSecs);
  send(res, 201, {
    fund_id: f.fund_id,
    deposit_ua: deps.depositUa,
    amount_zec: zatToZec(amountZat),
    credits: f.credits,
    expires_at: f.expires_at,
  });
}

/**
 * Signs exactly `credits` blinded messages for a funded funding, then moves it to
 * `minted` with the SHA-256 of the canonical (sorted) blinded set. The status
 * change is a single conditional update after signing. A retry with the same set,
 * in any order, is signed again (RSA blind signing is deterministic, so the
 * signatures are identical) and answered 200; any other set gets 409. The blinded
 * messages themselves are never stored or logged.
 */
async function postSign(req: IncomingMessage, res: ServerResponse, deps: ServerDeps, fundId: string) {
  const mint = deps.mint;
  if (mint === null) return send(res, 503, { error: "mint_unavailable" });
  const state = deps.book.funds.signState(fundId);
  if (!state) return send(res, 404, { error: "not_found" });
  if (state.status !== "funded" && state.status !== "minted") return send(res, 409, { error: "not_funded" });

  const body = await readJson(req, MAX_TOKEN_BODY);
  if (body === null) return send(res, 400, { error: "invalid_json" });
  const raw = body.blinded;
  const decoded = Array.isArray(raw) && raw.length === state.credits ? raw.map(b64) : null;
  const blinded = decoded?.every((b) => b !== null) ? (decoded as Buffer[]) : null;
  const setHash = blinded && blindedSetHash(blinded);

  if (state.status === "minted") {
    if (setHash === null || setHash !== state.blindedHash) return send(res, 409, { error: "already_minted" });
    return send(res, 200, { signatures: blinded!.map((b) => mint.blindSign(b).toString("base64")) });
  }

  if (blinded === null || setHash === null) return send(res, 400, { error: "invalid_blinded" });
  let signatures: string[];
  try {
    signatures = blinded.map((b) => mint.blindSign(b).toString("base64"));
  } catch {
    return send(res, 400, { error: "invalid_blinded" });
  }
  if (!deps.book.funds.claimMinted(fundId, setHash)) {
    // A concurrent call minted first; the same set still gets its signatures.
    if (deps.book.funds.signState(fundId)?.blindedHash !== setHash) return send(res, 409, { error: "already_minted" });
  }
  send(res, 200, { signatures });
}

/** SHA-256 over the blinded messages sorted bytewise; all have the modulus length, so concatenation is unambiguous. */
function blindedSetHash(blinded: Buffer[]): string {
  return sha256(Buffer.concat([...blinded].sort(Buffer.compare)));
}

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** Parses a JSON object body, or null for anything else (bad JSON, too large, not an object). */
async function readJson(req: IncomingMessage, limit: number): Promise<Record<string, unknown> | null> {
  try {
    const v: unknown = JSON.parse(await readBody(req, limit));
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      data += chunk;
      if (data.length > limit) {
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
