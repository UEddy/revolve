// Credits while the vault is open (CREDITS_CONTRACT.md v1.3): funding and
// minting, the balance, and spending tokens on an order with a fresh
// passkey check. Every step is sealed in the vault before anything leaves
// the device, so a reload or a lost answer never loses track of tokens.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useVault } from "./vault.tsx";
import { newBurner } from "../lib/burner.ts";
import { newEvmBurner } from "../lib/evm.ts";
import { random } from "../lib/bytes.ts";
import { MOCK } from "../lib/config.ts";
import { parseZec } from "../lib/amount.ts";
import { afterSignError, balanceCredits, blindFor, creditsFor, importMintKey, keyFingerprint, tokensAfter, unblindAll } from "../lib/credits.ts";
import { cancelFunding, createFunding, getFunding, getMintKey, signFunding, spend, type MintKey } from "../lib/mint.ts";
import { OrderApiError } from "../lib/orders.ts";
import { creditsOf, type Chain, type CreditToken, type Credits, type Funding, type TokenRef } from "../lib/model.ts";

const POLL_MS: [number, number] = [9_000, 18_000];
const jitter = ([lo, hi]: [number, number]) => lo + Math.random() * (hi - lo);
const newId = () => Array.from(random(8), (b) => b.toString(16).padStart(2, "0")).join("");

/** The mint offered a different key than the one this vault pinned. The UI shows both fingerprints and asks. */
export class KeyChanged extends Error {
  readonly offered: MintKey;
  readonly pinnedFingerprint: string;
  readonly offeredFingerprint: string;
  constructor(offered: MintKey, pinnedFingerprint: string, offeredFingerprint: string) {
    super("Revolve's credit key has changed since you last added funds.");
    this.offered = offered;
    this.pinnedFingerprint = pinnedFingerprint;
    this.offeredFingerprint = offeredFingerprint;
  }
}

/** A spend the server turned down; the message says why, and the tokens went where the contract says. */
export class SpendRefused extends Error {}

type CreditsApi = {
  credits: Credits | undefined;
  /** Spendable credits (tokens out on a spend are not counted). */
  balance: number;
  /** Starts a funding; returns its id. Pass `acceptKey` to re-pin after the user agreed to a key change. */
  startFunding(amountZec: string, acceptKey?: MintKey): Promise<string>;
  /** Cancels an unpaid funding and drops it from the vault; throws (and keeps it) if a payment was already seen. */
  cancelFunding(fundId: string): Promise<void>;
  /** Spends credits on a buy after a fresh passkey check; returns the new position's id. */
  spendOnOrder(token: TokenRef, amountZec: string, chain?: Chain): Promise<string>;
};

const Ctx = createContext<CreditsApi | null>(null);

export function useCredits(): CreditsApi {
  const c = useContext(Ctx);
  if (!c) throw new Error("useCredits outside CreditsProvider");
  return c;
}

export function CreditsProvider({ children }: { children: ReactNode }) {
  const { data, update, confirm, snapshot } = useVault();
  const credits = data?.credits;
  // Reads go through the vault's own latest state, not render-time values:
  // right after an update the next step must already see what was written.
  const latest = { get current() { return snapshot()?.credits; } };
  const inFlight = useRef(new Set<string>());

  const updateFunding = useCallback(
    (fundId: string, mutate: (f: Funding) => void) =>
      update((d) => {
        const f = creditsOf(d).fundings.find((x) => x.fundId === fundId);
        if (f) mutate(f);
      }),
    [update],
  );

  // ---- funding ----
  const startFunding = useCallback(
    async (amountZec: string, acceptKey?: MintKey) => {
      const k = await getMintKey();
      await importMintKey(k.public_key_spki_b64); // refuse a key we can't use before taking money for it
      const pin = latest.current?.key;
      const changed = !!pin && (pin.id !== k.key_id || pin.spki !== k.public_key_spki_b64);
      const accepted = !!acceptKey && acceptKey.key_id === k.key_id && acceptKey.public_key_spki_b64 === k.public_key_spki_b64;
      if (changed && !accepted) throw new KeyChanged(k, await keyFingerprint(pin.spki), await keyFingerprint(k.public_key_spki_b64));
      const q = await createFunding(amountZec);
      await update((d) => {
        const c = creditsOf(d);
        if (!c.key || changed) c.key = { id: k.key_id, spki: k.public_key_spki_b64, pinnedAt: Date.now() };
        c.fundings.unshift({
          fundId: q.fund_id,
          depositUa: q.deposit_ua,
          amountZec: q.amount_zec,
          credits: q.credits,
          expiresAt: q.expires_at,
          createdAt: Date.now(),
          status: "awaiting_payment",
          keyId: k.key_id,
          demo: MOCK || undefined,
        });
      });
      return q.fund_id;
    },
    [update],
  );

  const cancel = useCallback(
    async (fundId: string) => {
      const f = latest.current?.fundings.find((x) => x.fundId === fundId);
      if (!f || f.status !== "awaiting_payment") throw new Error("Only an unpaid funding can be cancelled.");
      const r = await cancelFunding(fundId);
      if (r === "processing") {
        await updateFunding(fundId, (x) => void (x.status = "seen"));
        throw new OrderApiError("A payment for this funding has already been seen, so it can't be cancelled. It's already being processed.", 409, "payment_seen");
      }
      if (r === "unknown") throw new OrderApiError("Revolve has no open record of this funding, so nothing was cancelled.", 404, "not_found");
      await update((d) => {
        const c = creditsOf(d);
        c.fundings = c.fundings.filter((x) => x.fundId !== fundId);
      });
    },
    [update, updateFunding],
  );

  /** Blind, get signed, unblind, verify, store. The blinding state is sealed before the blinded messages are sent. */
  const mint = useCallback(
    async (fundId: string) => {
      if (inFlight.current.has(fundId)) return;
      inFlight.current.add(fundId);
      try {
        const c = latest.current;
        const f = c?.fundings.find((x) => x.fundId === fundId);
        if (!c || !f || f.status !== "funded") return;
        if (!c.key || c.key.id !== f.keyId) {
          await updateFunding(fundId, (x) => {
            x.status = "needs_review";
            x.error = "The credit key changed after this funding started.";
          });
          return;
        }
        const key = await importMintKey(c.key.spki);
        let blind = f.blind;
        if (!blind) {
          const fresh = await blindFor(key, f.credits);
          await updateFunding(fundId, (x) => void (x.blind = fresh));
          blind = fresh;
        }
        let signatures: string[];
        try {
          signatures = await signFunding(fundId, blind.blinded);
        } catch (e) {
          const fate = e instanceof OrderApiError ? afterSignError(e.status, e.code) : "retry";
          if (fate === "review") {
            await updateFunding(fundId, (x) => {
              x.status = "needs_review";
              x.error =
                e instanceof OrderApiError && e.code === "already_minted"
                  ? "These credits were issued to another copy of this wallet."
                  : "Revolve didn't accept this phone's request for credits.";
            });
          } else if (fate === "refresh") {
            // The server's status moved on (expired, under review, or forgotten): take its word.
            const s = await getFunding(fundId).catch(() => undefined);
            if (s === undefined) return;
            await updateFunding(fundId, (x) => {
              if (s === null || s.status === "minted") {
                x.status = "needs_review";
                x.error = s ? "These credits were issued but not to this phone." : "Revolve no longer has a record of this funding.";
              } else if (s.status !== "funded") {
                x.status = s.status;
                delete x.error;
              }
            });
          } else {
            // Kept: the blinding state stays sealed, and the next try resends the same set.
            await updateFunding(fundId, (x) => void (x.error = e instanceof Error ? e.message : String(e)));
          }
          return;
        }
        let tokens: CreditToken[];
        try {
          tokens = await unblindAll(key, c.key.id, blind, signatures);
        } catch (e) {
          await updateFunding(fundId, (x) => {
            x.status = "needs_review";
            x.error = `${e instanceof Error ? e.message : String(e)}. No credits were stored.`;
          });
          return;
        }
        await update((d) => {
          const cc = creditsOf(d);
          const x = cc.fundings.find((y) => y.fundId === fundId);
          if (!x || x.status !== "funded") return;
          cc.tokens.push(...tokens);
          x.status = "minted";
          x.mintedAt = Date.now();
          delete x.blind;
          delete x.error;
        });
      } finally {
        inFlight.current.delete(fundId);
      }
    },
    [update, updateFunding],
  );

  // Poll open fundings one at a time, jittered; mint as soon as one is funded.
  useEffect(() => {
    if (!data) return;
    let stop = false;
    const next: Record<string, number> = {};
    const loop = async () => {
      while (!stop) {
        await new Promise((r) => setTimeout(r, 1_500 + Math.random() * 1_500));
        if (document.visibilityState !== "visible") continue;
        const now = Date.now();
        const funded = latest.current?.fundings.find((f) => f.status === "funded" && (next[f.fundId] ?? 0) <= now);
        if (funded) {
          next[funded.fundId] = now + jitter(POLL_MS);
          await mint(funded.fundId).catch(() => {});
          continue;
        }
        const due = latest.current?.fundings.find((f) => (f.status === "awaiting_payment" || f.status === "seen") && (next[f.fundId] ?? 0) <= now);
        if (!due) continue;
        next[due.fundId] = now + jitter(POLL_MS);
        try {
          const s = await getFunding(due.fundId);
          if (stop) return;
          await updateFunding(due.fundId, (f) => {
            if (!s) f.status = Date.now() > Date.parse(f.expiresAt) ? "expired" : f.status;
            else if (s.status === "minted") {
              // Minted elsewhere (another device with this vault, or a lost answer).
              f.status = "needs_review";
              f.error = "These credits were issued but not to this phone.";
            } else f.status = s.status;
          });
          if (s?.status === "funded") next[due.fundId] = 0;
        } catch {
          // Network trouble: try again on the next turn.
        }
      }
    };
    void loop();
    return () => {
      stop = true;
    };
    // Restart only when the vault opens or closes.
  }, [!!data, mint, updateFunding]);

  // ---- spending ----

  /** Sends one pending spend and applies the answer. Returns the server's verdict for the UI. */
  const send = useCallback(
    async (spendId: string): Promise<{ ok: true } | { ok: false; message: string; final: boolean }> => {
      if (inFlight.current.has(spendId)) return { ok: false, message: "Already sending", final: false };
      inFlight.current.add(spendId);
      try {
        const sp = latest.current?.pending.find((x) => x.id === spendId);
        if (!sp) return { ok: true };
        const pos = snapshot()?.positions.find((p) => p.id === sp.positionId);
        const burner = pos?.burner.pub;
        if (!burner) return { ok: false, message: "This order's wallet is missing", final: true };
        const r = await spend(sp.amountZec, sp.tokens, burner, pos?.chain ?? "solana");
        const fate = tokensAfter(r.outcome);
        await update((d) => {
          const c = creditsOf(d);
          const i = c.pending.findIndex((x) => x.id === spendId);
          if (i < 0) return;
          const p = c.pending[i]!;
          const position = d.positions.find((x) => x.id === p.positionId);
          if (fate === "keep_pending") {
            p.attempts += 1;
            p.uncertain ||= r.outcome === "network" || r.outcome === "error";
            return;
          }
          c.pending.splice(i, 1);
          if (fate === "spent" && r.outcome === "created" && position) {
            position.order.id = r.orderId;
            position.order.payoutLamports = r.payoutLamports;
            position.order.status = "confirmed";
            position.stage = "settling";
          } else if (fate === "return") {
            c.tokens.unshift(...p.tokens);
            d.positions = d.positions.filter((x) => x.id !== p.positionId);
          } else if (fate === "drop") {
            // Never reused. If an earlier try got no answer it probably went
            // through: keep the position and let the balance checks find the payout.
            if (p.uncertain && position) {
              position.order.status = "gone";
              position.stage = "settling";
            } else d.positions = d.positions.filter((x) => x.id !== p.positionId);
          }
        });
        if (r.outcome === "created") return { ok: true };
        const stillPending = fate === "keep_pending";
        return { ok: false, message: r.message, final: !stillPending };
      } finally {
        inFlight.current.delete(spendId);
      }
    },
    [update, snapshot],
  );

  const spendOnOrder = useCallback(
    async (token: TokenRef, amountZec: string, chain: Chain = "solana") => {
      const zats = parseZec(amountZec);
      if (zats === null) throw new Error("bad amount");
      const n = creditsFor(zats);
      if (balanceCredits(latest.current) < n) throw new SpendRefused("Not enough credits for this amount.");
      // Fresh user verification before any token leaves the vault.
      await confirm();
      const burner = chain === "base" ? newEvmBurner() : newBurner();
      const positionId = newId();
      const spendId = newId();
      await update((d) => {
        const c = creditsOf(d);
        if (c.tokens.length < n) throw new SpendRefused("Not enough credits for this amount.");
        const tokens = c.tokens.splice(0, n);
        c.pending.push({ id: spendId, positionId, amountZec, tokens, createdAt: Date.now(), attempts: 0, uncertain: false });
        d.positions.unshift({
          id: positionId,
          createdAt: Date.now(),
          burner,
          token,
          paidWith: "credits",
          ...(chain === "base" ? { chain } : {}),
          order: { id: "", amountZec, depositUa: "", payoutLamports: "0", quoteExpiresAt: "", status: "confirmed", confirmations: 0 },
          stage: "sending",
          sends: [],
          demo: MOCK || undefined,
        });
      });
      const r = await send(spendId);
      if (!r.ok && r.final) throw new SpendRefused(r.message);
      // Network trouble leaves it pending: the position shows "sending" and the retry loop carries on.
      return positionId;
    },
    [confirm, send, update],
  );

  // Retry pending spends with the same tokens, backing off; also picks them up after a reload.
  useEffect(() => {
    if (!data) return;
    let stop = false;
    const lastTry: Record<string, number> = {};
    const loop = async () => {
      while (!stop) {
        await new Promise((r) => setTimeout(r, 4_000));
        if (document.visibilityState !== "visible") continue;
        const now = Date.now();
        for (const p of latest.current?.pending ?? []) {
          const wait = Math.min(60_000, 5_000 * 2 ** Math.min(p.attempts, 4));
          if (inFlight.current.has(p.id) || now - (lastTry[p.id] ?? p.createdAt) < wait) continue;
          lastTry[p.id] = now;
          await send(p.id).catch(() => {});
        }
      }
    };
    void loop();
    return () => {
      stop = true;
    };
  }, [!!data, send]);

  const api = useMemo<CreditsApi>(
    () => ({ credits, balance: balanceCredits(credits), startFunding, cancelFunding: cancel, spendOnOrder }),
    [credits, startFunding, cancel, spendOnOrder],
  );
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}
