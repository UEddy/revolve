// Burners: one fresh ed25519 key per position. The seed only ever exists
// inside the vault (encrypted at rest) and in memory while it is unlocked.

import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import { b64, fromB64, random } from "./bytes.ts";

export type BurnerKey = { pub: string; seed: string };

export function newBurner(): BurnerKey {
  const seed = random(32);
  const key = { pub: base58.encode(ed25519.getPublicKey(seed)), seed: b64(seed) };
  seed.fill(0);
  return key;
}

export function pubkeyBytes(pub: string): Uint8Array {
  return base58.decode(pub);
}

/** Signs with the burner's seed. Checks the seed still matches the address it was filed under. */
export function signWith(key: BurnerKey, message: Uint8Array): Uint8Array {
  const seed = fromB64(key.seed);
  try {
    if (base58.encode(ed25519.getPublicKey(seed)) !== key.pub) throw new Error("burner key does not match its address");
    return ed25519.sign(message, seed);
  } finally {
    seed.fill(0);
  }
}
