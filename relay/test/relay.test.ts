import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { blockedHost, Bucket, createRelay, handleImg, handleJup, handleRpc, newState, ResponseCache } from "../src/relay.ts";
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
    const s = newState();
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
    const s = newState();
    const get = () => handleImg(new Request(`https://relay.test/img?u=${encodeURIComponent("https://ipfs.io/ipfs/Qm1")}`), s);
    assert.equal((await get()).status, 502);
    assert.equal((await get()).status, 502);
    assert.equal(f.calls.length, 1);
  } finally {
    f.restore();
  }
});
