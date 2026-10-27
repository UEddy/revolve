// Discover feeds for the home carousel. Tokens and stocks come from
// Jupiter's token data (as the Discover tab); prediction markets and NFT
// collections come from the relay's read-only feeds (relay/src/feeds.ts).
// All of it goes through the relay.

import { RELAY } from "./config.ts";
import { isStock, tokens, type JupToken } from "./jupiter.ts";

export type Category = "memes" | "new" | "stocks" | "markets" | "nfts";

export const CATEGORIES: { key: Category; label: string }[] = [
  { key: "memes", label: "Trending memes" },
  { key: "new", label: "New" },
  { key: "stocks", label: "Stocks" },
  { key: "markets", label: "Prediction markets" },
  { key: "nfts", label: "Popular collections" },
];

// Shapes of the relay's feeds (mirrored, not imported: app/ builds on its own).
export type MarketEvent = { id: string; title: string; image?: string; volume24h: number; endDate?: string; outcomes: { name: string; p: number }[] };
export type NftCollection = { symbol: string; name: string; image?: string; floor: string | null; listed: number | null; volume7d: string | null };

async function relayFeed<T>(path: string): Promise<T[]> {
  const res = await fetch(`${RELAY}/feeds/${path}`, { credentials: "omit" });
  if (!res.ok) throw new Error(res.status === 429 ? "Busy, try again in a moment" : `Unavailable (${res.status})`);
  const body = (await res.json()) as { items?: T[] };
  return Array.isArray(body.items) ? body.items : [];
}

export const feeds = {
  markets: () => relayFeed<MarketEvent>("markets"),
  nfts: () => relayFeed<NftCollection>("nfts"),
};

/** One card in the carousel, whatever its kind. */
export type Card =
  | { kind: "token"; id: string; token: JupToken }
  | { kind: "market"; id: string; market: MarketEvent }
  | { kind: "nft"; id: string; nft: NftCollection };

const MAX_CARDS = 12;

const isMeme = (t: JupToken) => !isStock(t) && !t.tags?.includes("rwa");

export async function loadCards(c: Category): Promise<Card[]> {
  const asTokens = (ts: JupToken[]): Card[] => ts.slice(0, MAX_CARDS).map((t) => ({ kind: "token", id: t.id, token: t }));
  switch (c) {
    case "memes":
      return asTokens((await tokens.trending()).filter(isMeme));
    case "new":
      return asTokens(await tokens.fresh());
    case "stocks":
      return asTokens(await tokens.stocks());
    case "markets":
      return (await feeds.markets()).slice(0, MAX_CARDS).map((m) => ({ kind: "market", id: m.id, market: m }));
    case "nfts":
      return (await feeds.nfts()).slice(0, MAX_CARDS).map((n) => ({ kind: "nft", id: n.symbol, nft: n }));
  }
}

/** Index of the first visible page given a scroll position: pages of `perPage` cards, last page pinned to the end. */
export function pageAt(scrollLeft: number, maxScroll: number, step: number, count: number, perPage = 3): number {
  const pages = Math.max(1, Math.ceil(count / perPage));
  if (maxScroll > 0 && scrollLeft >= maxScroll - 2) return pages - 1;
  return Math.min(pages - 1, Math.max(0, Math.floor(Math.round(scrollLeft / step) / perPage)));
}
