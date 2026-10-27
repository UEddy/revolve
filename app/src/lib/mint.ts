// Credits API client (CREDITS_CONTRACT.md v1.3): the mint key, fundings,
// blind signing, and spending tokens on an order. Plus a dev-only mock that
// runs the real blind-signature maths with a throwaway key.

import { RSABSSA } from "@cloudflare/blindrsa-ts";
import { ORDER_API } from "./config.ts";
import { b64, fromB64 } from "./bytes.ts";
import { call, mock as orderMock, OrderApiError } from "./orders.ts";
import { parseZec } from "./amount.ts";
import { CREDIT_ZATS, type SpendOutcome } from "./credits.ts";
import type { CreditToken, FundingStatus } from "./model.ts";

const ID = /^[A-Za-z0-9_]{8,64}$/;

export type MintKey = { key_id: string; public_key_spki_b64: string; denomination_zec: string };

export async function getMintKey(): Promise<MintKey> {
  const k = import.meta.env.DEV && ORDER_API === "mock" ? await mintMock.key() : await call<MintKey>("/mint/key");
  if (typeof k.key_id !== "string" || !k.key_id || typeof k.public_key_spki_b64 !== "string") throw new OrderApiError("the mint sent a malformed key", 502);
  if (parseZec(k.denomination_zec) !== CREDIT_ZATS) throw new OrderApiError(`unexpected credit size ${k.denomination_zec} ZEC`, 502);
  return k;
}

export type FundQuote = { fund_id: string; deposit_ua: string; amount_zec: string; credits: number; expires_at: string };

export async function createFunding(amountZec: string): Promise<FundQuote> {
  const q = import.meta.env.DEV && ORDER_API === "mock" ? await mintMock.fund(amountZec) : await call<FundQuote>("/mint/orders", { method: "POST", body: JSON.stringify({ amount_zec: amountZec }) });
  const zats = parseZec(amountZec)!;
  if (!ID.test(q.fund_id)) throw new OrderApiError("the mint sent a malformed funding id", 502);
  if (parseZec(q.amount_zec) !== zats) throw new OrderApiError("the mint quoted a different amount than asked", 502);
  if (BigInt(q.credits) * CREDIT_ZATS !== zats) throw new OrderApiError("the mint offered the wrong number of credits", 502);
  if (!/^u1[02-9ac-hj-np-z]{20,}$/.test(q.deposit_ua)) throw new OrderApiError("the mint sent a bad deposit address", 502);
  return q;
}

/** `null` once the server no longer knows the funding. */
export async function getFunding(fundId: string): Promise<{ status: FundingStatus } | null> {
  if (import.meta.env.DEV && ORDER_API === "mock") return mintMock.status(fundId);
  try {
    return await call<{ status: FundingStatus }>(`/mint/orders/${encodeURIComponent(fundId)}`);
  } catch (e) {
    if (e instanceof OrderApiError && e.status === 404) return null;
    throw e;
  }
}

export async function signFunding(fundId: string, blinded: string[]): Promise<string[]> {
  const r = import.meta.env.DEV && ORDER_API === "mock" ? await mintMock.sign(fundId, blinded) : await call<{ signatures: string[] }>(`/mint/orders/${encodeURIComponent(fundId)}/sign`, { method: "POST", body: JSON.stringify({ blinded }) });
  if (!Array.isArray(r.signatures) || r.signatures.some((s) => typeof s !== "string")) throw new OrderApiError("the mint sent malformed signatures", 502);
  return r.signatures;
}

export type SpendResult = { outcome: "created"; orderId: string; payoutLamports: string } | { outcome: Exclude<SpendOutcome, "created">; message: string };

/** POST /orders, spend form. Never throws: every answer maps to a SpendOutcome (credits.ts says what happens to the tokens). */
export async function spend(amountZec: string, tokens: CreditToken[], burner: string): Promise<SpendResult> {
  try {
    const body = { amount_zec: amountZec, tokens: tokens.map(({ msg, sig }) => ({ msg, sig })), burner };
    const r = import.meta.env.DEV && ORDER_API === "mock" ? await mintMock.spend(body) : await call<{ order_id: string; payout_lamports: string }>("/orders", { method: "POST", body: JSON.stringify(body) });
    if (!ID.test(r.order_id) || !/^\d+$/.test(r.payout_lamports)) return { outcome: "error", message: "The order service sent a malformed answer" };
    return { outcome: "created", orderId: r.order_id, payoutLamports: r.payout_lamports };
  } catch (e) {
    if (!(e instanceof OrderApiError)) return { outcome: "network", message: "No answer from Revolve. Retrying with the same credits." };
    if (e.code === "amount_unavailable") return { outcome: "unavailable", message: e.message };
    if (e.code === "token_spent") return { outcome: "spent", message: e.message };
    if (e.code === "invalid_tokens") return { outcome: "invalid", message: e.message };
    return { outcome: "error", message: e.message };
  }
}

// ---- demo mode: a real blind-RSA mint with a throwaway key, in this tab only ----

const MOCK_KEY = "revolve.mock.mint";
type MockMint = { pub: JsonWebKey; priv: JsonWebKey; spki: string; fundings: Record<string, { amount: string; credits: number; created: number; minted: boolean }>; spent: string[] };
let mockCache: Promise<{ state: MockMint; priv: CryptoKey; pub: CryptoKey }> | null = null;

const mintMock = {
  load(): Promise<{ state: MockMint; priv: CryptoKey; pub: CryptoKey }> {
    mockCache ??= (async () => {
      const algo = { name: "RSA-PSS", hash: "SHA-384" };
      let state: MockMint | null = null;
      try {
        state = JSON.parse(sessionStorage.getItem(MOCK_KEY) ?? "null");
      } catch {}
      if (!state) {
        const kp = await RSABSSA.SHA384.PSS.Randomized().generateKey({ publicExponent: Uint8Array.from([1, 0, 1]), modulusLength: 2048 });
        state = {
          pub: await crypto.subtle.exportKey("jwk", kp.publicKey),
          priv: await crypto.subtle.exportKey("jwk", kp.privateKey),
          spki: b64(new Uint8Array(await crypto.subtle.exportKey("spki", kp.publicKey))),
          fundings: {},
          spent: [],
        };
        sessionStorage.setItem(MOCK_KEY, JSON.stringify(state));
      }
      return {
        state,
        priv: await crypto.subtle.importKey("jwk", state.priv, algo, true, ["sign"]),
        pub: await crypto.subtle.importKey("jwk", state.pub, algo, true, ["verify"]),
      };
    })();
    return mockCache;
  },
  save(state: MockMint) {
    sessionStorage.setItem(MOCK_KEY, JSON.stringify(state));
  },
  async key(): Promise<MintKey> {
    const { state } = await mintMock.load();
    return { key_id: "demo1", public_key_spki_b64: state.spki, denomination_zec: "0.001" };
  },
  async fund(amount: string): Promise<FundQuote> {
    const q = orderMock.create(amount);
    const fundId = q.order_id.replace(/^rv_/, "rf_");
    const credits = Number(parseZec(amount)! / CREDIT_ZATS);
    const { state } = await mintMock.load();
    state.fundings[fundId] = { amount, credits, created: Date.now(), minted: false };
    mintMock.save(state);
    return { fund_id: fundId, deposit_ua: q.deposit_ua, amount_zec: amount, credits, expires_at: q.quote_expires_at };
  },
  async status(fundId: string): Promise<{ status: FundingStatus } | null> {
    const f = (await mintMock.load()).state.fundings[fundId];
    if (!f) return null;
    if (f.minted) return { status: "minted" };
    const s = (Date.now() - f.created) / 1000;
    return { status: s < 15 ? "awaiting_payment" : s < 30 ? "seen" : "funded" };
  },
  async sign(fundId: string, blinded: string[]): Promise<{ signatures: string[] }> {
    const { state, priv } = await mintMock.load();
    const f = state.fundings[fundId];
    if (!f || f.minted) throw new OrderApiError("These credits were already issued.", 409, "already_minted");
    if (blinded.length !== f.credits) throw new OrderApiError("wrong number of credits", 400, "invalid_blinded");
    const s = RSABSSA.SHA384.PSS.Randomized();
    const signatures = await Promise.all(blinded.map(async (m) => b64(await s.blindSign(priv, fromB64(m)))));
    f.minted = true;
    mintMock.save(state);
    return { signatures };
  },
  async spend(body: { amount_zec: string; tokens: { msg: string; sig: string }[]; burner: string }): Promise<{ order_id: string; payout_lamports: string }> {
    const { state, pub } = await mintMock.load();
    const s = RSABSSA.SHA384.PSS.Randomized();
    if (BigInt(body.tokens.length) * CREDIT_ZATS !== parseZec(body.amount_zec)) throw new OrderApiError("Some credits were not accepted.", 400, "invalid_tokens");
    const hashes: string[] = [];
    for (const t of body.tokens) {
      if (!(await s.verify(pub, fromB64(t.sig), fromB64(t.msg)).catch(() => false))) throw new OrderApiError("Some credits were not accepted.", 400, "invalid_tokens");
      hashes.push(b64(new Uint8Array(await crypto.subtle.digest("SHA-256", fromB64(t.msg) as Uint8Array<ArrayBuffer>))));
    }
    if (hashes.some((h) => state.spent.includes(h))) throw new OrderApiError("Some of these credits were already used.", 409, "token_spent");
    state.spent.push(...hashes);
    mintMock.save(state);
    return orderMock.credit(body.amount_zec);
  },
};
