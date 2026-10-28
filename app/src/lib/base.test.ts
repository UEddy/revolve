import { test } from "node:test";
import assert from "node:assert/strict";
import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { BASE_TOKENS } from "./basetokens.ts";
import { exportEvmKey, isChecksummed, isEvmAddress, newEvmBurner } from "./evm.ts";
import { buildMemo, zip321, parseZip321 } from "./memo.ts";
import { parseLimits } from "./amount.ts";
import { KYBER_ROUTER, kyberBuild, kyberRoute } from "./kyber.ts";

const UA = "u1" + "qpzry9x8gf2tvdw0s3jn54khce6mua7l".repeat(4);

test("the Base token list: every address in its exact checksummed form, no duplicates, sane decimals", () => {
  for (const t of BASE_TOKENS) {
    assert.equal(getAddress(t.mint), t.mint, t.symbol);
    assert.ok([6, 8, 18].includes(t.decimals), t.symbol);
  }
  assert.equal(new Set(BASE_TOKENS.map((t) => t.mint)).size, BASE_TOKENS.length);
  assert.equal(getAddress(KYBER_ROUTER), KYBER_ROUTER);
});

test("fresh Base wallets: checksummed address, exported key gives back the same address", () => {
  const a = newEvmBurner();
  const b = newEvmBurner();
  assert.ok(isChecksummed(a.pub));
  assert.notEqual(a.pub, b.pub);
  const key = exportEvmKey(a);
  assert.match(key, /^0x[0-9a-f]{64}$/);
  assert.equal(privateKeyToAccount(key as `0x${string}`).address, a.pub);
});

test("Base memo: rv1|order|base|address, checksummed only; Solana memo unchanged", () => {
  const w = newEvmBurner().pub;
  const memo = buildMemo("rv_0123456789", w, "base");
  assert.equal(memo, `rv1|rv_0123456789|base|${w}`);
  assert.deepEqual(parseZip321(zip321(UA, "0.004", memo)), { address: UA, amount: "0.004", memo });
  assert.throws(() => buildMemo("rv_0123456789", w.toLowerCase(), "base"));
  assert.throws(() => buildMemo("rv_0123456789", w), "an EVM address is not a Solana burner");
  assert.ok(isEvmAddress(w.toLowerCase()), "a pasted lowercase address is fine to send to");
});

test("limits per chain: Base from `chains`, unavailable when Base is missing", () => {
  const body = {
    min_zec: "0.002", max_zec: "0.005", step_zec: "0.001", indicative_usd_per_zec: "1224.50",
    chains: { solana: { min_zec: "0.002", max_zec: "0.005", step_zec: "0.001" }, base: { min_zec: "0.002", max_zec: "0.004", step_zec: "0.001" } },
  };
  assert.equal(parseLimits(body).max, 500_000n);
  assert.equal(parseLimits(body, "base").max, 400_000n);
  assert.equal(parseLimits(body, "base").usdPerZec, 122_450_000_000n);
  const noBase = parseLimits({ ...body, chains: { solana: body.chains.solana } }, "base");
  assert.ok(noBase.max < noBase.min, "reads as unavailable");
  assert.ok(parseLimits({ min_zec: "0.002", max_zec: "0.005", step_zec: "0.001", indicative_usd_per_zec: "1" }, "base").max < 200_000n, "a v1.2 worker offers no Base");
});

function stubFetch(reply: (url: string) => unknown) {
  const real = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (url: string | URL) => {
    urls.push(String(url));
    return new Response(JSON.stringify(reply(String(url))), { status: 200 });
  }) as typeof fetch;
  return { urls, restore: () => void (globalThis.fetch = real) };
}

test("KyberSwap: a route or build naming any other router is refused before anything is signed", async () => {
  const summary = { tokenIn: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", amountIn: "100", tokenOut: BASE_TOKENS[0]!.mint, amountOut: "5" };
  let router = "0x0000000000000000000000000000000000000bad";
  const f = stubFetch((url) =>
    url.includes("route%2Fbuild") || url.includes("route/build")
      ? { code: 0, data: { data: "0xabcdef", routerAddress: router, transactionValue: "100", amountOut: "5" } }
      : { code: 0, data: { routeSummary: summary, routerAddress: router } },
  );
  try {
    await assert.rejects(kyberRoute(summary.tokenIn, summary.tokenOut, 100n), /unexpected contract/);
    await assert.rejects(kyberBuild(summary, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"), /unexpected contract/);
    router = KYBER_ROUTER.toLowerCase();
    assert.equal((await kyberRoute(summary.tokenIn, summary.tokenOut, 100n)).amountOut, "5");
    const tx = await kyberBuild(summary, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
    assert.deepEqual(tx, { to: KYBER_ROUTER, data: "0xabcdef", value: 100n, amountOut: "5" });
    assert.match(f.urls[0]!, /\/kyber\?path=routes&tokenIn=0xEeee.*&amountIn=100$/);
  } finally {
    f.restore();
  }
});
