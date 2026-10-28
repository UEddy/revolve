import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isChain, isValidRecipient, payoutField, type Chain } from "./chains.ts";
import { CASHIN_GRACE_SECS, FUND_MAX_ZAT, isFundId } from "./funds.ts";
import type { CashinRail } from "./cashin.ts";
import { MAX_PRICE_MOVE_BPS, exceedsBy } from "./pricing.ts";
import { WITHDRAW_FEE_ZAT, isWithdrawalId, looksLikeUa, type WithdrawBook, type ZecPayer } from "./withdrawals.ts";
import { CREDIT_ZAT, TOKEN_MSG_BYTES, b64, type Mint } from "./mint.ts";
import {
  BUCKETS,
  MAX_UNPAID_QUOTES,
  MIN_ZAT,
  STEP_ZAT,
  isOrderId,
  onGrid,
  zatToZec,
  zecToZat,
  type CancelResult,
  type OrderBook,
} from "./orders.ts";

export interface ServerDeps {
  book: OrderBook;
  appOrigin: string;
  depositUa: string;
  quoteTtlSecs: number;
  maxOpenOrders: number;
  /** Payout for an order amount on a chain (lamports or wei), or null when no price is available. */
  quote: (amountZat: bigint, chain: Chain) => bigint | null;
  /** Indicative USD per ZEC for display, or null when no price is available. */
  usdPerZec: () => string | null;
  /** The spread taken from every payout, in basis points, for the app's estimates (default 150). */
  spreadBps?: number;
  /** What one credit cost on a chain at a moment (unix seconds), from the rates seen then; null if unknown. */
  cashinPriceAt?: (chain: Chain, atSecs: number) => bigint | null;
  /** How far the market may move against Revolve before a quote stops binding (default MAX_PRICE_MOVE_BPS). */
  maxPriceMoveBps?: number;
  /** A wallet may send back at most this many times what Revolve paid into it (default 2). */
  cashinMaxMultiple?: number;
  /** Payout units free to promise to new orders on a chain, or null if unknown. */
  freeInventory: (chain: Chain) => bigint | null;
  /** Chains with a configured hot wallet (default: Solana only). Others answer chain_unavailable. */
  chains?: Chain[];
  /** The credits mint, or null when no mint key is configured (the /mint routes then answer 503). */
  mint: Mint | null;
  /** Cash-in rails per chain (v1.5); a chain without one can't cash in. */
  cashin?: Partial<Record<Chain, CashinRail>>;
  /** Withdrawals to shielded ZEC (v1.5); absent without a ZEC hot wallet. */
  withdraw?: { book: WithdrawBook; payer: ZecPayer };
  /** Global request budgets (tests pass their own). */
  limits?: { write: Bucket; read: Bucket };
}

/**
 * Token bucket shared by every client: the worker keeps no state about who is
 * asking, so the limits are global. Over budget a route answers 503 busy,
 * which the app already backs off from.
 */
export class Bucket {
  private tokens: number;
  private last = Date.now();
  private readonly perSecond: number;
  private readonly burst: number;
  constructor(perSecond: number, burst: number) {
    this.perSecond = perSecond;
    this.burst = burst;
    this.tokens = burst;
  }
  take(): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.perSecond);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

const MAX_BODY = 1024;
// Token spends and sign requests carry one ~450 / ~350 byte entry per credit.
const MAX_TOKEN_BODY = 128 * 1024;

// Deliberately no request logging: no IPs, user agents or timings are recorded.
export function createApi(deps: ServerDeps) {
  // Creating orders and fundings, signing and spending: a few per second is far
  // above real use. Reads include each open order's status polling.
  const limits = deps.limits ?? { write: new Bucket(3, 12), read: new Bucket(30, 60) };
  const server = createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", deps.appOrigin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    // JSON only: never sniffed as anything else, never rendered as a page.
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");

    try {
      const path = new URL(req.url ?? "/", "http://x").pathname;
      if (req.method === "OPTIONS") {
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
        res.setHeader("Access-Control-Max-Age", "600");
        return send(res, 204);
      }
      if (!(req.method === "POST" || req.method === "DELETE" ? limits.write : limits.read).take()) {
        res.setHeader("Retry-After", "1");
        return send(res, 503, { error: "busy" });
      }
      if (req.method === "GET" && path === "/limits") return getLimits(res, deps);
      if (req.method === "GET" && path === "/buckets") return getBuckets(res, deps);
      if (req.method === "POST" && path === "/orders") return await postOrder(req, res, deps);
      if (req.method === "GET" && path === "/mint/key") return getMintKey(res, deps);
      if (req.method === "POST" && path === "/cashins") return await postCashin(req, res, deps);
      const ci = /^\/cashins\/([^/]+)\/sent$/.exec(path);
      if (req.method === "POST" && ci) return isFundId(ci[1]!) ? await postCashinSent(req, res, deps, ci[1]!) : send(res, 404, { error: "not_found" });
      if (req.method === "POST" && path === "/withdrawals") return await postWithdrawal(req, res, deps);
      const wd = /^\/withdrawals\/([^/]+)$/.exec(path);
      if (req.method === "GET" && wd) {
        const w = isWithdrawalId(wd[1]!) ? deps.withdraw?.book.get(wd[1]!) : null;
        return w ? send(res, 200, w) : send(res, 404, { error: "not_found" });
      }
      if (req.method === "POST" && path === "/mint/orders") return await postFund(req, res, deps);
      const f = /^\/mint\/orders\/([^/]+)(\/sign)?$/.exec(path);
      if (f && isFundId(f[1])) {
        if (req.method === "GET" && !f[2]) {
          const fund = deps.book.funds.get(f[1]);
          return fund ? send(res, 200, fund) : send(res, 404, { error: "not_found" });
        }
        if (req.method === "DELETE" && !f[2]) return sendCancel(res, deps.book.funds.cancel(f[1]));
        if (req.method === "POST" && f[2]) return await postSign(req, res, deps, f[1]);
      }
      const m = /^\/orders\/([^/]+)$/.exec(path);
      if (req.method === "GET" && m) {
        const order = isOrderId(m[1]) ? deps.book.get(m[1]) : null;
        return order ? send(res, 200, order) : send(res, 404, { error: "not_found" });
      }
      if (req.method === "DELETE" && m) {
        return isOrderId(m[1]) ? sendCancel(res, deps.book.cancel(m[1])) : send(res, 404, { error: "not_found" });
      }
      send(res, 404, { error: "not_found" });
    } catch {
      send(res, 500, { error: "internal" });
    }
  });
  // Slow clients can't hold connections open: every body here is small.
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 50;
  return server;
}

/** 204 once cancelled, 409 once a payment has been seen, else 404. */
function sendCancel(res: ServerResponse, r: CancelResult) {
  if (r === "cancelled") return send(res, 204);
  send(res, r === "payment_seen" ? 409 : 404, { error: r });
}

/** A chain is offered when it has a hot wallet, a price and a known balance. */
function chainReady(deps: ServerDeps, chain: Chain): boolean {
  return (deps.chains ?? ["solana"]).includes(chain) && deps.freeInventory(chain) !== null && deps.quote(1n, chain) !== null;
}

/** The request's chain: absent means Solana; anything unknown is null. */
function chainOf(body: Record<string, unknown>): Chain | null {
  if (body.chain === undefined) return "solana";
  return isChain(body.chain) ? body.chain : null;
}

/** An amount is available when there is a price and the hot wallet can cover its payout. */
function payoutIfAvailable(deps: ServerDeps, amountZat: bigint, chain: Chain = "solana"): bigint | null {
  const payout = deps.quote(amountZat, chain);
  const free = deps.freeInventory(chain);
  return payout !== null && free !== null && payout <= free ? payout : null;
}

/**
 * Largest grid amount whose payout (after the spread) fits the
 * free inventory, which is already net of the reserve and open orders. Payouts grow
 * with the amount, so a doubling then binary search over whole steps finds it.
 */
function maxZat(deps: ServerDeps, chain: Chain = "solana"): bigint {
  const fits = (steps: bigint) => payoutIfAvailable(deps, steps * STEP_ZAT, chain) !== null;
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
  if (!chainReady(deps, "solana") || usd === null) return send(res, 503, { error: "not_ready" });
  const range = (chain: Chain) => ({ min_zec: zatToZec(MIN_ZAT), max_zec: zatToZec(maxZat(deps, chain)), step_zec: zatToZec(STEP_ZAT) });
  const chains: Record<string, unknown> = {};
  for (const c of deps.chains ?? ["solana"]) if (chainReady(deps, c)) chains[c] = range(c);
  const cashin: Record<string, unknown> = {};
  if (deps.mint) {
    for (const [c, rail] of Object.entries(deps.cashin ?? {})) {
      const per = rail?.perCredit();
      if (per != null) cashin[c] = { per_credit: per.toString() };
    }
  }
  send(res, 200, {
    ...range("solana"),
    indicative_usd_per_zec: usd,
    spread_bps: deps.spreadBps ?? 150,
    chains,
    ...(Object.keys(cashin).length ? { cashin } : {}),
  });
}

function getBuckets(res: ServerResponse, deps: ServerDeps) {
  // Until both a price and the hot wallet balance are known, say so rather than
  // reporting every bucket as unavailable.
  if (!chainReady(deps, "solana")) return send(res, 503, { error: "not_ready" });
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
  const chain = legacy ? "solana" : chainOf(body);
  if (chain === null) return send(res, 400, { error: "invalid_chain" });
  if (chain !== "solana" && !chainReady(deps, chain)) return send(res, 503, { error: "chain_unavailable" });
  if (deps.book.openCount() >= deps.maxOpenOrders || deps.book.unpaidCount() >= MAX_UNPAID_QUOTES) return send(res, 503, { error: "busy" });

  if (deps.quote(amountZat, chain) === null) return send(res, 503, { error: "no_price" });
  // Payouts grow with the amount, so this is exactly "above the current max_zec".
  const payout = payoutIfAvailable(deps, amountZat, chain);
  if (payout === null) return send(res, 409, { error: legacy ? "bucket_unavailable" : "amount_unavailable" });

  const o = deps.book.create(amountZat, payout, deps.quoteTtlSecs, chain);
  send(res, 201, {
    order_id: o.order_id,
    deposit_ua: deps.depositUa,
    amount_zec: o.amount_zec,
    chain,
    [payoutField(chain)]: o.payout_lamports,
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
  const chain = chainOf(body);
  if (chain === null) return send(res, 400, { error: "invalid_chain" });
  if (typeof body.burner !== "string" || !isValidRecipient(chain, body.burner)) return send(res, 400, { error: "invalid_burner" });
  if (chain !== "solana" && !chainReady(deps, chain)) return send(res, 503, { error: "chain_unavailable" });

  const tokens = parseTokens(body.tokens, deps.mint.kLen);
  if (tokens === null || BigInt(tokens.length) * CREDIT_ZAT !== amountZat) return send(res, 400, { error: "invalid_tokens" });
  const hashes = tokens.map((t) => sha256(t.msg));
  if (new Set(hashes).size !== hashes.length) return send(res, 400, { error: "invalid_tokens" });
  for (const t of tokens) {
    if (!(await deps.mint.verify(t.msg, t.sig))) return send(res, 400, { error: "invalid_tokens" });
  }

  const r = deps.book.spendTokens({
    tokenHashes: hashes,
    // Solana keeps its v1.3 key, so a retry from before v1.4 still finds its order.
    spendKey: sha256(Buffer.from(`${[...hashes].sort().join(",")}|${amountZat}|${body.burner}${chain === "solana" ? "" : `|${chain}`}`)),
    amountZat,
    burner: body.burner,
    chain,
    maxOpen: deps.maxOpenOrders,
    quote: () => deps.quote(amountZat, chain),
    fits: (lamports) => {
      const free = deps.freeInventory(chain);
      return free !== null && lamports <= free;
    },
  });
  if (r.kind === "created" || r.kind === "retried") {
    return send(res, 201, { order_id: r.orderId, chain, [payoutField(chain)]: r.payoutLamports.toString() });
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

/** Paid fundings still confirming hit MAX_OPEN_ORDERS; unpaid quotes only the table bound. */
const fundsBusy = (deps: ServerDeps) => deps.book.funds.openCount() >= deps.maxOpenOrders || deps.book.funds.unpaidCount() >= MAX_UNPAID_QUOTES;

/** A cash-in quote (v1.5): a funding of `credits`, paid by a transfer on `chain`. */
async function postCashin(req: IncomingMessage, res: ServerResponse, deps: ServerDeps) {
  const body = await readJson(req, MAX_BODY);
  if (body === null) return send(res, 400, { error: "invalid_json" });
  const chain = chainOf(body);
  if (chain === null) return send(res, 400, { error: "invalid_chain" });
  const credits = body.credits;
  if (typeof credits !== "number" || !Number.isInteger(credits) || credits < 1 || BigInt(credits) * CREDIT_ZAT > FUND_MAX_ZAT) {
    return send(res, 400, { error: "invalid_amount" });
  }
  const rail = deps.cashin?.[chain];
  const per = rail?.perCredit() ?? null;
  if (!deps.mint || !rail || per === null) return send(res, 503, { error: "cashin_unavailable" });
  if (fundsBusy(deps)) return send(res, 503, { error: "busy" });
  const pay = per * BigInt(credits);
  const f = deps.book.funds.createCashin(chain, credits, pay, deps.quoteTtlSecs);
  send(res, 201, {
    fund_id: f.fund_id,
    chain,
    credits,
    pay_to: rail.payTo,
    [chain === "solana" ? "pay_lamports" : "pay_wei"]: pay.toString(),
    expires_at: f.expires_at,
  });
}

/** The app's report of its cash-in transfer, checked on chain before anything is minted. */
async function postCashinSent(req: IncomingMessage, res: ServerResponse, deps: ServerDeps, fundId: string) {
  const body = await readJson(req, MAX_BODY);
  if (body === null) return send(res, 400, { error: "invalid_json" });
  const q = deps.book.funds.cashinQuote(fundId);
  if (!q) return send(res, 404, { error: "not_found" });
  // A lost answer: the same report again finds it already funded.
  if (q.status === "funded" || q.status === "minted") return send(res, 200, { status: q.status });
  if (q.status !== "awaiting_payment") return send(res, 409, { error: "not_awaiting" });
  const rail = deps.cashin?.[q.source as Chain];
  if (!rail) return send(res, 503, { error: "cashin_unavailable" });
  const tx = typeof body.tx === "string" ? rail.normalizeTx(body.tx) : null;
  if (tx === null) return send(res, 400, { error: "bad_tx" });
  const quotedAt = q.expiresAt - deps.quoteTtlSecs;
  // The fund id in the transfer is what binds it to this quote; a minute of slack allows for block-time skew.
  const verdict = await rail.verify(tx, q.payAmount, quotedAt - 60, q.expiresAt + CASHIN_GRACE_SECS, fundId);
  if (verdict === "pending") return send(res, 202, { status: "pending" });
  if (verdict === "bad") return send(res, 400, { error: "bad_tx" });
  const txKey = sha256(Buffer.from(`${q.source}|${tx}`));
  // Priced as of when the transfer landed: if the coin had fallen against ZEC by more
  // than the allowed move since the quote, the quote was stale, so it is held, not minted.
  const credits = q.amountZat / CREDIT_ZAT;
  const perCreditThen = deps.cashinPriceAt?.(q.source as Chain, verdict.at) ?? null;
  if (perCreditThen !== null && exceedsBy(perCreditThen * credits, q.payAmount, deps.maxPriceMoveBps ?? MAX_PRICE_MOVE_BPS)) {
    const held = deps.book.funds.holdCashin(fundId, txKey, "price_moved");
    return send(res, 409, { error: held === "held" ? "price_moved" : held });
  }
  // Only a wallet Revolve paid into may cash in, and only up to a multiple of what it was paid:
  // otherwise outside money could be turned into credits and withdrawn as private ZEC.
  const chain = q.source as Chain;
  if (!deps.book.funds.fundedWallet(chain, verdict.from) && rail.firstFunding) {
    const first = await rail.firstFunding(verdict.from).catch(() => null);
    if (first !== null) deps.book.funds.addFunding(chain, verdict.from, first);
  }
  const from = { chain, address: verdict.from, amount: verdict.amount, maxMultiple: deps.cashinMaxMultiple ?? 2 };
  const r = deps.book.funds.fundCashin(fundId, txKey, from);
  if (r === "outside_funds") {
    const held = deps.book.funds.holdCashin(fundId, txKey, "outside_funds");
    return send(res, 409, { error: held === "held" ? "outside_funds" : held });
  }
  if (r === "funded") return send(res, 200, { status: "funded" });
  send(res, 409, { error: r });
}

/** Withdrawal margin for network fees: a few ZIP-317 actions each, kept free in the hot wallet. */
const WITHDRAW_FEE_MARGIN_ZAT = 50_000n;

/** Credits to shielded ZEC (v1.5): spent and queued in one transaction, paid later after a random delay. */
async function postWithdrawal(req: IncomingMessage, res: ServerResponse, deps: ServerDeps) {
  const w = deps.withdraw;
  if (!deps.mint || !w) return send(res, 503, { error: "withdraw_unavailable" });
  const body = await readJson(req, MAX_TOKEN_BODY);
  if (body === null) return send(res, 400, { error: "invalid_json" });
  const address = body.address;
  if (typeof address !== "string" || !looksLikeUa(address) || !w.payer.checkAddress(address)) return send(res, 400, { error: "invalid_address" });
  const tokens = parseTokens(body.tokens, deps.mint.kLen);
  if (tokens === null) return send(res, 400, { error: "invalid_tokens" });
  const hashes = tokens.map((t) => sha256(t.msg));
  if (new Set(hashes).size !== hashes.length) return send(res, 400, { error: "invalid_tokens" });
  for (const t of tokens) {
    if (!(await deps.mint.verify(t.msg, t.sig))) return send(res, 400, { error: "invalid_tokens" });
  }
  // The network fee comes out of the amount, like any wallet's: a withdrawal never costs Revolve.
  const amountZat = BigInt(tokens.length) * CREDIT_ZAT - WITHDRAW_FEE_ZAT;
  const r = w.book.create({
    tokenHashes: hashes,
    spendKey: sha256(Buffer.from(`${[...hashes].sort().join(",")}|withdraw|${address}`)),
    amountZat,
    address,
    fits: (zat) => {
      const spendable = w.payer.cachedSpendable();
      return spendable !== null && w.book.committed() + zat + WITHDRAW_FEE_MARGIN_ZAT <= spendable;
    },
  });
  if (r.kind === "created" || r.kind === "retried") {
    return send(res, 201, { withdrawal_id: r.id, amount_zec: zatToZec(r.amountZat), status: "queued" });
  }
  send(res, r.kind === "token_spent" ? 409 : 503, { error: r.kind });
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
  if (fundsBusy(deps)) return send(res, 503, { error: "busy" });
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
