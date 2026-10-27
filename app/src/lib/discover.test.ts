import { test } from "node:test";
import assert from "node:assert/strict";
import { CATEGORIES, feeds, interleave, nftId, nftSource, nftUsd, pageAt, type NftCollection } from "./discover.ts";
import { ETH_MINT, SOL_MINT } from "./config.ts";
import { shortPrice } from "./format.ts";

test("card prices stay short: zeros after the point become a subscript count below $0.001", () => {
  assert.equal(shortPrice(0.000625), "$0.0₃625");
  assert.equal(shortPrice(0.0000034), "$0.0₅34");
  assert.equal(shortPrice(0.00000000123), "$0.0₈123");
  assert.equal(shortPrice(0.00000000000005), "$0.0₁₃5");
  assert.equal(shortPrice(0.0009996), "$0.00100"); // rounds up out of the tiny range: normal format
  assert.equal(shortPrice(0.0123), "$0.0123");
  assert.equal(shortPrice(147.6), "$147.60");
  assert.equal(shortPrice(undefined), "–");
});

test("categories are the five asked for, in order", () => {
  assert.deepEqual(CATEGORIES.map((c) => c.label), ["Trending memes", "New", "Stocks", "Prediction markets", "Popular collections"]);
});

test("page dots follow the scroll position, three cards per page, last page pinned to the end", () => {
  const step = 110; // card width + gap
  const count = 10; // 4 pages: 0-2, 3-5, 6-8, 9
  const max = 700;
  assert.equal(pageAt(0, max, step, count), 0);
  assert.equal(pageAt(step * 2, max, step, count), 0);
  assert.equal(pageAt(step * 3, max, step, count), 1);
  assert.equal(pageAt(step * 3 - 20, max, step, count), 1); // snapping in progress rounds to the nearest card
  assert.equal(pageAt(step * 6, max, step, count), 2);
  assert.equal(pageAt(max, max, step, count), 3); // fully scrolled: last page even if it is short
  assert.equal(pageAt(0, 0, step, 2), 0); // fewer cards than a page: a single page
  assert.equal(pageAt(99_999, max, step, count), 3);
});

const nft = (over: Partial<NftCollection>): NftCollection => ({ symbol: "x", name: "X", floor: null, listed: null, volume7d: null, ...over });

test("NFT amounts in USD per unit: lamports, wei and micro-dollars; nothing until the price is known", () => {
  const prices = { [SOL_MINT]: 150, [ETH_MINT]: 2300 };
  assert.equal(nftUsd("2000000000", "SOL", prices), 300);
  assert.equal(nftUsd("2000000000", undefined, prices), 300); // an older relay: Solana in lamports
  assert.equal(nftUsd("30250000000000000000", "ETH", prices), 69_575);
  assert.equal(nftUsd("440000000", "USD", {}), 440);
  assert.equal(nftUsd("1000000000000000000", "ETH", { [SOL_MINT]: 150 }), null);
  assert.equal(nftUsd(null, "ETH", prices), null);
});

test("NFT ids carry the chain, so the same slug on two chains stays two collections", () => {
  assert.equal(nftId(nft({ symbol: "punks", chain: "ethereum" })), "ethereum:punks");
  assert.equal(nftId(nft({ symbol: "mad_lads" })), "solana:mad_lads");
  assert.equal(nftSource(nft({ chain: "robinhood" })), "OpenSea");
  assert.equal(nftSource(nft({})), "Magic Eden");
});

test("collections interleave by chain, so the first page shows every chain", () => {
  assert.deepEqual(interleave([["s1", "s2", "s3"], ["e1", "e2"], ["r1"]]), ["s1", "e1", "r1", "s2", "e2", "s3"]);
  assert.deepEqual(interleave([[], ["e1"]]), ["e1"]);
  assert.deepEqual(interleave([]), []);
});

test("the NFT category loads all three chain feeds; one failing leaves the others, all failing is an error", async () => {
  const real = globalThis.fetch;
  const asked: string[] = [];
  let down = new Set<string>();
  globalThis.fetch = (async (url: string | URL) => {
    const path = String(url).replace(/^.*\/feeds\//, "");
    asked.push(path);
    if (down.has(path)) return new Response("{}", { status: 503 });
    const chain = path === "nfts" ? undefined : path.slice(5);
    return Response.json({ items: [nft({ symbol: `${chain ?? "sol"}-a`, chain: chain as NftCollection["chain"] })] });
  }) as typeof fetch;
  try {
    assert.deepEqual((await feeds.nfts()).map(nftId), ["solana:sol-a", "ethereum:ethereum-a", "robinhood:robinhood-a"]);
    assert.deepEqual(asked.sort(), ["nfts", "nfts/ethereum", "nfts/robinhood"]);
    down = new Set(["nfts/ethereum"]);
    assert.deepEqual((await feeds.nfts()).map(nftId), ["solana:sol-a", "robinhood:robinhood-a"]);
    down = new Set(["nfts", "nfts/ethereum", "nfts/robinhood"]);
    await assert.rejects(feeds.nfts(), /Unavailable \(503\)/);
  } finally {
    globalThis.fetch = real;
  }
});
