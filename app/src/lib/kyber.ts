// Swaps on Base through KyberSwap's aggregator, always via the relay. The
// phone builds and signs each swap for its own wallet; KyberSwap only quotes
// and encodes the route. The router the transaction goes to is pinned: an
// answer naming any other contract is refused before anything is signed.

import { getAddress } from "viem";
import { RELAY } from "./config.ts";

/** KyberSwap's MetaAggregationRouterV2 (the same address on every chain it supports). */
export const KYBER_ROUTER = "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5";
/** 1%: memecoins move while the transaction is in flight. */
const SLIPPAGE_BPS = 100;

export type RouteSummary = { tokenIn: string; amountIn: string; amountInUsd?: string; tokenOut: string; amountOut: string; amountOutUsd?: string } & Record<string, unknown>;

type KyberReply<T> = { code?: number; message?: string; data?: T };

async function kyber<T>(query: Record<string, string>, init?: RequestInit): Promise<T> {
  const res = await fetch(`${RELAY}/kyber?${new URLSearchParams(query)}`, { credentials: "omit", ...init });
  let body: KyberReply<T> | null = null;
  try {
    body = (await res.json()) as KyberReply<T>;
  } catch {}
  if (!res.ok || !body || body.code !== 0 || !body.data) {
    throw new Error(body?.message ? `No route on Base: ${body.message}` : `Base swaps unavailable (${res.status})`);
  }
  return body.data;
}

function checkRouter(addr: unknown): string {
  if (typeof addr !== "string" || getAddress(addr) !== KYBER_ROUTER) throw new Error("The swap service named an unexpected contract; nothing was signed.");
  return KYBER_ROUTER;
}

/** A quote: how much of `tokenOut` for `amountIn` of `tokenIn` (base units), with KyberSwap's USD values. */
export async function kyberRoute(tokenIn: string, tokenOut: string, amountIn: bigint): Promise<RouteSummary> {
  const d = await kyber<{ routeSummary?: RouteSummary; routerAddress?: string }>({ path: "routes", tokenIn, tokenOut, amountIn: amountIn.toString() });
  if (!d.routeSummary) throw new Error("No route on Base for this trade right now");
  checkRouter(d.routerAddress);
  return d.routeSummary;
}

/** Encodes a quoted route as a transaction from and to `wallet`. */
export async function kyberBuild(summary: RouteSummary, wallet: string): Promise<{ to: string; data: `0x${string}`; value: bigint; amountOut: string }> {
  const d = await kyber<{ data?: string; routerAddress?: string; transactionValue?: string; amountOut?: string }>(
    { path: "route/build" },
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ routeSummary: summary, sender: wallet, recipient: wallet, slippageTolerance: SLIPPAGE_BPS }),
    },
  );
  if (typeof d.data !== "string" || !/^0x[0-9a-fA-F]*$/.test(d.data)) throw new Error("The swap service sent a malformed transaction");
  return {
    to: checkRouter(d.routerAddress),
    data: d.data as `0x${string}`,
    value: BigInt(d.transactionValue ?? "0"),
    amountOut: d.amountOut ?? summary.amountOut,
  };
}
