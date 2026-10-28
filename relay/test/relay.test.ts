import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { blockedHost, Bucket, createRelay, handleBaseRpc, handleImg, handleJup, handleKyber, handleRpc, newState, privateAddress, readCapped, ResponseCache, type RelayState } from "../src/relay.ts";

/** Tests never touch real DNS: every name resolves to one public address. */
function publicDns(s: RelayState, table: Record<string, string[]> = {}): RelayState {
  s.resolve = async (host) => table[host] ?? ["93.184.216.34"];
  return s;
}
import { toNode } from "../src/node.ts";

const post = (body: unknown) => new Request("https://relay.test/rpc", { method: "POST", body: JSON.stringify(body) });

function stubFetch(reply: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; headers: Headers; body: string }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), headers: new Headers(init.headers), body: String(init.body) });
    return reply(String(url), init);
  }) as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = real) };
}

test("rpc relay refuses batches and methods off the allowlist", async () => {
  const s = newState();
  assert.equal((await handleRpc(post([{ jsonrpc: "2.0", method: "getBalance" }]), {}, s)).status, 400);
  assert.equal((await handleRpc(post({ jsonrpc: "2.0", method: "getProgramAccounts" }), {}, s)).status, 400);
  assert.equal((await handleRpc(new Request("https://relay.test/rpc"), {}, s)).status, 405);
});

test("jup relay only passes allowlisted paths and methods", async () => {
  const s = newState();
  assert.equal((await handleJup(new Request("https://relay.test/jup?path=swap/v1/swap"), {}, s)).status, 404);
  assert.equal((await handleJup(new Request("https://relay.test/jup?path=../../etc"), {}, s)).status, 404);
  assert.equal((await handleJup(new Request("https://relay.test/jup?path=ultra/v1/execute"), {}, s)).status, 405);
});

test("public token data is cached; swaps never are", async () => {
  const f = stubFetch(() => new Response('{"ok":1}', { headers: { "content-type": "application/json" } }));
  try {
    const s = newState();
    const get = (p: string) => handleJup(new Request(`https://relay.test/jup?path=${p}`), {}, s);
    await get("tokens/v2/search&query=BONK");
    await get("tokens/v2/search&query=BONK");
    assert.equal(f.calls.length, 1);
    await get("ultra/v1/order&inputMint=a&outputMint=b&amount=1");
    await get("ultra/v1/order&inputMint=a&outputMint=b&amount=1");
    assert.equal(f.calls.length, 3);
  } finally {
    f.restore();
  }
});

test("rate limits are global and answer 429 without calling upstream", async () => {
  const f = stubFetch(() => new Response("{}"));
  try {
    const s = newState();
    s.limits.rpc = new Bucket(0, 2);
    const call = () => handleRpc(post({ jsonrpc: "2.0", id: 1, method: "getBalance", params: ["x"] }), {}, s);
    assert.equal((await call()).status, 200);
    assert.equal((await call()).status, 200);
    assert.equal((await call()).status, 429);
    assert.equal(f.calls.length, 2);
  } finally {
    f.restore();
  }
});

test("cache stays within its byte budget", () => {
  const c = new ResponseCache(800);
  for (let i = 0; i < 20; i++) c.set(`k${i}`, { until: Date.now() + 60_000, status: 200, type: "x", body: new Uint8Array(100) });
  let kept = 0;
  for (let i = 0; i < 20; i++) if (c.get(`k${i}`)) kept++;
  assert.ok(kept <= 8 && kept > 0, String(kept));
  assert.ok(c.get("k19"));
});

test("image proxy refuses local and non-https targets", async () => {
  for (const h of ["localhost", "127.0.0.1", "10.0.0.1", "[::1]", "metadata.google.internal", "intranet"]) assert.ok(blockedHost(h), h);
  assert.ok(!blockedHost("arweave.net"));
  for (const u of ["http://arweave.net/x", "https://127.0.0.1/x", "https://user:pw@arweave.net/x", "nope"]) {
    const res = await handleImg(new Request(`https://relay.test/img?u=${encodeURIComponent(u)}`), newState());
    assert.equal(res.status, 400, u);
  }
});

test("over HTTP: CORS for the app origin only, client headers never forwarded", async () => {
  const f = stubFetch(() => new Response('{"jsonrpc":"2.0","id":1,"result":{"value":5}}'));
  const server = createServer(toNode(createRelay({ APP_ORIGIN: "https://app.test", SOLANA_RPC_URL: "https://rpc.test" })));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    // The stub replaces fetch for the relay's upstream calls; the test's own
    // requests go through node:http directly.
    const { request } = await import("node:http");
    const send = (method: string, path: string, body?: string) =>
      new Promise<{ status: number; headers: Record<string, unknown> }>((resolve, reject) => {
        const r = request(`${base}${path}`, {
          method,
          headers: { "content-type": "application/json", "x-forwarded-for": "1.2.3.4", "user-agent": "phone", cookie: "a=b", origin: "https://app.test" },
        }, (res) => {
          res.resume();
          res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers }));
        });
        r.on("error", reject);
        r.end(body);
      });
    const pre = await send("OPTIONS", "/rpc");
    assert.equal(pre.status, 204);
    assert.equal(pre.headers["access-control-allow-origin"], "https://app.test");
    const res = await send("POST", "/rpc", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: ["x"] }));
    assert.equal(res.status, 200);
    assert.equal(res.headers["access-control-allow-origin"], "https://app.test");
    assert.equal(f.calls[0]!.url, "https://rpc.test");
    assert.deepEqual([...f.calls[0]!.headers.keys()], ["content-type"]);
    assert.equal((await send("GET", "/nope")).status, 404);
    assert.equal((await send("POST", "/rpc", "x".repeat(70 * 1024))).status, 413);
  } finally {
    f.restore();
    server.close();
  }
});

test("a slow-moment failure is retried after 30 s; a definite one stays cached for 10 min", async () => {
  mock.timers.enable({ apis: ["Date"], now: 0 });
  const f = stubFetch((url) => new Response("x", { status: url.endsWith("/slow") ? 504 : 404 }));
  try {
    const s = publicDns(newState());
    const get = (p: string) => handleImg(new Request(`https://relay.test/img?u=${encodeURIComponent(`https://img.test${p}`)}`), s);
    await get("/slow");
    await get("/gone");
    mock.timers.tick(31_000);
    await get("/slow");
    await get("/gone");
    assert.deepEqual(f.calls.map((c) => new URL(c.url).pathname), ["/slow", "/gone", "/slow"]);
    mock.timers.tick(600_000);
    await get("/gone");
    assert.equal(f.calls.length, 4);
  } finally {
    f.restore();
    mock.timers.reset();
  }
});

test("a dead icon is fetched once, then answered from the negative cache", async () => {
  const f = stubFetch(() => new Response("nope", { status: 504 }));
  try {
    const s = publicDns(newState());
    const get = () => handleImg(new Request(`https://relay.test/img?u=${encodeURIComponent("https://ipfs.io/ipfs/Qm1")}`), s);
    assert.equal((await get()).status, 502);
    assert.equal((await get()).status, 502);
    assert.equal(f.calls.length, 1);
  } finally {
    f.restore();
  }
});

test("private, loopback, link-local, CGNAT, multicast and reserved addresses are refused, v4 and v6", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1", "192.0.0.8",
    "::1", "::", "fc00::1", "fd12::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "64:ff9b::a00:1", "2001:db8::1", "not-an-ip"]) {
    assert.ok(privateAddress(ip), ip);
  }
  for (const ip of ["93.184.216.34", "1.1.1.1", "172.32.0.1", "100.128.0.1", "2606:4700::1111", "::ffff:8.8.8.8"]) assert.ok(!privateAddress(ip), ip);
});

const PNG = () => new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } });

test("icon redirects are followed by hand, and every hop is checked like the first", async () => {
  const hop = (to: string) => new Response(null, { status: 302, headers: { location: to } });
  const f = stubFetch((url) => {
    const u = new URL(url);
    if (u.pathname === "/to-local") return hop("http://127.0.0.1:8787/limits");
    if (u.pathname === "/to-metadata") return hop("https://metadata.internal/x");
    if (u.pathname === "/to-private-name") return hop("https://sneaky.test/x");
    if (u.pathname === "/to-port") return hop("https://cdn.test:8443/x");
    if (u.pathname === "/to-good") return hop("/final.png");
    if (u.pathname === "/loop") return hop("/loop");
    if (u.pathname === "/final.png") return PNG();
    return new Response("?", { status: 404 });
  });
  try {
    const s = publicDns(newState(), { "sneaky.test": ["10.0.0.5"] });
    const get = (path: string) => handleImg(new Request(`https://relay.test/img?u=${encodeURIComponent(`https://cdn.test${path}`)}`), s);
    for (const bad of ["/to-local", "/to-metadata", "/to-private-name", "/to-port"]) {
      const before = f.calls.length;
      assert.equal((await get(bad)).status, 502, bad);
      assert.equal(f.calls.length, before + 1, `${bad}: the redirect target is never fetched`);
    }
    const good = await get("/to-good");
    assert.equal(good.status, 200);
    assert.equal(good.headers.get("content-type"), "image/png");
    assert.equal(f.calls.at(-1)!.url, "https://cdn.test/final.png");
    const before = f.calls.length;
    assert.equal((await get("/loop")).status, 502);
    assert.equal(f.calls.length - before, 4, "the first request plus at most 3 redirects");
  } finally {
    f.restore();
  }
});

test("an icon host that resolves to a private address is never contacted", async () => {
  const f = stubFetch(() => PNG());
  try {
    const s = publicDns(newState(), { "internal.example": ["192.168.0.10"], "dual.example": ["93.184.216.34", "::1"], "nowhere.example": [] });
    for (const host of ["internal.example", "dual.example", "nowhere.example"]) {
      const res = await handleImg(new Request(`https://relay.test/img?u=${encodeURIComponent(`https://${host}/a.png`)}`), s);
      assert.equal(res.status, 502, host);
    }
    assert.equal(f.calls.length, 0);
    const port = await handleImg(new Request(`https://relay.test/img?u=${encodeURIComponent("https://cdn.test:8443/a.png")}`), s);
    assert.equal(port.status, 400, "non-default ports are refused up front");
  } finally {
    f.restore();
  }
});

test("bodies are read with a hard cap, declared or not, and never buffered past it", async () => {
  const stream = (chunks: number, size: number) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < chunks; i++) c.enqueue(new Uint8Array(size));
        c.close();
      },
    });
  assert.equal((await readCapped(new Response(stream(4, 1000)), 4000))?.length, 4000);
  assert.equal(await readCapped(new Response(stream(5, 1000)), 4000), null, "undeclared and too large");
  assert.equal(await readCapped(new Response("x".repeat(10), { headers: { "content-length": "999999" } }), 4000), null, "declared too large");
  const f = stubFetch(() => new Response(stream(3, 512 * 1024), { headers: { "content-type": "image/png" } }));
  try {
    const res = await handleImg(new Request(`https://relay.test/img?u=${encodeURIComponent("https://cdn.test/huge.png")}`), publicDns(newState()));
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { error: "image too large" });
  } finally {
    f.restore();
  }
});

test("base rpc relay: allowlisted methods only, one call per request, nothing from the client", async () => {
  const s = newState();
  const req = (body: unknown) => new Request("https://relay.test/base-rpc", { method: "POST", body: JSON.stringify(body), headers: { "x-forwarded-for": "1.2.3.4" } });
  assert.equal((await handleBaseRpc(req([{ jsonrpc: "2.0", method: "eth_getBalance" }]), {}, s)).status, 400);
  for (const method of ["eth_getLogs", "eth_newFilter", "debug_traceTransaction", "eth_accounts", "eth_sign"]) {
    assert.equal((await handleBaseRpc(req({ jsonrpc: "2.0", method }), {}, s)).status, 400, method);
  }
  const f = stubFetch(() => new Response('{"jsonrpc":"2.0","id":7,"result":"0x2105"}'));
  try {
    const r = await handleBaseRpc(req({ jsonrpc: "2.0", id: 7, method: "eth_chainId", params: [] }), { BASE_RPC_URL: "https://base.rpc.test" }, s);
    assert.equal(r.status, 200);
    assert.equal(f.calls[0]!.url, "https://base.rpc.test");
    assert.deepEqual(JSON.parse(f.calls[0]!.body), { jsonrpc: "2.0", id: 7, method: "eth_chainId", params: [] });
    assert.equal(f.calls[0]!.headers.get("x-forwarded-for"), null);
  } finally {
    f.restore();
  }
});

test("kyber relay: route quotes pass only three validated parameters; build passes its body; nothing else", async () => {
  const s = newState();
  const eth = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
  const usdc = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const get = (q: string) => handleKyber(new Request(`https://relay.test/kyber?${q}`), {}, s);
  assert.equal((await get("path=routes&tokenIn=nope&tokenOut=" + usdc + "&amountIn=1")).status, 400);
  assert.equal((await get(`path=routes&tokenIn=${eth}&tokenOut=${usdc}&amountIn=0`)).status, 400);
  assert.equal((await get("path=../../admin")).status, 404);
  assert.equal((await handleKyber(new Request("https://relay.test/kyber?path=route/build"), {}, s)).status, 405);

  const f = stubFetch(() => new Response('{"code":0,"data":{}}'));
  try {
    const r = await get(`path=routes&tokenIn=${eth}&tokenOut=${usdc}&amountIn=1000&source=me&clientIp=1.2.3.4`);
    assert.equal(r.status, 200);
    assert.equal(f.calls[0]!.url, `https://aggregator-api.kyberswap.com/base/api/v1/routes?tokenIn=${eth}&tokenOut=${usdc}&amountIn=1000`);
    assert.equal(f.calls[0]!.headers.get("x-client-id"), "revolve");
    const body = JSON.stringify({ routeSummary: {}, sender: usdc, recipient: usdc, slippageTolerance: 100 });
    await handleKyber(new Request("https://relay.test/kyber?path=route/build", { method: "POST", body }), {}, s);
    assert.equal(f.calls[1]!.url, "https://aggregator-api.kyberswap.com/base/api/v1/route/build");
    assert.equal(f.calls[1]!.body, body);
    assert.equal(r.headers.get("cache-control"), "no-store");
  } finally {
    f.restore();
  }
});
