// Base wallets (API_CONTRACT.md v1.4): one fresh secp256k1 key per position,
// kept in the vault like a Solana burner, and Base JSON-RPC through the relay
// (one call per request) so the RPC never sees the phone's IP.

import { decodeFunctionResult, encodeFunctionData, erc20Abi, getAddress, isAddress, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { RELAY } from "./config.ts";
import { b64, fromB64, random } from "./bytes.ts";
import type { BurnerKey } from "./burner.ts";

export const BASE_CHAIN_ID = 8453;
/** KyberSwap's stand-in address for native ETH. */
export const NATIVE_ETH = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
/** Wei kept in a Base wallet after the buy: gas for an approval and a sale later. */
export const BASE_RESERVE_WEI = 20_000_000_000_000n;
const RECEIPT_WAIT_MS = 90_000;

const hexKey = (seed: Uint8Array): Hex => toHex(seed);

/** A fresh Base wallet. `pub` is its EIP-55 checksummed address; `seed` the 32-byte private key, base64. */
export function newEvmBurner(): BurnerKey {
  for (;;) {
    const seed = random(32);
    try {
      const key = { pub: privateKeyToAccount(hexKey(seed)).address, seed: b64(seed) };
      return key;
    } catch {
      // Outside the curve order (about 1 in 2^128): draw again.
    } finally {
      seed.fill(0);
    }
  }
}

/** The signing account, checked against the address the key was filed under. */
function account(key: BurnerKey) {
  const seed = fromB64(key.seed);
  try {
    const acct = privateKeyToAccount(hexKey(seed));
    if (acct.address !== key.pub) throw new Error("wallet key does not match its address");
    return acct;
  } finally {
    seed.fill(0);
  }
}

/** The private key as 0x hex, for exporting into MetaMask or Rabby. */
export function exportEvmKey(key: BurnerKey): string {
  const seed = fromB64(key.seed);
  const out = hexKey(seed);
  seed.fill(0);
  return out;
}

/** Exactly the checksummed form (what the worker requires in a memo or spend). */
export function isChecksummed(s: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(s) && getAddress(s) === s;
}

/** Any valid address a person might paste: all lowercase, or mixed case with a correct checksum. */
export function isEvmAddress(s: string): boolean {
  return isAddress(s, { strict: true });
}

/** The checksummed form of a pasted address (so it compares equal to stored ones). */
export const checksummed = (s: string): string => getAddress(s);

let nextId = 1;

export async function baseRpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(`${RELAY}/base-rpc`, {
    method: "POST",
    credentials: "omit",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  if (!res.ok) throw new Error(`Base network busy (${res.status})`);
  const body = (await res.json()) as { result?: T; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message ?? "Base network error");
  return body.result as T;
}

export async function ethBalance(owner: string): Promise<bigint> {
  return BigInt(await baseRpc<string>("eth_getBalance", [owner, "latest"]));
}

async function call(to: string, data: Hex): Promise<Hex> {
  return baseRpc<Hex>("eth_call", [{ to, data }, "latest"]);
}

export async function erc20Balance(token: string, owner: string): Promise<bigint> {
  const out = await call(token, encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [owner as Hex] }));
  return decodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", data: out });
}

export async function erc20Allowance(token: string, owner: string, spender: string): Promise<bigint> {
  const out = await call(token, encodeFunctionData({ abi: erc20Abi, functionName: "allowance", args: [owner as Hex, spender as Hex] }));
  return decodeFunctionResult({ abi: erc20Abi, functionName: "allowance", data: out });
}

/** A token's own name, symbol and decimals, read from its contract (for a pasted address). */
export async function tokenMeta(token: string): Promise<{ name: string; symbol: string; decimals: number }> {
  const [name, symbol, decimals] = await Promise.all([
    call(token, encodeFunctionData({ abi: erc20Abi, functionName: "name" })).then((data) => decodeFunctionResult({ abi: erc20Abi, functionName: "name", data })),
    call(token, encodeFunctionData({ abi: erc20Abi, functionName: "symbol" })).then((data) => decodeFunctionResult({ abi: erc20Abi, functionName: "symbol", data })),
    call(token, encodeFunctionData({ abi: erc20Abi, functionName: "decimals" })).then((data) => decodeFunctionResult({ abi: erc20Abi, functionName: "decimals", data })),
  ]);
  return { name, symbol, decimals };
}

export const erc20Transfer = (to: string, amount: bigint): Hex =>
  encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to as Hex, amount] });

export const erc20Approve = (spender: string, amount: bigint): Hex =>
  encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender as Hex, amount] });

/** Sent, but no receipt within the wait: it may still land. Never send it again blindly. */
export class UnconfirmedEvm extends Error {
  readonly hash: string;
  constructor(hash: string) {
    super("Sent, but not confirmed yet. Check the wallet before trying again.");
    this.hash = hash;
  }
}

/** The fee for a plain transfer at current prices, with headroom: what "send everything" leaves behind. */
export async function transferFee(): Promise<bigint> {
  const { maxFee } = await fees();
  return 21_000n * maxFee;
}

async function fees(): Promise<{ maxFee: bigint; tip: bigint }> {
  const [block, tipHex] = await Promise.all([
    baseRpc<{ baseFeePerGas?: string }>("eth_getBlockByNumber", ["latest", false]),
    baseRpc<string>("eth_maxPriorityFeePerGas", []),
  ]);
  const tip = BigInt(tipHex);
  return { maxFee: BigInt(block.baseFeePerGas ?? "0") * 2n + tip, tip };
}

/**
 * Signs on the device and sends one transaction from a position's wallet,
 * then waits for its receipt. Throws if it reverted; UnconfirmedEvm if no
 * receipt came in time.
 */
export async function sendTx(key: BurnerKey, tx: { to: string; data?: Hex; value?: bigint; gas?: bigint }): Promise<string> {
  const acct = account(key);
  const value = tx.value ?? 0n;
  const [nonceHex, { maxFee, tip }] = await Promise.all([baseRpc<string>("eth_getTransactionCount", [acct.address, "pending"]), fees()]);
  const gas =
    tx.gas ??
    (BigInt(await baseRpc<string>("eth_estimateGas", [{ from: acct.address, to: tx.to, data: tx.data ?? "0x", value: toHex(value) }])) * 12n) / 10n;
  const raw = await acct.signTransaction({
    type: "eip1559",
    chainId: BASE_CHAIN_ID,
    to: tx.to as Hex,
    data: tx.data,
    value,
    nonce: Number(BigInt(nonceHex)),
    gas,
    maxFeePerGas: maxFee,
    maxPriorityFeePerGas: tip,
  });
  const hash = await baseRpc<string>("eth_sendRawTransaction", [raw]);
  const until = Date.now() + RECEIPT_WAIT_MS;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 2_000));
    const receipt = await baseRpc<{ status?: string } | null>("eth_getTransactionReceipt", [hash]).catch(() => null);
    if (receipt?.status === "0x1") return hash;
    if (receipt?.status === "0x0") throw new Error("The transaction failed on Base; nothing was spent but gas.");
  }
  throw new UnconfirmedEvm(hash);
}
