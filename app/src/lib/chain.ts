// What differs between a Solana and a Base position, in one place: the cash
// the wallet holds besides the asset, and where its transactions are shown.

import { ETH_MINT, SOL_MINT } from "./config.ts";
import type { Position } from "./model.ts";

/** The wallet's own coin: SOL (9 decimals) on Solana, ETH (18) on Base. `mint` keys its price. */
export function cashOf(p: Pick<Position, "chain">): { mint: string; decimals: number; symbol: string } {
  return p.chain === "base" ? { mint: ETH_MINT, decimals: 18, symbol: "ETH" } : { mint: SOL_MINT, decimals: 9, symbol: "SOL" };
}

export function txUrl(p: Pick<Position, "chain">, sig: string): string {
  return p.chain === "base" ? `https://basescan.org/tx/${sig}` : `https://solscan.io/tx/${sig}`;
}

export function chainName(p: Pick<Position, "chain">): string {
  return p.chain === "base" ? "Base" : "Solana";
}
