// The swap from a burner, signed on the device. Jupiter Ultra builds the
// transaction for the burner as taker and lands it; we only sign.

import { b64, fromB64 } from "./bytes.ts";
import { pubkeyBytes, signWith } from "./burner.ts";
import { SOL_MINT, SWAP_RESERVE_LAMPORTS } from "./config.ts";
import { ultraExecute, ultraOrder } from "./jupiter.ts";
import type { Position } from "./model.ts";
import { lamports, tokenRaw } from "./solana.ts";
import { signTx } from "./tx.ts";

export type SwapOutcome = { sig: string; inAmount: string; outAmount: string };

/** The payout is not visible on chain yet: wait, this is not a failed swap. */
export class NotFunded extends Error {
  constructor() {
    super("The payout has not arrived yet");
  }
}

async function run(p: Position, inputMint: string, outputMint: string, amount: bigint): Promise<SwapOutcome> {
  const order = await ultraOrder(inputMint, outputMint, amount, p.burner.pub);
  if (!order.transaction) throw new Error(order.errorMessage || order.error || "No route for this trade right now");
  const signed = signTx(fromB64(order.transaction), pubkeyBytes(p.burner.pub), (m) => signWith(p.burner, m));
  const result = await ultraExecute(b64(signed), order.requestId);
  if (result.status !== "Success" || !result.signature) throw new Error(result.error || "The trade did not go through");
  return { sig: result.signature, inAmount: order.inAmount, outAmount: result.outputAmountResult ?? order.outAmount };
}

/** Spends the payout on the chosen asset, keeping SWAP_RESERVE_LAMPORTS for fees and a later sale. */
export async function buyWithPayout(p: Position): Promise<SwapOutcome> {
  const bal = await lamports(p.burner.pub);
  if (!fundedEnough(bal)) throw new NotFunded();
  return run(p, SOL_MINT, p.token.mint, bal - SWAP_RESERVE_LAMPORTS);
}

/** Sells the whole position back to cash in the same burner (nothing leaves it). */
export async function sellAll(p: Position): Promise<SwapOutcome> {
  const raw = await tokenRaw(p.burner.pub, p.token.mint);
  if (raw <= 0n) throw new Error("Nothing to sell");
  return run(p, p.token.mint, SOL_MINT, raw);
}

export function fundedEnough(bal: bigint): boolean {
  return bal > SWAP_RESERVE_LAMPORTS;
}
