import { constants, createPrivateKey, createPublicKey, privateDecrypt, publicEncrypt, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { RSABSSA } from "@cloudflare/blindrsa-ts";
import { secretPathProblem } from "./keypath.ts";

// Credits mint, RFC 9474 RSABSSA-SHA384-PSS-Randomized (CREDITS_CONTRACT.md v1.3).
//
// Verification and all client-side math (prepare, blind, finalize) come from
// @cloudflare/blindrsa-ts. The one server step, BlindSign, is RSASP1 followed by
// the RSAVP1 check (RFC 9474 section 4.3). On Node the library would do it in
// pure-JS bignums (~0.5 s per credit on the event loop, no CRT or RSA blinding);
// its fast path hands the raw RSA operation to the platform, which is what this
// does with Node's OpenSSL.

const suite = RSABSSA.SHA384.PSS.Randomized();

/** One credit, in zatoshis. */
export const CREDIT_ZAT = 100_000n;
/** A token message as the server sees it: 32-byte randomizer || 32 random bytes from the device. */
export const TOKEN_MSG_BYTES = 64;
const MIN_MODULUS_BITS = 2048;

export class Mint {
  readonly keyId: string;
  readonly publicKeySpkiB64: string;
  /** Modulus length in bytes: the size of every blinded message and signature. */
  readonly kLen: number;
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;
  private readonly modulus: Buffer;
  private readonly verifyKey: CryptoKey;

  private constructor(keyId: string, privateKey: KeyObject, verifyKey: CryptoKey) {
    this.keyId = keyId;
    this.privateKey = privateKey;
    this.publicKey = createPublicKey(privateKey);
    const jwk = this.publicKey.export({ format: "jwk" });
    this.modulus = Buffer.from(jwk.n!, "base64url");
    this.kLen = this.modulus.length;
    this.publicKeySpkiB64 = (this.publicKey.export({ format: "der", type: "spki" }) as Buffer).toString("base64");
    this.verifyKey = verifyKey;
  }

  /** Loads the key file; throws when it is missing, unreadable, not a valid mint key, or in a code location (keypath.ts). */
  static load(pemPath: string, keyId: string): Promise<Mint> {
    const problem = secretPathProblem(pemPath);
    if (problem) throw new Error(`mint key path refused: ${problem}`);
    return Mint.fromPem(readFileSync(pemPath, "utf8"), keyId);
  }

  static async fromPem(pem: string, keyId: string): Promise<Mint> {
    const privateKey = createPrivateKey(pem);
    const details = privateKey.asymmetricKeyDetails;
    if (privateKey.asymmetricKeyType !== "rsa" || !details?.modulusLength || details.modulusLength < MIN_MODULUS_BITS) {
      throw new Error(`mint key must be RSA with at least ${MIN_MODULUS_BITS} bits`);
    }
    if (details.publicExponent !== 65537n) throw new Error("mint key public exponent must be 65537");
    const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" });
    const verifyKey = await crypto.subtle.importKey("spki", spki, { name: "RSA-PSS", hash: "SHA-384" }, true, ["verify"]);
    return new Mint(keyId, privateKey, verifyKey);
  }

  /** RFC 9474 BlindSign. Throws on a blinded message of the wrong size or not below the modulus. */
  blindSign(blinded: Uint8Array): Buffer {
    const m = Buffer.from(blinded);
    if (m.length !== this.kLen || Buffer.compare(m, this.modulus) >= 0) throw new Error("blinded message out of range");
    const s = privateDecrypt({ key: this.privateKey, padding: constants.RSA_NO_PADDING }, m);
    // Step 3-4: m' = RSAVP1(pk, s); a mismatch means a faulty signature, never release it.
    const check = publicEncrypt({ key: this.publicKey, padding: constants.RSA_NO_PADDING }, s);
    if (!check.equals(m)) throw new Error("signing failure");
    return s;
  }

  /** True when `sig` is a valid RSABSSA-SHA384-PSS-Randomized signature on the prepared `msg`. */
  async verify(msg: Uint8Array, sig: Uint8Array): Promise<boolean> {
    if (msg.length !== TOKEN_MSG_BYTES || sig.length !== this.kLen) return false;
    try {
      // Plain copies: the library reads `.slice().buffer`, which for a Node Buffer is
      // the whole shared allocation pool, not these bytes.
      return await suite.verify(this.verifyKey, new Uint8Array(sig), new Uint8Array(msg));
    } catch {
      return false;
    }
  }
}

/** Strict standard base64 (padded, no whitespace) to bytes, else null. */
/**
 * The startup mint: null when MINT_KEY_PATH is empty, or when the key cannot be
 * loaded. A bad key never stops the worker; the order API and payouts keep
 * running, /mint/* answers 503 mint_unavailable, and the cause is logged loudly.
 */
export async function startMint(pemPath: string, keyId: string, log: (line: string) => void = console.error): Promise<Mint | null> {
  if (!pemPath) {
    log("mint disabled: MINT_KEY_PATH not set");
    return null;
  }
  try {
    const mint = await Mint.load(pemPath, keyId);
    log(`mint key ${mint.keyId} loaded (${mint.kLen * 8} bits)`);
    return mint;
  } catch (e) {
    log(`!!! MINT UNAVAILABLE: cannot load MINT_KEY_PATH=${pemPath}: ${(e as Error).message}`);
    log("!!! /mint/* and credit spends answer 503 mint_unavailable until the key is fixed and the worker restarted");
    return null;
  }
}

export function b64(s: unknown): Buffer | null {
  if (typeof s !== "string" || s.length === 0 || s.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return null;
  const buf = Buffer.from(s, "base64");
  return buf.toString("base64") === s ? buf : null;
}
