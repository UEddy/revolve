// Buying, selling and sending from a Base position's own wallet. Everything is
// signed on the device; the chain is the record, so a lost answer never leads
// to buying twice (the engine checks the token balance first, as on Solana).

import { BASE_RESERVE_WEI, NATIVE_ETH, erc20Allowance, erc20Approve, erc20Balance, erc20Transfer, ethBalance, sendTx, transferFee } from "./evm.ts";
import { KYBER_ROUTER, kyberBuild, kyberRoute } from "./kyber.ts";
import type { Position } from "./model.ts";
import { NotFunded, type SwapOutcome } from "./swap.ts";

export function baseFundedEnough(wei: bigint): boolean {
  return wei > BASE_RESERVE_WEI;
}

/** Spends the payout on the chosen token, keeping BASE_RESERVE_WEI for gas and a later sale. */
export async function buyBase(p: Position): Promise<SwapOutcome> {
  const bal = await ethBalance(p.burner.pub);
  if (!baseFundedEnough(bal)) throw new NotFunded();
  const amount = bal - BASE_RESERVE_WEI;
  const route = await kyberRoute(NATIVE_ETH, p.token.mint, amount);
  const tx = await kyberBuild(route, p.burner.pub);
  // The transaction may only spend what was asked: never the reserve.
  if (tx.value !== amount) throw new Error("The swap service asked for a different amount; nothing was signed.");
  const hash = await sendTx(p.burner, tx);
  return { sig: hash, inAmount: amount.toString(), outAmount: tx.amountOut };
}

/** Sells the whole position back to ETH in the same wallet: an approval first if the router can't spend it yet. */
export async function sellBaseAll(p: Position): Promise<SwapOutcome> {
  const raw = await erc20Balance(p.token.mint, p.burner.pub);
  if (raw <= 0n) throw new Error("Nothing to sell");
  if ((await erc20Allowance(p.token.mint, p.burner.pub, KYBER_ROUTER)) < raw) {
    await sendTx(p.burner, { to: p.token.mint, data: erc20Approve(KYBER_ROUTER, raw) });
  }
  const route = await kyberRoute(p.token.mint, NATIVE_ETH, raw);
  const tx = await kyberBuild(route, p.burner.pub);
  if (tx.value !== 0n) throw new Error("The swap service asked for ETH on a sale; nothing was signed.");
  const hash = await sendTx(p.burner, tx);
  return { sig: hash, inAmount: raw.toString(), outAmount: tx.amountOut };
}

/** Sends the whole token balance to `to`. */
export async function sendAllBaseToken(p: Position, to: string): Promise<string> {
  const raw = await erc20Balance(p.token.mint, p.burner.pub);
  if (raw <= 0n) throw new Error("Nothing to send");
  return sendTx(p.burner, { to: p.token.mint, data: erc20Transfer(to, raw) });
}

/** Sends all the ETH but the fee of this one transfer. */
export async function sendAllBaseEth(p: Position, to: string): Promise<string> {
  const [bal, fee] = await Promise.all([ethBalance(p.burner.pub), transferFee()]);
  if (bal <= fee) throw new Error("Not enough ETH to cover the network fee");
  return sendTx(p.burner, { to, value: bal - fee, gas: 21_000n });
}

/** USD per whole token, from KyberSwap's valuation of selling one token for ETH; null without a route. */
export async function baseUsdPrice(token: { mint: string; decimals: number }): Promise<number | null> {
  try {
    const r = await kyberRoute(token.mint, NATIVE_ETH, 10n ** BigInt(token.decimals));
    const usd = Number(r.amountInUsd);
    return Number.isFinite(usd) && usd > 0 ? usd : null;
  } catch {
    return null;
  }
}
