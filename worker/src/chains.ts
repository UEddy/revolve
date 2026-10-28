import { getAddress } from "viem";
import { isValidBurner } from "./orders.ts";

// Payout chains (API_CONTRACT.md v1.4). Solana stays the default everywhere:
// a request, memo or row without a chain means Solana.

export const CHAINS = ["solana", "base"] as const;
export type Chain = (typeof CHAINS)[number];

export const isChain = (s: unknown): s is Chain => typeof s === "string" && (CHAINS as readonly string[]).includes(s);

/** The response field that carries the payout amount: lamports on Solana, wei on EVM chains. */
export const payoutField = (chain: Chain) => (chain === "solana" ? "payout_lamports" : "payout_wei");

const ZERO = "0x0000000000000000000000000000000000000000";

/** An EVM recipient must be exactly its EIP-55 checksummed form and never the zero address. */
export function isEvmAddress(s: string): boolean {
  if (!/^0x[0-9a-fA-F]{40}$/.test(s) || s === ZERO) return false;
  try {
    return getAddress(s) === s;
  } catch {
    return false;
  }
}

export function isValidRecipient(chain: Chain, s: string): boolean {
  return chain === "solana" ? isValidBurner(s) : isEvmAddress(s);
}
