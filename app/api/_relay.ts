// The privacy relay. The phone talks only to this origin; the Solana RPC,
// Jupiter and token icon hosts see the relay's address instead of the
// user's, so they cannot tie burners together by IP.
//
// Rules: nothing is logged, no client header is forwarded (no IP, user
// agent, cookies or referrer), only allowlisted calls pass, and one
// JSON-RPC call per request (a batch would hand the RPC several burners at
// once).

export type RelayEnv = {
  SOLANA_RPC_URL?: string;
  JUP_API_BASE?: string;
  JUP_API_KEY?: string;
};

const DEFAULT_RPC = "https://api.mainnet-beta.solana.com";
const DEFAULT_JUP = "https://lite-api.jup.ag";
const MAX_BODY = 64 * 1024;
const MAX_IMAGE = 1024 * 1024;

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

const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp|avif|svg\+xml)$/;

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...extra },
  });
}

async function readBody(req: Request): Promise<string | null> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY) return null;
  const text = await req.text();
  return text.length > MAX_BODY ? null : text;
}

export async function handleRpc(req: Request, env: RelayEnv): Promise<Response> {
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

export async function handleJup(req: Request, env: RelayEnv): Promise<Response> {
  const url = new URL(req.url);
  const path = url.searchParams.get("path") ?? "";
  const rule = JUP_PATHS.find((r) => r.re.test(path));
  if (!rule) return json(404, { error: "path not allowed" });
  if (req.method !== rule.method) return json(405, { error: `${rule.method} only` });
  const query = new URLSearchParams(url.searchParams);
  query.delete("path");
  const base = (env.JUP_API_BASE || (env.JUP_API_KEY ? "https://api.jup.ag" : DEFAULT_JUP)).replace(/\/$/, "");
  const target = `${base}/${path}${query.size ? `?${query}` : ""}`;
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
  const cache = rule.cacheSeconds && upstream.ok ? `public, max-age=0, s-maxage=${rule.cacheSeconds}` : "no-store";
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "content-type": upstream.headers.get("content-type") ?? "application/json", "cache-control": cache },
  });
}

/** True for hostnames we refuse to fetch: IP literals and local names. */
export function blockedHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (/^[\d.]+$/.test(h) || h.includes(":")) return true;
  return !h.includes(".");
}

export async function handleImg(req: Request): Promise<Response> {
  if (req.method !== "GET") return json(405, { error: "GET only" });
  const raw = new URL(req.url).searchParams.get("u") ?? "";
  let src: URL;
  try {
    src = new URL(raw);
  } catch {
    return json(400, { error: "bad url" });
  }
  if (src.protocol !== "https:" || blockedHost(src.hostname) || src.username || src.password) {
    return json(400, { error: "url not allowed" });
  }
  let upstream: Response;
  try {
    upstream = await fetch(src, { headers: { accept: "image/*" }, redirect: "follow", signal: AbortSignal.timeout(8_000) });
  } catch {
    return json(502, { error: "fetch failed" });
  }
  const finalHost = new URL(upstream.url || src.href).hostname;
  const type = (upstream.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!upstream.ok || blockedHost(finalHost) || !IMAGE_TYPES.test(type)) return json(502, { error: "not an image" });
  const bytes = new Uint8Array(await upstream.arrayBuffer());
  if (bytes.length > MAX_IMAGE) return json(502, { error: "image too large" });
  return new Response(bytes, {
    status: 200,
    headers: {
      "content-type": type,
      "cache-control": "public, max-age=86400, s-maxage=604800",
      // An SVG opened directly must not run as a page on our origin.
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      "x-content-type-options": "nosniff",
    },
  });
}
