// Discover cards built from the live snapshot (scripts/probe.mjs) with the
// app's own helpers, exactly as app/src/lib/discover.ts builds them.

import snapshot from "../generated/discover.json";
import { isStock, rank, type JupToken } from "../../../app/src/lib/jupiter.ts";
import { interleave, nftId, type Card, type Category, type NftCollection, type MarketEvent } from "../../../app/src/lib/discover.ts";

const MAX_CARDS = 12;
const asTokens = (ts: JupToken[]): Card[] => ts.slice(0, MAX_CARDS).map((t) => ({ kind: "token", id: t.id, token: t }));
const isMeme = (t: JupToken) => !isStock(t) && !t.tags?.includes("rwa");

export const CARDS: Record<Category, Card[]> = {
  memes: asTokens(rank(snapshot.trending as JupToken[]).filter(isMeme)),
  new: asTokens((snapshot.fresh as JupToken[]).filter((t) => (t.liquidity ?? 0) >= 1_000)),
  stocks: asTokens(rank((snapshot.stocks as JupToken[]).filter(isStock))),
  markets: (snapshot.markets as MarketEvent[]).slice(0, MAX_CARDS).map((m) => ({ kind: "market", id: m.id, market: m })),
  nfts: interleave([snapshot.nfts.solana, snapshot.nfts.ethereum, snapshot.nfts.robinhood] as NftCollection[][])
    .slice(0, 24)
    .map((n) => ({ kind: "nft", id: nftId(n), nft: n })),
};

export const SNAPSHOT_AT = snapshot.at;
export const PRICES = snapshot.prices as Record<string, number>;
export const TOKENS = { trending: snapshot.trending as JupToken[], stocks: snapshot.stocks as JupToken[] };

const icons = snapshot.icons as Record<string, string>;
const all = [...(snapshot.trending as JupToken[]), ...(snapshot.stocks as JupToken[])];
const withIcon = all.filter((t) => t.icon && icons[t.icon]);

/** A token from the snapshot by symbol, if it has an icon; else the first that does. */
export function pick(symbol: string): JupToken {
  return withIcon.find((t) => t.symbol === symbol) ?? withIcon[0] ?? all[0]!;
}
