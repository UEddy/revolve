// The privacy relay. The phone talks to this service; the Solana RPC,
// Jupiter and token icon hosts see the relay's address instead of the
// user's, so they cannot tie burners together by IP.
//
// Rules: nothing is logged, no client header is forwarded (no IP, user
// agent, cookies or referrer), only allowlisted calls pass, and one
// JSON-RPC call per request (a batch would hand the RPC several burners at
// once). Rate limits are global, never per client: the relay keeps no
// state about who is asking.

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { nftList, projectNft, projectOpenSea, projectPolymarket, type NftCollection, type NftEntry } from "./feeds.ts";

export type RelayEnv = {
  APP_ORIGIN?: string;
  SOLANA_RPC_URL?: string;
  JUP_API_BASE?: string;
  JUP_API_KEY?: string;
  /** Magic Eden collections for the NFT feed as `symbol:Name,symbol:Name` (defaults below). */
  NFT_COLLECTIONS?: string;
  /** OpenSea API key for the Ethereum and Robinhood Chain NFT feeds; without it those feeds answer 503. */
  OPENSEA_API_KEY?: string;
  /** Base JSON-RPC for Base positions (API_CONTRACT.md v1.4). */
  BASE_RPC_URL?: string;
  /** KyberSwap aggregator base URL (tests point it elsewhere). */
  KYBER_API_BASE?: string;
};

// Read-only Discover feeds: one fixed upstream each, never shaped by the client.
const POLYMARKET_EVENTS = "https://gamma-api.polymarket.com/events?active=true&closed=false&order=volume24hr&ascending=false&limit=30";
const MAGIC_EDEN = "https://api-mainnet.magiceden.dev/v2/collections";
/** Well-known collections. Magic Eden's ranked "popular" endpoint returns nothing, and its plain list is newest-first and unvetted. */
export const DEFAULT_NFTS: readonly NftEntry[] = [
  { symbol: "mad_lads", name: "Mad Lads" },
  { symbol: "okay_bears", name: "Okay Bears" },
  { symbol: "claynosaurz", name: "Claynosaurz" },
  { symbol: "famous_fox_federation", name: "Famous Fox Federation" },
  { symbol: "degods", name: "DeGods" },
  { symbol: "solana_monkey_business", name: "Solana Monkey Business" },
  { symbol: "smb_gen3", name: "SMB Gen3" },
  { symbol: "tensorians", name: "Tensorians" },
];
const OPENSEA = "https://api.opensea.io/api/v2/collections";
/** Well-known collections by OpenSea slug, fixed here: the client never names what the relay fetches. */
export const OPENSEA_NFTS: Record<"ethereum" | "robinhood", readonly NftEntry[]> = {
  ethereum: [
    { symbol: "cryptopunks", name: "CryptoPunks" },
    { symbol: "boredapeyachtclub", name: "Bored Ape Yacht Club" },
    { symbol: "pudgypenguins", name: "Pudgy Penguins" },
    { symbol: "mutant-ape-yacht-club", name: "Mutant Ape Yacht Club" },
    { symbol: "azuki", name: "Azuki" },
    { symbol: "milady", name: "Milady Maker" },
    { symbol: "doodles-official", name: "Doodles" },
    { symbol: "lilpudgys", name: "Lil Pudgys" },
  ],
  // The most traded Robinhood Chain collections with live listings (October 2026).
  robinhood: [
    { symbol: "stonkbrokers-434284142", name: "StonkBrokers" },
    { symbol: "chain-mancers", name: "Chain Mancers" },
    { symbol: "hash-cats", name: "Hashcats" },
    { symbol: "rhmachines", name: "RH Machines" },
    { symbol: "cashcatss", name: "Cash Cats" },
    { symbol: "rare-friends-genesis", name: "Rare Friends Genesis" },
    { symbol: "robinhood-punks", name: "Robinhood Punks" },
    { symbol: "robinhood-kitties", name: "Robinhood Kitties" },
  ],
};
export type FeedName = "markets" | "nfts" | "nfts/ethereum" | "nfts/robinhood";
const FEED_TTL = { markets: 60_000, nfts: 300_000 };
const NFT_META_TTL = 24 * 3600_000;
const NFT_META_RETRY = 3600_000;

const DEFAULT_RPC = "https://api.mainnet-beta.solana.com";
const DEFAULT_JUP = "https://lite-api.jup.ag";
const MAX_BODY = 64 * 1024;
const MAX_IMAGE = 1024 * 1024;

const DEFAULT_BASE_RPC = "https://mainnet.base.org";
const DEFAULT_KYBER = "https://aggregator-api.kyberswap.com";

/** What a Base wallet on the phone needs: balances, fees, nonces, sending and receipts. No logs, filters or traces. */
const BASE_RPC_METHODS = new Set([
  "eth_chainId",
  "eth_blockNumber",
  "eth_getBalance",
  "eth_call",
  "eth_getTransactionCount",
  "eth_estimateGas",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_feeHistory",
  "eth_getBlockByNumber",
  "eth_sendRawTransaction",
  "eth_getTransactionReceipt",
]);

const RPC_METHODS = new Set([
  "getBalance",
  "getTokenAccountsByOwner",
  "getSignatureStatuses",
  "getLatestBlockhash",
  "sendTransaction",
  "getAccountInfo",
]);

const JUP_PATHS: { re: RegExp; method: "GET" | "POST"; cacheSeconds: number }[] = [
  { re: /^tokens\/v2\/search$/, method: "GET", cacheSeconds: 30 },
  { re: /^tokens\/v2\/(toptrending|toptraded|toporganicscore)\/(5m|1h|6h|24h)$/, method: "GET", cacheSeconds: 60 },
  { re: /^tokens\/v2\/recent$/, method: "GET", cacheSeconds: 20 },
  { re: /^price\/v3$/, method: "GET", cacheSeconds: 15 },
  { re: /^ultra\/v1\/order$/, method: "GET", cacheSeconds: 0 },
  { re: /^ultra\/v1\/execute$/, method: "POST", cacheSeconds: 0 },
];

// "image/jpg" is a common non-standard spelling of image/jpeg (some S3 uploads use it).
const IMAGE_TYPES = /^image\/(png|jpeg|jpg|gif|webp|avif|svg\+xml)$/;

// ---------- shared, user-free state: a response cache and global rate limits ----------

type Cached = { until: number; status: number; type: string; body: Uint8Array<ArrayBuffer> };

/** Size-bounded cache of public responses (token lists, prices, icons). Keys are upstream URLs, never anything about a client. */
export class ResponseCache {
  private map = new Map<string, Cached>();
  private bytes = 0;
  private readonly maxBytes: number;
  constructor(maxBytes: number) {
    this.maxBytes = maxBytes;
  }
  get(key: string): Cached | null {
    const hit = this.map.get(key);
    if (!hit) return null;
    if (hit.until < Date.now()) {
      this.delete(key);
      return null;
    }
    // Refresh recency: Map iteration order is insertion order.
    this.map.delete(key);
    this.map.set(key, hit);
    return hit;
  }
  set(key: string, value: Cached): void {
    if (value.body.length > this.maxBytes / 8) return;
    this.delete(key);
    this.map.set(key, value);
    this.bytes += value.body.length;
    for (const k of this.map.keys()) {
      if (this.bytes <= this.maxBytes) break;
      this.delete(k);
    }
  }
  private delete(key: string): void {
    const old = this.map.get(key);
    if (old) {
      this.bytes -= old.body.length;
      this.map.delete(key);
    }
  }
}

/** Token bucket shared by every client of one route. */
export class Bucket {
  private tokens: number;
  private last = Date.now();
  private readonly rate: number;
  private readonly burst: number;
  constructor(perSecond: number, burst: number) {
    this.rate = perSecond;
    this.burst = burst;
    this.tokens = burst;
  }
  take(): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

export type RelayState = {
  cache: ResponseCache;
  /** Every address a hostname resolves to; icon fetches refuse any that is private. Tests replace it. */
  resolve: (host: string) => Promise<string[]>;
  limits: { rpc: Bucket; jup: Bucket; img: Bucket; feeds: Bucket };
  /** Last good body of each feed, served when its upstream fails or rate-limits. */
  stale: Map<string, Uint8Array<ArrayBuffer>>;
};

export function newState(): RelayState {
  return {
    cache: new ResponseCache(24 * 1024 * 1024),
    resolve: async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address),
    limits: { rpc: new Bucket(25, 50), jup: new Bucket(8, 20), img: new Bucket(40, 80), feeds: new Bucket(1, 4) },
    stale: new Map(),
  };
}

// ---------- helpers ----------

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...extra },
  });
}

const busy = () => json(429, { error: "busy" }, { "retry-after": "1" });

async function readBody(req: Request): Promise<string | null> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY) return null;
  const text = await req.text();
  return text.length > MAX_BODY ? null : text;
}

function fromCache(hit: Cached, cacheControl: string): Response {
  return new Response(hit.body, { status: hit.status, headers: { "content-type": hit.type, "cache-control": cacheControl } });
}

// ---------- routes ----------

export async function handleRpc(req: Request, env: RelayEnv, state: RelayState): Promise<Response> {
  if (req.method !== "POST") return json(405, { error: "POST only" });
  const text = await readBody(req);
  if (text === null) return json(413, { error: "body too large" });
  let call: { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  try {
    call = JSON.parse(text);
  } catch {
    return json(400, { error: "not JSON" });
  }
  if (Array.isArray(call)) return json(400, { error: "one call per request" });
  if (call.jsonrpc !== "2.0" || typeof call.method !== "string" || !RPC_METHODS.has(call.method)) {
    return json(400, { error: "method not allowed" });
  }
  if (!state.limits.rpc.take()) return busy();
  const upstream = await fetch(env.SOLANA_RPC_URL || DEFAULT_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: call.id ?? 1, method: call.method, params: call.params ?? [] }),
    signal: AbortSignal.timeout(15_000),
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/** One Base JSON-RPC call, same rules as Solana's: allowlisted methods, no batches, nothing about the client. */
export async function handleBaseRpc(req: Request, env: RelayEnv, state: RelayState): Promise<Response> {
  if (req.method !== "POST") return json(405, { error: "POST only" });
  const text = await readBody(req);
  if (text === null) return json(413, { error: "body too large" });
  let call: { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  try {
    call = JSON.parse(text);
  } catch {
    return json(400, { error: "not JSON" });
  }
  if (Array.isArray(call)) return json(400, { error: "one call per request" });
  if (call.jsonrpc !== "2.0" || typeof call.method !== "string" || !BASE_RPC_METHODS.has(call.method)) {
    return json(400, { error: "method not allowed" });
  }
  if (!state.limits.rpc.take()) return busy();
  const upstream = await fetch(env.BASE_RPC_URL || DEFAULT_BASE_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: call.id ?? 1, method: call.method, params: call.params ?? [] }),
    signal: AbortSignal.timeout(15_000),
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * KyberSwap on Base, two calls only: a route quote (GET, three validated
 * parameters and nothing else, so a client can't add identifying ones) and
 * building that route into a transaction (POST, body passed as is). Never cached.
 */
export async function handleKyber(req: Request, env: RelayEnv, state: RelayState): Promise<Response> {
  const url = new URL(req.url);
  const path = url.searchParams.get("path");
  const base = `${(env.KYBER_API_BASE || DEFAULT_KYBER).replace(/\/$/, "")}/base/api/v1`;
  const headers: Record<string, string> = { accept: "application/json", "x-client-id": "revolve" };
  let target: string;
  let body: string | undefined;
  if (path === "routes") {
    if (req.method !== "GET") return json(405, { error: "GET only" });
    const tokenIn = url.searchParams.get("tokenIn") ?? "";
    const tokenOut = url.searchParams.get("tokenOut") ?? "";
    const amountIn = url.searchParams.get("amountIn") ?? "";
    if (!EVM_ADDRESS.test(tokenIn) || !EVM_ADDRESS.test(tokenOut) || !/^[1-9]\d{0,77}$/.test(amountIn)) {
      return json(400, { error: "bad route parameters" });
    }
    target = `${base}/routes?${new URLSearchParams({ tokenIn, tokenOut, amountIn })}`;
  } else if (path === "route/build") {
    if (req.method !== "POST") return json(405, { error: "POST only" });
    const text = await readBody(req);
    if (text === null) return json(413, { error: "body too large" });
    body = text;
    headers["content-type"] = "application/json";
    target = `${base}/route/build`;
  } else {
    return json(404, { error: "path not allowed" });
  }
  if (!state.limits.jup.take()) return busy();
  const upstream = await fetch(target, { method: req.method, headers, body, signal: AbortSignal.timeout(20_000) });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "content-type": upstream.headers.get("content-type") ?? "application/json", "cache-control": "no-store" },
  });
}

export async function handleJup(req: Request, env: RelayEnv, state: RelayState): Promise<Response> {
  const url = new URL(req.url);
  const path = url.searchParams.get("path") ?? "";
  const rule = JUP_PATHS.find((r) => r.re.test(path));
  if (!rule) return json(404, { error: "path not allowed" });
  if (req.method !== rule.method) return json(405, { error: `${rule.method} only` });
  const query = new URLSearchParams(url.searchParams);
  query.delete("path");
  const base = (env.JUP_API_BASE || (env.JUP_API_KEY ? "https://api.jup.ag" : DEFAULT_JUP)).replace(/\/$/, "");
  const target = `${base}/${path}${query.size ? `?${query}` : ""}`;
  const browserCache = rule.cacheSeconds ? `public, max-age=${Math.min(rule.cacheSeconds, 15)}` : "no-store";
  if (rule.cacheSeconds) {
    const hit = state.cache.get(target);
    if (hit) return fromCache(hit, browserCache);
  }
  if (!state.limits.jup.take()) return busy();
  const headers: Record<string, string> = { accept: "application/json" };
  if (env.JUP_API_KEY) headers["x-api-key"] = env.JUP_API_KEY;
  let body: string | undefined;
  if (rule.method === "POST") {
    const text = await readBody(req);
    if (text === null) return json(413, { error: "body too large" });
    body = text;
    headers["content-type"] = "application/json";
  }
  const upstream = await fetch(target, { method: rule.method, headers, body, signal: AbortSignal.timeout(20_000) });
  const type = upstream.headers.get("content-type") ?? "application/json";
  if (!rule.cacheSeconds || !upstream.ok) {
    return new Response(upstream.body, { status: upstream.status, headers: { "content-type": type, "cache-control": "no-store" } });
  }
  const bytes = new Uint8Array(await upstream.arrayBuffer());
  state.cache.set(target, { until: Date.now() + rule.cacheSeconds * 1000, status: upstream.status, type, body: bytes });
  return new Response(bytes, { status: upstream.status, headers: { "content-type": type, "cache-control": browserCache } });
}

/** GET a fixed upstream URL. The only headers sent are these: never anything from the client. */
/** Reads a body up to `max` bytes, or null as soon as it is larger. Never buffers more than `max`. */
export async function readCapped(res: Response, max: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel();
    return null;
  }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const MAX_FEED_BODY = 4 * 1024 * 1024;

async function upstreamJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const res = await fetch(url, { headers: { accept: "application/json", ...headers }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`upstream ${res.status}`);
  const body = await readCapped(res, MAX_FEED_BODY);
  if (body === null) throw new Error("upstream body too large");
  return JSON.parse(new TextDecoder().decode(body));
}

/** Collection metadata (name, image): best effort, cached a day; after a failure not retried for an hour. */
async function nftMeta(state: RelayState, key: string, url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const hit = state.cache.get(key);
  if (hit) return hit.body.length ? JSON.parse(new TextDecoder().decode(hit.body)) : null;
  try {
    const meta = (await upstreamJson(url, headers)) as { name?: unknown; image?: unknown; image_url?: unknown };
    const keep = { name: meta?.name, image: meta?.image, image_url: meta?.image_url };
    state.cache.set(key, { until: Date.now() + NFT_META_TTL, status: 200, type: "application/json", body: new TextEncoder().encode(JSON.stringify(keep)) });
    return keep;
  } catch {
    state.cache.set(key, { until: Date.now() + NFT_META_RETRY, status: 200, type: "application/json", body: new Uint8Array(0) });
    return null;
  }
}

/** One cached, read-only feed. On an upstream failure the last good copy is served, marked stale. */
async function feed(state: RelayState, key: string, ttl: number, load: () => Promise<unknown>): Promise<Response> {
  const browserCache = "public, max-age=30";
  const hit = state.cache.get(key);
  if (hit) return fromCache(hit, browserCache);
  const stale = () => {
    const last = state.stale.get(key);
    return last ? new Response(last, { status: 200, headers: { "content-type": "application/json", "cache-control": "public, max-age=15", "x-revolve-stale": "1" } }) : null;
  };
  if (!state.limits.feeds.take()) return stale() ?? busy();
  try {
    const body = new TextEncoder().encode(JSON.stringify({ items: await load(), at: new Date().toISOString() }));
    state.cache.set(key, { until: Date.now() + ttl, status: 200, type: "application/json", body });
    state.stale.set(key, body);
    return new Response(body, { status: 200, headers: { "content-type": "application/json", "cache-control": browserCache } });
  } catch {
    return stale() ?? json(502, { error: "upstream failed" });
  }
}

export function handleFeed(req: Request, env: RelayEnv, state: RelayState, which: FeedName): Promise<Response> | Response {
  if (req.method !== "GET") return json(405, { error: "GET only" });
  if (which === "nfts/ethereum" || which === "nfts/robinhood") {
    const key = env.OPENSEA_API_KEY;
    if (!key) return json(503, { error: "not configured" });
    const chain = which === "nfts/ethereum" ? "ethereum" : "robinhood";
    return feed(state, `feed:${which}`, FEED_TTL.nfts, async () => {
      const out: NftCollection[] = [];
      // One collection at a time: 8 stats calls per 5 minutes, far below the key's hourly limit.
      for (const entry of OPENSEA_NFTS[chain]) {
        const base = `${OPENSEA}/${encodeURIComponent(entry.symbol)}`;
        const auth = { "x-api-key": key };
        const stats = await upstreamJson(`${base}/stats`, auth).catch(() => null);
        const card = projectOpenSea(entry, chain, await nftMeta(state, `nft:meta:${chain}:${entry.symbol}`, base, auth), stats);
        if (card) out.push(card);
      }
      if (!out.length) throw new Error("no collections");
      return out;
    });
  }
  if (which === "markets") return feed(state, "feed:markets", FEED_TTL.markets, async () => projectPolymarket(await upstreamJson(POLYMARKET_EVENTS)));
  return feed(state, "feed:nfts", FEED_TTL.nfts, async () => {
    const out: NftCollection[] = [];
    // One collection at a time, so a refresh stays far below Magic Eden's per-minute limit.
    for (const entry of nftList(env.NFT_COLLECTIONS, DEFAULT_NFTS)) {
      const base = `${MAGIC_EDEN}/${encodeURIComponent(entry.symbol)}`;
      const stats = await upstreamJson(`${base}/stats`).catch(() => null);
      const card = projectNft(entry, await nftMeta(state, `nft:meta:${entry.symbol}`, base), stats);
      if (card) out.push(card);
    }
    if (!out.length) throw new Error("no collections");
    return out;
  });
}

/**
 * True for addresses an icon fetch must never reach: loopback, private,
 * link-local (cloud metadata), CGNAT, multicast, reserved, and their IPv6 forms.
 */
export function privateAddress(ip: string): boolean {
  const v4 = (a: string) => {
    const p = a.split(".").map(Number);
    if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const [a0, a1] = p as [number, number, number, number];
    return (
      a0 === 0 || a0 === 10 || a0 === 127 || a0 >= 224 ||
      (a0 === 100 && a1 >= 64 && a1 <= 127) ||
      (a0 === 169 && a1 === 254) ||
      (a0 === 172 && a1 >= 16 && a1 <= 31) ||
      (a0 === 192 && a1 === 168) ||
      (a0 === 192 && a1 === 0 && p[2] === 0) ||
      (a0 === 198 && (a1 === 18 || a1 === 19))
    );
  };
  const kind = isIP(ip);
  if (kind === 4) return v4(ip);
  if (kind !== 6) return true;
  const h = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  if (mapped) return v4(mapped[1]!);
  return h === "::" || h === "::1" || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith("ff") || h.startsWith("64:ff9b:") || h.startsWith("2001:db8:");
}

const MAX_REDIRECTS = 3;

/** An icon URL we may fetch: https on the default port, no credentials, a public name. */
function allowedIconUrl(u: URL): boolean {
  return u.protocol === "https:" && (u.port === "" || u.port === "443") && !u.username && !u.password && !blockedHost(u.hostname);
}

/** True for hostnames we refuse to fetch: IP literals and local names. */
export function blockedHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (/^[\d.]+$/.test(h) || h.includes(":")) return true;
  return !h.includes(".");
}

const IMAGE_HEADERS = {
  "cache-control": "public, max-age=86400",
  // An SVG opened directly must not run as a page on our origin.
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  "x-content-type-options": "nosniff",
};

export async function handleImg(req: Request, state: RelayState): Promise<Response> {
  if (req.method !== "GET") return json(405, { error: "GET only" });
  const raw = new URL(req.url).searchParams.get("u") ?? "";
  let src: URL;
  try {
    src = new URL(raw);
  } catch {
    return json(400, { error: "bad url" });
  }
  if (!allowedIconUrl(src)) return json(400, { error: "url not allowed" });
  const hit = state.cache.get(src.href);
  if (hit?.status === 200) return new Response(hit.body, { status: 200, headers: { "content-type": hit.type, ...IMAGE_HEADERS } });
  if (hit) return json(502, { error: "icon unavailable" }, { "cache-control": "public, max-age=30" });
  if (!state.limits.img.take()) return busy();
  // Failed icons are remembered so every page view doesn't wait on the same
  // dead host: 10 minutes when the answer was definite (not an image, too
  // large, 4xx), 30 seconds for timeouts, network errors and 5xx, which are
  // often just a slow moment.
  const fail = (error: string, transient: boolean) => {
    state.cache.set(src.href, { until: Date.now() + (transient ? 30_000 : 600_000), status: 502, type: "", body: new Uint8Array(0) });
    return json(502, { error });
  };
  // Redirects are followed by hand so every hop is checked like the first:
  // https, public name, and every address it resolves to public. (A name
  // could still re-resolve between this check and the connection; that
  // window is accepted, since nothing fetched is returned unless it is an image.)
  let upstream: Response | null = null;
  let at = src;
  const deadline = AbortSignal.timeout(8_000);
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const addrs = await state.resolve(at.hostname);
      if (!addrs.length || addrs.some(privateAddress)) return fail("not an image", false);
      const r = await fetch(at, { headers: { accept: "image/*" }, redirect: "manual", signal: deadline });
      if (r.status < 300 || r.status >= 400) {
        upstream = r;
        break;
      }
      await r.body?.cancel();
      const next = r.headers.get("location");
      let to: URL;
      try {
        to = new URL(next ?? "", at);
      } catch {
        return fail("not an image", false);
      }
      if (!next || !allowedIconUrl(to)) return fail("not an image", false);
      at = to;
    }
  } catch {
    return fail("fetch failed", true);
  }
  if (!upstream) return fail("too many redirects", false);
  const type = (upstream.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (upstream.status >= 500) return fail("upstream error", true);
  if (!upstream.ok || !IMAGE_TYPES.test(type)) {
    await upstream.body?.cancel();
    return fail("not an image", false);
  }
  let bytes: Uint8Array<ArrayBuffer> | null;
  try {
    bytes = await readCapped(upstream, MAX_IMAGE);
  } catch {
    return fail("fetch failed", true);
  }
  if (bytes === null) return fail("image too large", false);
  state.cache.set(src.href, { until: Date.now() + 6 * 3600_000, status: 200, type, body: bytes });
  return new Response(bytes, { status: 200, headers: { "content-type": type, ...IMAGE_HEADERS } });
}

/**
 * The whole service as one fetch-style handler: routing, CORS for the app's
 * origin only, and the security headers every response carries.
 * `prefix` lets the app's dev server mount it under /api.
 */
export function createRelay(env: RelayEnv, state: RelayState = newState(), prefix = "") {
  const origin = env.APP_ORIGIN?.replace(/\/$/, "");
  return async (req: Request): Promise<Response> => {
    const path = new URL(req.url).pathname;
    const route = path.startsWith(prefix) ? path.slice(prefix.length) : "";
    let res: Response;
    if (req.method === "OPTIONS") {
      res = new Response(null, {
        status: 204,
        headers: { "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "content-type", "access-control-max-age": "600" },
      });
    } else {
      try {
        if (route === "/rpc") res = await handleRpc(req, env, state);
        else if (route === "/jup") res = await handleJup(req, env, state);
        else if (route === "/base-rpc") res = await handleBaseRpc(req, env, state);
        else if (route === "/kyber") res = await handleKyber(req, env, state);
        else if (route === "/img") res = await handleImg(req, state);
        else if (route === "/feeds/markets") res = await handleFeed(req, env, state, "markets");
        else if (route === "/feeds/nfts") res = await handleFeed(req, env, state, "nfts");
        else if (route === "/feeds/nfts/ethereum") res = await handleFeed(req, env, state, "nfts/ethereum");
        else if (route === "/feeds/nfts/robinhood") res = await handleFeed(req, env, state, "nfts/robinhood");
        else if (route === "/health") res = json(200, { ok: true });
        else res = json(404, { error: "not found" });
      } catch {
        // Upstream timeouts and network errors. Deliberately not logged.
        res = json(502, { error: "upstream failed" });
      }
    }
    const headers = new Headers(res.headers);
    if (origin) {
      headers.set("access-control-allow-origin", origin);
      headers.set("vary", "origin");
    }
    headers.set("referrer-policy", "no-referrer");
    headers.set("x-content-type-options", "nosniff");
    return new Response(res.body, { status: res.status, headers });
  };
}
