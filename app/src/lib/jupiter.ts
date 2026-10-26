// Jupiter token data and Ultra swaps, always through our relay so Jupiter
// sees the relay's address, never the phone's.

import { RELAY } from "./config.ts";
import type { TokenRef } from "./model.ts";

export type JupToken = {
  id: string;
  name: string;
  symbol: string;
  icon?: string;
  decimals: number;
  usdPrice?: number;
  mcap?: number;
  liquidity?: number;
  holderCount?: number;
  isVerified?: boolean;
  tags?: string[];
  organicScoreLabel?: "high" | "medium" | "low";
  stats24h?: { priceChange?: number; buyVolume?: number; sellVolume?: number };
  stats1h?: { priceChange?: number };
  firstPool?: { createdAt?: string };
  audit?: { mintAuthorityDisabled?: boolean; freezeAuthorityDisabled?: boolean; topHoldersPercentage?: number };
  createdAt?: string;
};

async function jup<T>(path: string, params: Record<string, string> = {}, init?: RequestInit): Promise<T> {
  const q = new URLSearchParams({ path, ...params });
  // Rate limits are per relay, shared by everyone: back off and retry reads.
  // Never retry execute: a signed swap is sent once.
  const tries = init?.method === "POST" ? 1 : 4;
  for (let i = 0; ; i++) {
    const res = await fetch(`${RELAY}/jup?${q}`, { credentials: "omit", ...init });
    if (res.ok) return (await res.json()) as T;
    if (res.status !== 429 || i + 1 >= tries) {
      throw new Error(res.status === 429 ? "Market data is busy, try again in a moment" : `Market data unavailable (${res.status})`);
    }
    await new Promise((r) => setTimeout(r, 800 * 2 ** i + Math.random() * 400));
  }
}

export function isStock(t: Pick<JupToken, "tags">): boolean {
  return !!t.tags?.includes("stocks");
}

/** Drops tokens with no meaningful market and puts verified ones first, keeping Jupiter's order otherwise. */
export function rank(tokens: JupToken[]): JupToken[] {
  return tokens
    .filter((t) => (t.liquidity ?? 0) >= 1_000 || t.isVerified)
    .map((t, i) => ({ t, i }))
    .sort((a, b) => Number(!!b.t.isVerified) - Number(!!a.t.isVerified) || a.i - b.i)
    .map(({ t }) => t);
}

export const tokens = {
  search: (query: string) => jup<JupToken[]>("tokens/v2/search", { query }).then(rank),
  trending: () => jup<JupToken[]>("tokens/v2/toptrending/1h", { limit: "40" }).then(rank),
  fresh: () => jup<JupToken[]>("tokens/v2/recent", { limit: "40" }).then((ts) => ts.filter((t) => (t.liquidity ?? 0) >= 1_000)),
  stocks: () => jup<JupToken[]>("tokens/v2/search", { query: "xStock" }).then((ts) => rank(ts.filter(isStock))),
  byMint: async (mint: string) => (await jup<JupToken[]>("tokens/v2/search", { query: mint })).find((t) => t.id === mint) ?? null,
};

export async function usdPrice(mint: string): Promise<number | null> {
  const r = await jup<Record<string, { usdPrice?: number } | undefined>>("price/v3", { ids: mint });
  return r[mint]?.usdPrice ?? null;
}

export function toRef(t: JupToken): TokenRef {
  return {
    mint: t.id,
    symbol: t.symbol,
    name: t.name,
    icon: t.icon,
    decimals: t.decimals,
    isStock: isStock(t),
    verified: !!t.isVerified,
    launchedAt: t.firstPool?.createdAt ?? t.createdAt,
    holderCount: t.holderCount,
  };
}

export type UltraOrder = {
  requestId: string;
  transaction: string | null;
  inAmount: string;
  outAmount: string;
  priceImpactPct?: string;
  errorMessage?: string;
  error?: string;
};

export function ultraOrder(inputMint: string, outputMint: string, amount: bigint, taker?: string): Promise<UltraOrder> {
  const p: Record<string, string> = { inputMint, outputMint, amount: amount.toString() };
  if (taker) p.taker = taker;
  return jup<UltraOrder>("ultra/v1/order", p);
}

export type UltraResult = { status: "Success" | "Failed"; signature?: string; error?: string; code?: number; outputAmountResult?: string };

export function ultraExecute(signedTransaction: string, requestId: string): Promise<UltraResult> {
  return jup<UltraResult>("ultra/v1/execute", {}, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ signedTransaction, requestId }),
  });
}

/** Icons load through the relay too: an icon host would otherwise see the phone's IP next to a token. */
export function iconUrl(src: string | undefined): string | undefined {
  if (!src || !src.startsWith("https://")) return undefined;
  return `${RELAY}/img?u=${encodeURIComponent(src)}`;
}
