// Solana JSON-RPC through the relay, one call per request.

import { RELAY } from "./config.ts";

let nextId = 1;

export async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(`${RELAY}/rpc`, {
    method: "POST",
    credentials: "omit",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  if (!res.ok) throw new Error(`network busy (${res.status})`);
  const body = (await res.json()) as { result?: T; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message ?? "network error");
  return body.result as T;
}

export async function lamports(owner: string): Promise<bigint> {
  const r = await rpc<{ value: number }>("getBalance", [owner, { commitment: "confirmed" }]);
  return BigInt(r.value);
}

type ParsedAccounts = { value: { account: { data: { parsed: { info: { tokenAmount: { amount: string } } } } } }[] };

/** Raw token amount the owner holds of one mint (works for both token programs: the RPC filters by mint). */
export async function tokenRaw(owner: string, mint: string): Promise<bigint> {
  const r = await rpc<ParsedAccounts>("getTokenAccountsByOwner", [owner, { mint }, { encoding: "jsonParsed", commitment: "confirmed" }]);
  return r.value.reduce((sum, a) => sum + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);
}
