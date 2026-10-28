import { test } from "node:test";
import assert from "node:assert/strict";
import { nftList, projectNft, projectOpenSea, projectPolymarket, toBase } from "../src/feeds.ts";
import { createRelay, DEFAULT_NFTS, handleFeed, newState, OPENSEA_NFTS } from "../src/relay.ts";

const negRisk = {
  id: 1, title: "Fed Decision in October?", image: "https://x.test/fed.png", volume24hr: 7_188_822, endDate: "2026-10-29T03:59:00Z", negRisk: true,
  markets: [
    { groupItemTitle: "25 bps decrease", outcomes: '["Yes","No"]', outcomePrices: '["0.05","0.95"]', active: true, closed: false },
    { groupItemTitle: "No change", outcomes: '["Yes","No"]', outcomePrices: '["0.936","0.064"]', active: true, closed: false },
    { groupItemTitle: "Old", outcomes: '["Yes","No"]', outcomePrices: '["0.99","0.01"]', active: true, closed: true },
    { groupItemTitle: "Broken", outcomes: '["Yes","No"]', outcomePrices: "not json", active: true, closed: false },
  ],
};
const game = { id: "2", title: "Dream vs. Valkyries", icon: "https://x.test/g.png", negRisk: false, markets: [{ outcomes: '["Dream","Valkyries"]', outcomePrices: '["0.41","0.59"]', active: true, closed: false }] };
const finished = { id: "3", title: "Done", markets: [{ outcomes: '["A","B"]', outcomePrices: '["0","1"]', closed: true }] };

test("polymarket: leading outcome first, closed markets dropped, finished events skipped", () => {
  const out = projectPolymarket([negRisk, game, finished, { nonsense: true }]);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], {
    id: "1", title: "Fed Decision in October?", image: "https://x.test/fed.png", volume24h: 7_188_822, endDate: "2026-10-29T03:59:00Z",
    outcomes: [{ name: "No change", p: 0.936 }, { name: "25 bps decrease", p: 0.05 }],
  });
  assert.deepEqual(out[1]!.outcomes, [{ name: "Valkyries", p: 0.59 }, { name: "Dream", p: 0.41 }]);
  assert.equal(out[1]!.image, "https://x.test/g.png");
  assert.deepEqual(projectPolymarket({ not: "a list" }), []);
});

test("polymarket: decided events skipped, ladders by level, sports keep the main market's names", () => {
  const decided = {
    id: "4", title: "Ballon d'Or Winner", negRisk: true,
    markets: [
      { groupItemTitle: "Winner", outcomePrices: '["1","0"]', active: true, closed: true },
      { groupItemTitle: "Long shot", outcomePrices: '["0.0005","0.9995"]', active: true, closed: false },
    ],
  };
  const ladder = {
    id: "5", title: "What price will Bitcoin hit in October?", negRisk: false,
    markets: [
      { groupItemTitle: "↑ 150,000", outcomes: '["Yes","No"]', outcomePrices: '["0.02","0.98"]', active: true, closed: false },
      { groupItemTitle: "↑ 120,000", outcomes: '["Yes","No"]', outcomePrices: '["0.4","0.6"]', active: true, closed: false },
    ],
  };
  const sports = {
    id: "6", title: "Dream vs. Valkyries", negRisk: false,
    markets: [
      { outcomes: '["Dream","Valkyries"]', outcomePrices: '["0.41","0.59"]', active: true, closed: false },
      { groupItemTitle: "1H Moneyline", outcomes: '["Dream","Valkyries"]', outcomePrices: '["0.5","0.5"]', active: true, closed: false },
    ],
  };
  const out = projectPolymarket([decided, ladder, sports]);
  assert.deepEqual(out.map((e) => e.id), ["5", "6"]);
  assert.deepEqual(out[0]!.outcomes, [{ name: "↑ 120,000", p: 0.4 }, { name: "↑ 150,000", p: 0.02 }]);
  assert.deepEqual(out[1]!.outcomes, [{ name: "Valkyries", p: 0.59 }, { name: "Dream", p: 0.41 }]);
});

test("nft list: defaults, env override, bad symbols dropped", () => {
  assert.deepEqual(nftList(undefined, DEFAULT_NFTS), [...DEFAULT_NFTS]);
  assert.deepEqual(nftList("mad_lads:Mad Lads, bad symbol!, okay_bears", DEFAULT_NFTS), [
    { symbol: "mad_lads", name: "Mad Lads" },
    { symbol: "okay_bears", name: "okay_bears" },
  ]);
});

test("nft card: stats required, metadata optional", () => {
  const entry = { symbol: "mad_lads", name: "Mad Lads" };
  assert.deepEqual(projectNft(entry, null, { floorPrice: 7199000000, listedCount: 204, volume7d: 232970865000 }), {
    symbol: "mad_lads", name: "Mad Lads", image: undefined, chain: "solana",
    floor: "7199000000", floorUnit: "SOL", listed: 204, owners: null, volume7d: "232970865000", volumeUnit: "SOL",
  });
  assert.equal(projectNft(entry, { name: "MAD LADS", image: "https://img.test/m.png" }, { floorPrice: 1 })!.image, "https://img.test/m.png");
  assert.equal(projectNft(entry, { image: "http://insecure.test/x.png" }, { floorPrice: 1 })!.image, undefined);
  assert.equal(projectNft(entry, null, { error: "rate limited" }), null);
});

function stub(reply: (url: string) => Response | Promise<Response>) {
  const calls: { url: string; headers: Headers }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), headers: new Headers(init.headers) });
    return reply(String(url));
  }) as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = real) };
}

test("feeds use one fixed upstream, cache it, and serve the last good copy when it fails", async () => {
  let fail = false;
  const f = stub(() => (fail ? new Response("nope", { status: 429 }) : Response.json([game])));
  try {
    const s = newState();
    // Whatever the client puts in the query is ignored.
    const get = () => handleFeed(new Request("https://relay.test/feeds/markets?url=https://evil.test&limit=999"), {}, s, "markets");
    const first = await (await get()).json();
    assert.equal(first.items[0].title, "Dream vs. Valkyries");
    assert.equal(f.calls.length, 1);
    assert.match(f.calls[0]!.url, /^https:\/\/gamma-api\.polymarket\.com\/events\?active=true&closed=false&order=volume24hr&ascending=false&limit=5&offset=0$/);
    await get();
    assert.equal(f.calls.length, 1, "second read comes from the cache");
    // Expire the cache, then let the upstream fail: the stale copy is served.
    s.cache = new (s.cache.constructor as new (n: number) => typeof s.cache)(1024 * 1024);
    fail = true;
    const stale = await get();
    assert.equal(stale.status, 200);
    assert.equal(stale.headers.get("x-revolve-stale"), "1");
    assert.equal((await stale.json()).items[0].title, "Dream vs. Valkyries");
  } finally {
    f.restore();
  }
});

test("polymarket is read in small pages until there are 12 cards; a page too big or failing is skipped", async () => {
  const events = (from: number, n: number) =>
    Array.from({ length: n }, (_, i) => ({ ...game, id: String(from + i), title: `Event ${from + i}` }));
  const f = stub((url) => {
    const offset = Number(new URL(url).searchParams.get("offset"));
    // 5 MB: over the relay's cap for one reply, as a real 30-event page was.
    if (offset === 5) return new Response("[" + " ".repeat(5 * 1024 * 1024) + "]");
    if (offset === 10) return new Response("busy", { status: 500 });
    return Response.json(events(offset, 5));
  });
  try {
    const res = await handleFeed(new Request("https://relay.test/feeds/markets"), {}, newState(), "markets");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(
      body.items.map((e: { id: string }) => e.id),
      ["0", "1", "2", "3", "4", "15", "16", "17", "18", "19", "20", "21"],
      "pages 0, 15 and 20 used; 5 (too big) and 10 (failed) skipped",
    );
    assert.equal(f.calls.length, 5, "stops once there are enough cards");
  } finally {
    f.restore();
  }
});

test("polymarket feed fails only when every page does", async () => {
  const f = stub(() => new Response("down", { status: 503 }));
  try {
    const res = await handleFeed(new Request("https://relay.test/feeds/markets"), {}, newState(), "markets");
    assert.equal(res.status, 502);
    assert.equal(f.calls.length, 6);
  } finally {
    f.restore();
  }
});

test("nft feed: one collection at a time, missing metadata tolerated", async () => {
  const f = stub((url) => (url.endsWith("/stats") ? Response.json({ floorPrice: 5e8, listedCount: 10 }) : new Response("{}", { status: 429 })));
  try {
    const res = await handleFeed(new Request("https://relay.test/feeds/nfts"), { NFT_COLLECTIONS: "mad_lads:Mad Lads,tensorians:Tensorians" }, newState(), "nfts");
    const body = await res.json();
    assert.deepEqual(body.items.map((c: { name: string; floor: string }) => [c.name, c.floor]), [["Mad Lads", "500000000"], ["Tensorians", "500000000"]]);
    assert.ok(f.calls.every((c) => c.url.startsWith("https://api-mainnet.magiceden.dev/v2/collections/")));
  } finally {
    f.restore();
  }
});

test("feed routes over the relay: GET only, no client headers upstream", async () => {
  const f = stub(() => Response.json([game]));
  try {
    const relay = createRelay({ APP_ORIGIN: "https://app.test" });
    const res = await relay(new Request("https://relay.test/feeds/markets", { headers: { cookie: "a=b", "x-forwarded-for": "1.2.3.4" } }));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), "https://app.test");
    assert.deepEqual([...f.calls[0]!.headers.keys()], ["accept"]);
    assert.equal((await relay(new Request("https://relay.test/feeds/markets", { method: "POST", body: "{}" }))).status, 405);
    assert.equal((await relay(new Request("https://relay.test/feeds/other"))).status, 404);
  } finally {
    f.restore();
  }
});

// Shaped like OpenSea's /collections/:slug/stats.
const osStats = (floor: number, symbol: string, week: number | null = 12.5) => ({
  total: { volume: 1_000, volume_symbol: "ETH", sales: 10, num_owners: 3826, floor_price: floor, floor_price_symbol: symbol },
  intervals: [
    { interval: "one_day", volume: 1, volume_symbol: "ETH", sales: 1 },
    ...(week === null ? [] : [{ interval: "seven_day", volume: week, volume_symbol: "ETH", sales: 3 }]),
  ],
});

test("decimal amounts to base units: wei kept to gwei, micro-dollars, nothing for zero or junk", () => {
  assert.equal(toBase(30.25, "ETH"), "30250000000000000000");
  assert.equal(toBase(0.017027899998999996, "ETH"), "17027900000000000");
  assert.equal(toBase(0.0000001, "ETH"), "100000000000");
  assert.equal(toBase(440, "USD"), "440000000");
  for (const bad of [0, -1, NaN, Infinity, "1", null]) assert.equal(toBase(bad, "ETH"), null, String(bad));
});

test("opensea card: ETH or dollar floors, owners, week volume; no listings or unknown currency is no card", () => {
  const entry = { symbol: "cryptopunks", name: "CryptoPunks" };
  assert.deepEqual(projectOpenSea(entry, "ethereum", { name: "CryptoPunks", image_url: "https://i2c.seadn.io/p.png" }, osStats(30.25, "ETH")), {
    symbol: "cryptopunks", name: "CryptoPunks", image: "https://i2c.seadn.io/p.png", chain: "ethereum",
    floor: "30250000000000000000", floorUnit: "ETH", listed: null, owners: 3826, volume7d: "12500000000000000000", volumeUnit: "ETH",
  });
  // Floor in a stablecoin, volume still in ETH: each amount keeps its own unit.
  const rf = projectOpenSea({ symbol: "rare-friends-genesis", name: "Rare Friends Genesis" }, "robinhood", null, osStats(440, "USDG"))!;
  assert.deepEqual([rf.chain, rf.floor, rf.floorUnit, rf.volumeUnit, rf.name], ["robinhood", "440000000", "USD", "ETH", "Rare Friends Genesis"]);
  assert.equal(projectOpenSea(entry, "ethereum", null, osStats(1, "WETH"))!.floorUnit, "ETH");
  assert.equal(projectOpenSea(entry, "ethereum", null, osStats(1, "ETH", 0))!.volume7d, "0");
  assert.equal(projectOpenSea(entry, "ethereum", null, osStats(1, "ETH", null))!.volume7d, null);
  assert.equal(projectOpenSea(entry, "ethereum", { image_url: "http://insecure.test/x.png" }, osStats(1, "ETH"))!.image, undefined);
  assert.equal(projectOpenSea(entry, "robinhood", null, osStats(0, "")), null, "no listings");
  assert.equal(projectOpenSea(entry, "robinhood", null, osStats(3, "HOOD")), null, "unknown currency");
  assert.equal(projectOpenSea(entry, "ethereum", null, { errors: ["rate limited"] }), null);
});

test("opensea feeds: fixed slugs, only accept and the key go upstream, cached 5 minutes, 503 without a key", async () => {
  const f = stub((url) => (url.endsWith("/stats") ? Response.json(osStats(2, "ETH")) : Response.json({ name: "From meta", image_url: "https://i2c.seadn.io/x.png" })));
  try {
    const relay = createRelay({ APP_ORIGIN: "https://app.test", OPENSEA_API_KEY: "test-key" });
    const client = { headers: { cookie: "a=b", "x-forwarded-for": "1.2.3.4", "x-api-key": "client-key", "user-agent": "phone" } };
    for (const chain of ["ethereum", "robinhood"] as const) {
      const before = f.calls.length;
      const res = await relay(new Request(`https://relay.test/feeds/nfts/${chain}?slug=evil&limit=999`, client));
      assert.equal(res.status, 200);
      const items = (await res.json()).items as { chain: string; symbol: string; name: string }[];
      assert.deepEqual(items.map((c) => c.symbol), OPENSEA_NFTS[chain].map((e) => e.symbol));
      assert.ok(items.every((c) => c.chain === chain && c.name === "From meta"));
      const mine = f.calls.slice(before);
      assert.equal(mine.length, 16, "stats and metadata for each of 8 collections");
      for (const c of mine) {
        assert.match(c.url, /^https:\/\/api\.opensea\.io\/api\/v2\/collections\/[a-z0-9-]+(\/stats)?$/);
        assert.deepEqual([...c.headers.keys()].sort(), ["accept", "x-api-key"]);
        assert.equal(c.headers.get("x-api-key"), "test-key");
      }
      const n = f.calls.length;
      await relay(new Request(`https://relay.test/feeds/nfts/${chain}`));
      assert.equal(f.calls.length, n, "second read comes from the cache");
    }
    const none = createRelay({ APP_ORIGIN: "https://app.test" });
    const res = await none(new Request("https://relay.test/feeds/nfts/ethereum"));
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: "not configured" });
  } finally {
    f.restore();
  }
});
