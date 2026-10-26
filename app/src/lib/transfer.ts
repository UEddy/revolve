// Builds the two transfers the app needs (cash, or a whole token balance
// to one address) as legacy transactions, without a full Solana SDK.

import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import { utf8, b64 } from "./bytes.ts";
import { compactU16, signTx } from "./tx.ts";
import { pubkeyBytes, signWith, type BurnerKey } from "./burner.ts";
import { rpc } from "./solana.ts";

export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const FEE_LAMPORTS = 5_000n;

type Meta = { key: string; signer: boolean; writable: boolean };
export type Ix = { program: string; accounts: Meta[]; data: Uint8Array };

function u64le(n: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, n, true);
  return out;
}

/** Compiles instructions into a legacy message: signers first, writable before read-only, payer at 0. */
export function compileMessage(payer: string, ixs: Ix[], blockhash: string): Uint8Array {
  const metas = new Map<string, Meta>([[payer, { key: payer, signer: true, writable: true }]]);
  const add = (m: Meta) => {
    const prev = metas.get(m.key);
    metas.set(m.key, prev ? { key: m.key, signer: prev.signer || m.signer, writable: prev.writable || m.writable } : { ...m });
  };
  for (const ix of ixs) {
    ix.accounts.forEach(add);
    add({ key: ix.program, signer: false, writable: false });
  }
  const rank = (m: Meta) => (m.key === payer ? -1 : (m.signer ? 0 : 2) + (m.writable ? 0 : 1));
  const keys = [...metas.values()].map((m, i) => ({ m, i })).sort((a, b) => rank(a.m) - rank(b.m) || a.i - b.i).map(({ m }) => m);
  const index = new Map(keys.map((m, i) => [m.key, i]));
  const header = [
    keys.filter((m) => m.signer).length,
    keys.filter((m) => m.signer && !m.writable).length,
    keys.filter((m) => !m.signer && !m.writable).length,
  ];
  const parts: number[] = [...header, ...compactU16(keys.length)];
  for (const m of keys) parts.push(...pubkeyBytes(m.key));
  parts.push(...base58.decode(blockhash));
  parts.push(...compactU16(ixs.length));
  for (const ix of ixs) {
    parts.push(index.get(ix.program)!, ...compactU16(ix.accounts.length), ...ix.accounts.map((a) => index.get(a.key)!));
    parts.push(...compactU16(ix.data.length), ...ix.data);
  }
  return Uint8Array.from(parts);
}

export function unsignedTx(message: Uint8Array, signers: number): Uint8Array {
  return Uint8Array.from([...compactU16(signers), ...new Uint8Array(64 * signers), ...message]);
}

function onCurve(bytes: Uint8Array): boolean {
  try {
    ed25519.Point.fromBytes(bytes);
    return true;
  } catch {
    return false;
  }
}

/** Program derived address, as Solana's find_program_address. */
export async function findPda(seeds: Uint8Array[], program: string): Promise<string> {
  const prog = pubkeyBytes(program);
  for (let bump = 255; bump >= 0; bump--) {
    const buf = Uint8Array.from([...seeds.flatMap((s) => [...s]), bump, ...prog, ...utf8.encode("ProgramDerivedAddress")]);
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
    if (!onCurve(hash)) return base58.encode(hash);
  }
  throw new Error("no program address");
}

export function ata(owner: string, mint: string, tokenProgram: string): Promise<string> {
  return findPda([pubkeyBytes(owner), pubkeyBytes(tokenProgram), pubkeyBytes(mint)], ATA_PROGRAM);
}

export function cashIx(from: string, to: string, lamports: bigint): Ix {
  return {
    program: SYSTEM_PROGRAM,
    accounts: [
      { key: from, signer: true, writable: true },
      { key: to, signer: false, writable: true },
    ],
    data: Uint8Array.from([2, 0, 0, 0, ...u64le(lamports)]),
  };
}

export async function tokenIxs(from: string, to: string, mint: string, tokenProgram: string, source: string, raw: bigint, decimals: number): Promise<Ix[]> {
  const dest = await ata(to, mint, tokenProgram);
  return [
    {
      program: ATA_PROGRAM,
      accounts: [
        { key: from, signer: true, writable: true },
        { key: dest, signer: false, writable: true },
        { key: to, signer: false, writable: false },
        { key: mint, signer: false, writable: false },
        { key: SYSTEM_PROGRAM, signer: false, writable: false },
        { key: tokenProgram, signer: false, writable: false },
      ],
      data: Uint8Array.from([1]), // CreateIdempotent
    },
    {
      program: tokenProgram,
      accounts: [
        { key: source, signer: false, writable: true },
        { key: mint, signer: false, writable: false },
        { key: dest, signer: false, writable: true },
        { key: from, signer: true, writable: false },
      ],
      data: Uint8Array.from([12, ...u64le(raw), decimals]), // TransferChecked
    },
  ];
}

async function submit(key: BurnerKey, ixs: Ix[]): Promise<string> {
  const { value } = await rpc<{ value: { blockhash: string } }>("getLatestBlockhash", [{ commitment: "confirmed" }]);
  const tx = unsignedTx(compileMessage(key.pub, ixs, value.blockhash), 1);
  const signed = signTx(tx, pubkeyBytes(key.pub), (m) => signWith(key, m));
  const sig = await rpc<string>("sendTransaction", [b64(signed), { encoding: "base64", preflightCommitment: "confirmed" }]);
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2_000));
    const st = await rpc<{ value: ({ err: unknown; confirmationStatus?: string } | null)[] }>("getSignatureStatuses", [[sig]]);
    const s = st.value[0];
    if (s?.err) throw new Error("The transfer failed on chain");
    if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) return sig;
  }
  throw new Error("The transfer was sent but not confirmed yet. Check again in a minute.");
}

type TokenAccounts = { value: { pubkey: string; account: { owner: string; data: { parsed: { info: { tokenAmount: { amount: string; decimals: number } } } } } }[] };

/** Sends the burner's whole balance of `mint` to `to`. Fees come from the burner's cash. */
export async function sendAllToken(key: BurnerKey, mint: string, to: string): Promise<string> {
  const r = await rpc<TokenAccounts>("getTokenAccountsByOwner", [key.pub, { mint }, { encoding: "jsonParsed", commitment: "confirmed" }]);
  const acct = r.value.find((a) => BigInt(a.account.data.parsed.info.tokenAmount.amount) > 0n);
  if (!acct) throw new Error("Nothing to send");
  const info = acct.account.data.parsed.info.tokenAmount;
  return submit(key, await tokenIxs(key.pub, to, mint, acct.account.owner, acct.pubkey, BigInt(info.amount), info.decimals));
}

/** Sends all cash except the network fee. */
export async function sendAllCash(key: BurnerKey, to: string, balance: bigint): Promise<string> {
  const amount = balance - FEE_LAMPORTS;
  if (amount <= 0n) throw new Error("Nothing to send");
  return submit(key, [cashIx(key.pub, to, amount)]);
}
