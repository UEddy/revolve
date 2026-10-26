import { test } from "node:test";
import assert from "node:assert/strict";
import { blockedHost, handleImg, handleJup, handleRpc } from "./_relay.ts";

const post = (body: unknown) => new Request("https://app.test/api/rpc", { method: "POST", body: JSON.stringify(body) });

test("rpc relay refuses batches and methods off the allowlist", async () => {
  assert.equal((await handleRpc(post([{ jsonrpc: "2.0", method: "getBalance" }]), {})).status, 400);
  assert.equal((await handleRpc(post({ jsonrpc: "2.0", method: "getProgramAccounts" }), {})).status, 400);
  assert.equal((await handleRpc(new Request("https://app.test/api/rpc"), {})).status, 405);
});

test("rpc relay forwards one call without client headers", async () => {
  const seen: { url: string; headers: Headers; body: string }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, headers: new Headers(init.headers), body: String(init.body) });
    return new Response('{"jsonrpc":"2.0","id":1,"result":{"value":5}}');
  }) as typeof fetch;
  try {
    const req = new Request("https://app.test/api/rpc", {
      method: "POST",
      headers: { "x-forwarded-for": "1.2.3.4", "user-agent": "phone", cookie: "a=b" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: ["x"] }),
    });
    const res = await handleRpc(req, { SOLANA_RPC_URL: "https://rpc.test" });
    assert.equal(res.status, 200);
    assert.equal(seen[0]!.url, "https://rpc.test");
    assert.deepEqual([...seen[0]!.headers.keys()], ["content-type"]);
  } finally {
    globalThis.fetch = real;
  }
});

test("jup relay only passes allowlisted paths and methods", async () => {
  assert.equal((await handleJup(new Request("https://app.test/api/jup?path=swap/v1/swap"), {})).status, 404);
  assert.equal((await handleJup(new Request("https://app.test/api/jup?path=../../etc"), {})).status, 404);
  assert.equal((await handleJup(new Request("https://app.test/api/jup?path=ultra/v1/execute"), {})).status, 405);
});

test("image proxy refuses local and non-https targets", async () => {
  for (const h of ["localhost", "127.0.0.1", "10.0.0.1", "[::1]", "metadata.google.internal", "intranet"]) assert.ok(blockedHost(h), h);
  assert.ok(!blockedHost("arweave.net"));
  for (const u of ["http://arweave.net/x", "https://127.0.0.1/x", "https://user:pw@arweave.net/x", "nope"]) {
    const res = await handleImg(new Request(`https://app.test/api/img?u=${encodeURIComponent(u)}`));
    assert.equal(res.status, 400, u);
  }
});
