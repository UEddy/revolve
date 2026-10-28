// Passkey with the WebAuthn PRF extension. The PRF output never leaves this
// module except as a non-extractable AES key (vault.ts). No user name, no
// email: the passkey is labelled "Revolve vault" and its user id is random.

import { b64url, fromB64url, random, utf8 } from "./bytes.ts";

export class PrfUnsupported extends Error {
  constructor(detail: string) {
    super(`This phone's passkeys cannot derive an encryption key (${detail}). Revolve needs Android Chrome or a recent iPhone.`);
  }
}

let saltCache: Uint8Array<ArrayBuffer> | null = null;
async function prfSalt(): Promise<Uint8Array<ArrayBuffer>> {
  saltCache ??= new Uint8Array(await crypto.subtle.digest("SHA-256", utf8.encode("revolve/vault/prf-salt/v1")));
  return saltCache;
}

/** How long a passkey prompt may stay open; creating one can take longer (choosing where to save it). */
const PASSKEY_WAIT_MS = 60_000;
const CREATE_WAIT_MS = 120_000;

/** A passkey call that never answered: called off so the screen can offer a retry. */
export class PasskeyTimeout extends Error {
  constructor() {
    super("Your passkey didn't answer. Try again.");
  }
}

/**
 * Runs a WebAuthn call that is called off after `ms`. Some phones never settle
 * the call after the fingerprint, which left Unlock spinning; this turns that
 * into an error the user can retry, and the abort frees the browser's one
 * pending passkey request so the retry isn't refused.
 */
export async function withPasskeyTimeout<T>(call: (signal: AbortSignal) => Promise<T>, ms = PASSKEY_WAIT_MS): Promise<T> {
  const ctl = new AbortController();
  const timedOut = new Promise<never>((_, reject) => ctl.signal.addEventListener("abort", () => reject(new PasskeyTimeout()), { once: true }));
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    // Raced, so a call that ignores the abort still can't hold the screen.
    return await Promise.race([call(ctl.signal), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

export function passkeysAvailable(): boolean {
  return typeof window !== "undefined" && window.isSecureContext && typeof PublicKeyCredential !== "undefined";
}

type PrfExt = { prf?: { enabled?: boolean; results?: { first?: BufferSource } } };

function firstOutput(ext: PrfExt): Uint8Array<ArrayBuffer> | null {
  const first = ext.prf?.results?.first;
  if (!first) return null;
  const bytes = first instanceof ArrayBuffer ? new Uint8Array(first) : new Uint8Array(first.buffer, first.byteOffset, first.byteLength).slice();
  return bytes.length === 32 ? bytes : null;
}

/** Creates the vault passkey. Returns its id, and the PRF output when the authenticator gives one at creation. */
export async function createPasskey(): Promise<{ credId: string; prf: Uint8Array<ArrayBuffer> | null }> {
  if (!passkeysAvailable()) throw new PrfUnsupported("no passkey support in this browser");
  const salt = await prfSalt();
  const cred = (await withPasskeyTimeout((signal) => navigator.credentials.create({
    signal,
    publicKey: {
      timeout: CREATE_WAIT_MS,
      rp: { name: "Revolve" },
      user: { id: random(16), name: "Revolve vault", displayName: "Revolve vault" },
      challenge: random(32),
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      attestation: "none",
      extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
    },
  }), CREATE_WAIT_MS)) as PublicKeyCredential | null;
  if (!cred) throw new Error("Passkey creation was cancelled");
  const ext = cred.getClientExtensionResults() as PrfExt;
  if (ext.prf?.enabled === false || ext.prf === undefined) throw new PrfUnsupported("PRF not enabled on the new passkey");
  return { credId: b64url(new Uint8Array(cred.rawId)), prf: firstOutput(ext) };
}

/** Asks the passkey for the vault's PRF output. `credId` null lets the phone offer any Revolve passkey. */
export async function evalPrf(credId: string | null): Promise<{ credId: string; prf: Uint8Array<ArrayBuffer> }> {
  if (!passkeysAvailable()) throw new PrfUnsupported("no passkey support in this browser");
  const salt = await prfSalt();
  const assertion = (await withPasskeyTimeout((signal) => navigator.credentials.get({
    signal,
    publicKey: {
      timeout: PASSKEY_WAIT_MS,
      challenge: random(32),
      userVerification: "required",
      allowCredentials: credId ? [{ type: "public-key", id: fromB64url(credId) as Uint8Array<ArrayBuffer> }] : [],
      extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
    },
  }))) as PublicKeyCredential | null;
  if (!assertion) throw new Error("Unlock was cancelled");
  const prf = firstOutput(assertion.getClientExtensionResults() as PrfExt);
  if (!prf) throw new PrfUnsupported("the passkey returned no PRF output");
  return { credId: b64url(new Uint8Array(assertion.rawId)), prf };
}

/** Flags byte of WebAuthn authenticatorData: user present (bit 0) and user verified (bit 2). */
export function assertionFlags(authenticatorData: ArrayBuffer | Uint8Array): { up: boolean; uv: boolean } {
  const d = authenticatorData instanceof Uint8Array ? authenticatorData : new Uint8Array(authenticatorData);
  const flags = d[32];
  if (flags === undefined) throw new Error("authenticator data too short");
  return { up: (flags & 0x01) !== 0, uv: (flags & 0x04) !== 0 };
}

/**
 * A fresh "is it really you" check with the vault's own passkey, user
 * verification required. Used before credits leave the vault. Refuses an
 * assertion from another passkey or one without the user-verified flag.
 */
export async function confirmUser(credId: string): Promise<void> {
  if (!passkeysAvailable()) throw new PrfUnsupported("no passkey support in this browser");
  const cred = (await withPasskeyTimeout((signal) => navigator.credentials.get({
    signal,
    publicKey: {
      timeout: PASSKEY_WAIT_MS,
      challenge: random(32),
      userVerification: "required",
      allowCredentials: [{ type: "public-key", id: fromB64url(credId) as Uint8Array<ArrayBuffer> }],
    },
  }))) as PublicKeyCredential | null;
  if (!cred) throw new Error("Confirmation was cancelled");
  if (b64url(new Uint8Array(cred.rawId)) !== credId) throw new Error("That was a different passkey");
  const { uv } = assertionFlags((cred.response as AuthenticatorAssertionResponse).authenticatorData);
  if (!uv) throw new Error("The passkey did not verify you (no fingerprint, face or PIN)");
}
