// The burner vault: VaultData sealed with AES-256-GCM under a key derived
// (HKDF-SHA256) from the passkey's PRF output. Only the sealed blob and the
// passkey's credential id are stored, in this browser's local storage.
// Nothing about the vault ever reaches a server.

import { fromB64, b64, fromUtf8, random, utf8 } from "./bytes.ts";
import type { VaultData } from "./model.ts";

export type Sealed = { v: 1; credId: string; iv: string; ct: string };

const STORE_KEY = "revolve.vault.v1";

export async function deriveVaultKey(prf: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey("raw", prf, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: utf8.encode("revolve"), info: utf8.encode("revolve/vault/aes-gcm/v1") },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

const aad = (credId: string) => utf8.encode(`revolve-vault|v1|${credId}`);

export async function seal(key: CryptoKey, credId: string, data: VaultData): Promise<Sealed> {
  const iv = random(12);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(credId) }, key, utf8.encode(JSON.stringify(data)));
  return { v: 1, credId, iv: b64(iv), ct: b64(new Uint8Array(ct)) };
}

export class WrongPasskey extends Error {
  constructor() {
    super("That passkey does not open this vault");
  }
}

export async function unseal(key: CryptoKey, sealed: Sealed): Promise<VaultData> {
  let pt: ArrayBuffer;
  try {
    pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromB64(sealed.iv) as Uint8Array<ArrayBuffer>, additionalData: aad(sealed.credId) },
      key,
      fromB64(sealed.ct) as Uint8Array<ArrayBuffer>,
    );
  } catch {
    throw new WrongPasskey();
  }
  const data = JSON.parse(fromUtf8.decode(pt)) as VaultData;
  if (data.v !== 1 || !Array.isArray(data.positions)) throw new Error("vault format not recognised");
  return data;
}

export function isSealed(x: unknown): x is Sealed {
  const s = x as Sealed;
  return !!s && s.v === 1 && typeof s.credId === "string" && typeof s.iv === "string" && typeof s.ct === "string";
}

/** Local storage access, wrapped so a blocked or full storage surfaces as an error the screen can show. */
export const store = {
  load(): Sealed | null {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isSealed(parsed)) throw new Error("stored vault is damaged");
    return parsed;
  },
  save(sealed: Sealed): void {
    localStorage.setItem(STORE_KEY, JSON.stringify(sealed));
  },
  clear(): void {
    localStorage.removeItem(STORE_KEY);
  },
};
