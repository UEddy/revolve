// Discover feeds for the Discover tab's carousel. Tokens and stocks come from
// Jupiter's token data; prediction markets and NFT collections (Solana via
// Magic Eden, Ethereum and Robinhood Chain via OpenSea) come from the relay's
// read-only feeds (relay/src/feeds.ts).
// All of it goes through the relay.

import { ETH_MINT, RELAY, SOL_MINT } from "./config.ts";
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
export type NftChain = "solana" | "ethereum" | "robinhood";
export type NftUnit = "SOL" | "ETH" | "USD";
/** Amounts are base-unit strings of their unit. An older relay sends Solana only, without chain or units. */
export type NftCollection = {
  symbol: string;
  name: string;
  image?: string;
  chain?: NftChain;
  floor: string | null;
  floorUnit?: NftUnit;
  listed: number | null;
  owners?: number | null;
  volume7d: string | null;
  volumeUnit?: NftUnit;
};

export const CHAIN_LABEL: Record<NftChain, string> = { solana: "Solana", ethereum: "Ethereum", robinhood: "Robinhood Chain" };
/** For the carousel's narrow cards. */
export const CHAIN_SHORT: Record<NftChain, string> = { solana: "Solana", ethereum: "Ethereum", robinhood: "Robinhood" };
export const nftChain = (n: NftCollection): NftChain => n.chain ?? "solana";
/** The card and route id: a slug is only unique within its chain. */
export const nftId = (n: NftCollection) => `${nftChain(n)}:${n.symbol}`;
export const nftSource = (n: NftCollection) => (nftChain(n) === "solana" ? "Magic Eden" : "OpenSea");
/**
 * The collection's page on the marketplace its numbers come from: both
 * OpenSea's and Magic Eden's API terms ask for attribution, a link where
 * the data is shown. Slugs come from the relay's fixed lists.
 */
export function nftSourceUrl(n: NftCollection): string {
  const slug = encodeURIComponent(n.symbol);
  return nftChain(n) === "solana" ? `https://magiceden.io/marketplace/${slug}` : `https://opensea.io/collection/${slug}`;
}

/** A feed amount in USD, or null until the price it needs is known. */
export function nftUsd(amount: string | null, unit: NftUnit | undefined, prices: Record<string, number>): number | null {
  if (!amount) return null;
  const u = unit ?? "SOL";
  if (u === "USD") return Number(amount) / 1e6;
  const p = prices[u === "SOL" ? SOL_MINT : ETH_MINT];
  return p === undefined ? null : (Number(amount) / (u === "SOL" ? 1e9 : 1e18)) * p;
}

/** Round-robin across the chains, so the first page shows all three. */
export function interleave<T>(lists: T[][]): T[] {
  const out: T[] = [];
  for (let i = 0; lists.some((l) => i < l.length); i++) for (const l of lists) if (i < l.length) out.push(l[i]!);
  return out;
}

async function relayFeed<T>(path: string): Promise<T[]> {
  const res = await fetch(`${RELAY}/feeds/${path}`, { credentials: "omit" });
  if (!res.ok) throw new Error(res.status === 429 ? "Busy, try again in a moment" : `Unavailable (${res.status})`);
  const body = (await res.json()) as { items?: T[] };
  return Array.isArray(body.items) ? body.items : [];
}

const NFT_FEEDS = ["nfts", "nfts/ethereum", "nfts/robinhood"];

export const feeds = {
  markets: () => relayFeed<MarketEvent>("markets"),
  /** All three chains; a chain that fails is left out, and only all failing is an error. */
  nfts: async () => {
    const got = await Promise.allSettled(NFT_FEEDS.map((p) => relayFeed<NftCollection>(p)));
    const ok = got.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    if (!ok.length) throw (got[0] as PromiseRejectedResult).reason;
    return interleave(ok);
  },
};

/** One card in the carousel, whatever its kind. */
export type Card =
  | { kind: "token"; id: string; token: JupToken }
  | { kind: "market"; id: string; market: MarketEvent }
  | { kind: "nft"; id: string; nft: NftCollection };

const MAX_CARDS = 12;
const MAX_NFT_CARDS = 24; // 8 per chain

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
      return (await feeds.nfts()).slice(0, MAX_NFT_CARDS).map((n) => ({ kind: "nft", id: nftId(n), nft: n }));
  }
}

/** Index of the first visible page given a scroll position: pages of `perPage` cards, last page pinned to the end. */
export function pageAt(scrollLeft: number, maxScroll: number, step: number, count: number, perPage = 3): number {
  const pages = Math.max(1, Math.ceil(count / perPage));
  if (maxScroll > 0 && scrollLeft >= maxScroll - 2) return pages - 1;
  return Math.min(pages - 1, Math.max(0, Math.floor(Math.round(scrollLeft / step) / perPage)));
}
