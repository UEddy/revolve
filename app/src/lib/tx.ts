// Signs a serialized Solana transaction (legacy or v0) in place of a full
// SDK: Jupiter hands us the bytes, we only need to find our signer slot,
// sign the message and write the signature there.

import { equal } from "./bytes.ts";

export function readCompactU16(buf: Uint8Array, offset: number): [value: number, size: number] {
  let value = 0;
  for (let size = 0; size < 3; size++) {
    const b = buf[offset + size];
    if (b === undefined) throw new Error("transaction truncated");
    value |= (b & 0x7f) << (7 * size);
    if ((b & 0x80) === 0) return [value, size + 1];
  }
  throw new Error("bad compact-u16");
}

export function compactU16(n: number): Uint8Array {
  const out: number[] = [];
  let v = n;
  for (;;) {
    const b = v & 0x7f;
    v >>= 7;
    if (v === 0) {
      out.push(b);
      return Uint8Array.from(out);
    }
    out.push(b | 0x80);
  }
}

export type ParsedTx = {
  signatureCount: number;
  signaturesOffset: number;
  message: Uint8Array;
  requiredSigners: Uint8Array[];
};

export function parseTx(tx: Uint8Array): ParsedTx {
  const [signatureCount, countSize] = readCompactU16(tx, 0);
  const signaturesOffset = countSize;
  const message = tx.subarray(signaturesOffset + 64 * signatureCount);
  const first = message[0];
  if (first === undefined) throw new Error("transaction has no message");
  let h = 0;
  if (first & 0x80) {
    if ((first & 0x7f) !== 0) throw new Error(`unsupported transaction version ${first & 0x7f}`);
    h = 1;
  }
  const numRequired = message[h];
  if (numRequired === undefined) throw new Error("transaction truncated");
  const [keyCount, keyCountSize] = readCompactU16(message, h + 3);
  if (numRequired > keyCount || numRequired !== signatureCount) throw new Error("signer count mismatch");
  const keysAt = h + 3 + keyCountSize;
  const requiredSigners: Uint8Array[] = [];
  for (let i = 0; i < numRequired; i++) requiredSigners.push(message.subarray(keysAt + 32 * i, keysAt + 32 * (i + 1)));
  return { signatureCount, signaturesOffset, message, requiredSigners };
}

/** Returns a copy of `tx` with our signature in our slot. Refuses if we are not a required signer. */
export function signTx(tx: Uint8Array, signer: Uint8Array, sign: (message: Uint8Array) => Uint8Array): Uint8Array {
  const parsed = parseTx(tx);
  const index = parsed.requiredSigners.findIndex((k) => equal(k, signer));
  if (index < 0) throw new Error("this wallet is not a signer of the transaction");
  const sig = sign(parsed.message);
  if (sig.length !== 64) throw new Error("bad signature length");
  const out = tx.slice();
  out.set(sig, parsed.signaturesOffset + 64 * index);
  return out;
}
