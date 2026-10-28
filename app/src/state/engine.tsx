// Everything that happens on its own while the vault is open: polling
// orders, buying the asset as soon as a payout lands, and the staggered
// per-burner balance checks behind the portfolio.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useVault } from "./vault.tsx";
import { newBurner } from "../lib/burner.ts";
import { baseFundedEnough, baseUsdPrice, buyBase, sellBaseAll } from "../lib/baseswap.ts";
import { erc20Balance, ethBalance, newEvmBurner } from "../lib/evm.ts";
import { ETH_MINT, MOCK, SOL_MINT, SWAP_RESERVE_LAMPORTS } from "../lib/config.ts";
import { buildMemo, zip321 } from "../lib/memo.ts";
import { cancelOrder, createOrder, getOrder, OrderApiError, type OrderState } from "../lib/orders.ts";
import { ultraOrder, usdPrice } from "../lib/jupiter.ts";
import { lamports, tokenRaw } from "../lib/solana.ts";
import { buyWithPayout, fundedEnough, NotFunded, sellAll } from "../lib/swap.ts";
import { Stagger } from "../lib/stagger.ts";
import { cashOf } from "../lib/chain.ts";
import { random } from "../lib/bytes.ts";
import type { Chain, Position, Stage, TokenRef } from "../lib/model.ts";

const POLL_MS: [number, number] = [9_000, 18_000];
const PRICE_TTL_MS = 60_000;
const MAX_AUTO_SWAPS = 3;
const RETRY_MS = 15_000;

type Engine = {
  prices: Record<string, number>;
  busy: Record<string, string>;
  startOrder(token: TokenRef, amountZec: string, chain?: Chain): Promise<string>;
  /** User-started signing (a retried buy, a sale) asks for a fresh passkey check first; the automatic buy after a payout does not. */
  retrySwap(id: string): Promise<void>;
  sell(id: string): Promise<void>;
  /**
   * Cancels an unpaid order. On success the position and its unused fresh
   * wallet leave the vault. Throws (and keeps it) when a payment was already
   * seen or the server has no open record of it.
   */
  cancel(id: string): Promise<void>;
  refresh(id: string): void;
  /** Fetches one asset's price now (no wallet involved, so no stagger needed). */
  priceOf(mint: string): void;
  /** A position's asset and cash prices: Jupiter on Solana, KyberSwap and ETH on Base. */
  pricePosition(p: Position): void;
};

const Ctx = createContext<Engine | null>(null);

export function useEngine(): Engine {
  const e = useContext(Ctx);
  if (!e) throw new Error("useEngine outside EngineProvider");
  return e;
}

export function paymentLink(p: Position): string {
  return zip321(p.order.depositUa, p.order.amountZec, buildMemo(p.order.id, p.burner.pub, p.chain));
}

/** The stage an order status implies. `p` is the position before the status is applied. */
function stageFor(p: Position, s: OrderState | null): Stage {
  if (!s) {
    // Forgotten by the server: after a payout that is normal (balance checks take over); before one, the quote lapsed.
    if (p.order.status === "paid_out" || p.order.status === "seen" || p.order.status === "confirmed") return "settling";
    return Date.now() > Date.parse(p.order.quoteExpiresAt) ? "expired" : p.stage;
  }
  switch (s.status) {
    case "awaiting_payment":
      return "awaiting_payment";
    case "seen":
    case "confirmed":
      return "settling";
    case "paid_out":
      return "funded";
    case "expired":
      return "expired";
    case "needs_review":
      return "needs_review";
  }
}

const jitter = ([lo, hi]: [number, number]) => lo + Math.random() * (hi - lo);

export function EngineProvider({ children }: { children: ReactNode }) {
  const vault = useVault();
  const { data, update, updatePosition } = vault;
  const positions = data?.positions ?? [];
  const latest = useRef<Position[]>(positions);
  latest.current = positions;

  const [prices, setPrices] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState<Record<string, string>>({});
  const priceAt = useRef<Record<string, number>>({});
  const inFlight = useRef(new Set<string>());
  const stagger = useRef<Stagger | null>(null);

  const setBusyFor = (id: string, what: string | null) =>
    setBusy((b) => {
      const n = { ...b };
      if (what) n[id] = what;
      else delete n[id];
      return n;
    });

  const price = useCallback(async (mint: string) => {
    if (Date.now() - (priceAt.current[mint] ?? 0) < PRICE_TTL_MS) return;
    priceAt.current[mint] = Date.now();
    const usd = await usdPrice(mint).catch(() => null);
    if (usd !== null) setPrices((p) => ({ ...p, [mint]: usd }));
  }, []);

  /** A Base token's USD price, from KyberSwap's valuation; kept in the same map, keyed by contract address. */
  const basePrice = useCallback(async (t: { mint: string; decimals: number }) => {
    if (Date.now() - (priceAt.current[t.mint] ?? 0) < PRICE_TTL_MS) return;
    priceAt.current[t.mint] = Date.now();
    const usd = await baseUsdPrice(t);
    if (usd !== null) setPrices((p) => ({ ...p, [t.mint]: usd }));
  }, []);

  // ---- buy: burner first, then the order, both sealed before the link exists ----
  const startOrder = useCallback(
    async (token: TokenRef, amountZec: string, chain: Chain = "solana") => {
      const burner = chain === "base" ? newEvmBurner() : newBurner();
      const quote = await createOrder(amountZec, chain);
      const onChain = chain === "base" ? { chain } : {};
      paymentLink({ burner, ...onChain, order: { id: quote.order_id, depositUa: quote.deposit_ua, amountZec: quote.amount_zec } } as Position);
      const id = Array.from(random(8), (b) => b.toString(16).padStart(2, "0")).join("");
      const pos: Position = {
        id,
        createdAt: Date.now(),
        ...onChain,
        burner,
        token,
        order: {
          id: quote.order_id,
          amountZec: quote.amount_zec,
          depositUa: quote.deposit_ua,
          payoutLamports: quote.payout_lamports,
          quoteExpiresAt: quote.quote_expires_at,
          status: "awaiting_payment",
          confirmations: 0,
        },
        stage: "awaiting_payment",
        sends: [],
        demo: MOCK || undefined,
      };
      await update((d) => void d.positions.unshift(pos));
      return id;
    },
    [update],
  );

  // ---- order status polling, one order at a time, jittered ----
  useEffect(() => {
    if (!data) return;
    let stop = false;
    const next: Record<string, number> = {};
    const loop = async () => {
      while (!stop) {
        await new Promise((r) => setTimeout(r, 1_500 + Math.random() * 1_500));
        if (document.visibilityState !== "visible") continue;
        const now = Date.now();
        const due = latest.current.find(
          (p) => (p.stage === "awaiting_payment" || (p.stage === "settling" && p.order.status !== "paid_out" && p.order.status !== "gone")) && (next[p.id] ?? 0) <= now,
        );
        if (!due) continue;
        next[due.id] = now + jitter(POLL_MS);
        try {
          const s = await getOrder(due.order.id);
          if (stop) return;
          await updatePosition(due.id, (p) => {
            p.stage = stageFor(p, s);
            p.order.status = s ? s.status : "gone";
            p.order.confirmations = s?.confirmations ?? p.order.confirmations;
            if (s?.payout_signature && !p.order.payoutSig) {
              p.order.payoutSig = s.payout_signature;
              p.order.paidAt = Date.now();
            }
          });
        } catch {
          // Network trouble: try again on the next turn.
        }
      }
    };
    void loop();
    return () => {
      stop = true;
    };
    // Restart only when the vault opens or closes, not on every change.
  }, [!!data, updatePosition]);

  // ---- the swap, as soon as the payout is there ----
  const runSwap = useCallback(
    async (p: Position) => {
      if (inFlight.current.has(p.id)) return;
      inFlight.current.add(p.id);
      setBusyFor(p.id, "Buying");
      try {
        await updatePosition(p.id, (x) => void (x.stage = "swapping"));
        if (p.token.mint === SOL_MINT && !p.chain) {
          await updatePosition(p.id, (x) => void (x.stage = "held"));
          return;
        }
        let out: { sig: string; inAmount: string; outAmount: string };
        if (p.demo && p.chain === "base") {
          out = { sig: "demo", inAmount: p.order.payoutLamports, outAmount: (10n ** BigInt(p.token.decimals) * 42n).toString() };
        } else if (p.demo) {
          const spend = BigInt(p.order.payoutLamports) - SWAP_RESERVE_LAMPORTS;
          const q = await ultraOrder(SOL_MINT, p.token.mint, spend);
          out = { sig: "demo", inAmount: q.inAmount, outAmount: q.outAmount };
        } else {
          // The chain is the record: if an earlier attempt landed but its
          // answer was lost, the asset is already there. Never buy twice.
          const already = p.chain === "base" ? await erc20Balance(p.token.mint, p.burner.pub) : await tokenRaw(p.burner.pub, p.token.mint);
          if (already > 0n) {
            await updatePosition(p.id, (x) => {
              x.stage = "held";
              x.balance = { lamports: x.balance?.lamports ?? "0", tokenRaw: already.toString(), at: Date.now() };
            });
            return;
          }
          out = p.chain === "base" ? await buyBase(p) : await buyWithPayout(p);
        }
        await updatePosition(p.id, (x) => {
          x.stage = "held";
          x.swap = { sig: out.sig, inLamports: out.inAmount, outAmount: out.outAmount, at: Date.now(), attempts: (x.swap?.attempts ?? 0) + 1 };
          if (x.demo) x.balance = { lamports: SWAP_RESERVE_LAMPORTS.toString(), tokenRaw: out.outAmount, at: Date.now() };
        });
      } catch (e) {
        if (e instanceof NotFunded) {
          // Back to waiting; the balance checks move it on when the payout shows.
          await updatePosition(p.id, (x) => void (x.stage = "settling"));
          stagger.current?.soon(p.id);
          return;
        }
        let attempts = 0;
        await updatePosition(p.id, (x) => {
          x.stage = "swap_failed";
          attempts = (x.swap?.attempts ?? 0) + 1;
          x.swap = { ...x.swap, error: e instanceof Error ? e.message : String(e), attempts };
        });
        if (attempts < MAX_AUTO_SWAPS) {
          setTimeout(() => {
            const now = latest.current.find((x) => x.id === p.id);
            if (now?.stage === "swap_failed") void runSwapRef.current?.(now);
          }, RETRY_MS * attempts);
        }
      } finally {
        inFlight.current.delete(p.id);
        setBusyFor(p.id, null);
      }
    },
    [updatePosition],
  );
  const runSwapRef = useRef(runSwap);
  runSwapRef.current = runSwap;

  useEffect(() => {
    for (const p of positions) {
      if (inFlight.current.has(p.id)) continue;
      if (p.stage === "funded" && (p.swap?.attempts ?? 0) < MAX_AUTO_SWAPS) void runSwap(p);
      if (p.stage === "swapping") {
        // Left mid-swap by a reload: the chain says whether it went through.
        inFlight.current.add(p.id);
        const check = p.demo ? Promise.resolve(0n) : p.chain === "base" ? erc20Balance(p.token.mint, p.burner.pub) : tokenRaw(p.burner.pub, p.token.mint);
        void check
          .then((raw) => updatePosition(p.id, (x) => void (x.stage = raw > 0n ? "held" : "funded")))
          .catch(() => updatePosition(p.id, (x) => void (x.stage = "funded")))
          .finally(() => inFlight.current.delete(p.id));
      }
    }
  }, [positions, runSwap, updatePosition]);

  const retrySwap = useCallback(
    async (id: string) => {
      const p = latest.current.find((x) => x.id === id);
      if (!p) return;
      if (!p.demo) await vault.confirm();
      void runSwap(p);
    },
    [runSwap, vault],
  );

  const sell = useCallback(
    async (id: string) => {
      const p = latest.current.find((x) => x.id === id);
      if (!p || inFlight.current.has(id)) return;
      // Before anything is marked busy, so a cancelled prompt changes nothing.
      if (!p.demo) await vault.confirm();
      inFlight.current.add(id);
      setBusyFor(id, "Selling");
      try {
        if (p.demo) {
          await updatePosition(id, (x) => {
            x.stage = "closed";
            x.balance = { lamports: x.order.payoutLamports, tokenRaw: "0", at: Date.now() };
          });
          return;
        }
        const out = p.chain === "base" ? await sellBaseAll(p) : await sellAll(p);
        // The wallet's cash after the sale, read from the chain (a closed position isn't in the balance rotation).
        const cash = await (p.chain === "base" ? ethBalance(p.burner.pub) : lamports(p.burner.pub)).catch(() => null);
        await updatePosition(id, (x) => {
          x.stage = "closed";
          x.sale = { sig: out.sig, at: Date.now() };
          x.balance = { lamports: cash?.toString() ?? x.balance?.lamports ?? "0", tokenRaw: "0", at: Date.now() };
        });
      } finally {
        inFlight.current.delete(id);
        setBusyFor(id, null);
      }
    },
    [updatePosition, vault],
  );

  const cancel = useCallback(
    async (id: string) => {
      const p = latest.current.find((x) => x.id === id);
      if (!p || p.stage !== "awaiting_payment" || p.paidWith === "credits") throw new Error("Only an unpaid order can be cancelled.");
      const r = await cancelOrder(p.order.id);
      if (r === "processing") {
        await updatePosition(id, (x) => void (x.stage = "settling"));
        throw new OrderApiError("A payment for this order has already been seen, so it can't be cancelled. It's already being processed.", 409, "payment_seen");
      }
      if (r === "unknown") throw new OrderApiError("Revolve has no open record of this order, so nothing was cancelled. It may already have been paid out.", 404, "not_found");
      // The wallet was made for this order alone and never received anything.
      await update((d) => void (d.positions = d.positions.filter((x) => x.id !== id)));
    },
    [update, updatePosition],
  );

  // ---- staggered balance checks, one burner at a time ----
  useEffect(() => {
    if (!data) return;
    const s = new Stagger(async (id) => {
      const p = latest.current.find((x) => x.id === id);
      if (!p) return;
      if (p.chain === "base") {
        await Promise.all([basePrice(p.token), price(ETH_MINT)]);
        if (p.demo) return;
        const [wei, raw] = await Promise.all([ethBalance(p.burner.pub), erc20Balance(p.token.mint, p.burner.pub)]);
        await updatePosition(id, (x) => {
          if (x.balance?.lamports !== wei.toString() || x.balance?.tokenRaw !== raw.toString()) x.balance = { lamports: wei.toString(), tokenRaw: raw.toString(), at: Date.now() };
          if (x.stage === "settling" && baseFundedEnough(wei)) x.stage = "funded";
        });
        return;
      }
      if (p.token.mint !== SOL_MINT) await price(p.token.mint);
      await price(SOL_MINT);
      if (p.demo) return;
      const lam = await lamports(p.burner.pub);
      const raw = p.token.mint === SOL_MINT ? 0n : await tokenRaw(p.burner.pub, p.token.mint);
      await updatePosition(id, (x) => {
        const changed = x.balance?.lamports !== lam.toString() || x.balance?.tokenRaw !== raw.toString();
        if (changed) x.balance = { lamports: lam.toString(), tokenRaw: raw.toString(), at: Date.now() };
        if (x.stage === "settling" && fundedEnough(lam)) x.stage = "funded";
      });
    });
    stagger.current = s;
    return () => {
      s.stop();
      stagger.current = null;
    };
  }, [!!data, price, basePrice, updatePosition]);

  const watchIds = positions
    .filter(
      (p) =>
        p.stage === "held" ||
        p.stage === "funded" ||
        p.stage === "swap_failed" ||
        (p.stage === "settling" && (p.order.status === "paid_out" || p.order.status === "gone")) ||
        // A sold position still cashing out: its balance moves with each part.
        (p.stage === "closed" && !!p.cashoutPlan?.parts.some((x) => !x.fundId && !x.skipped)),
    )
    .map((p) => p.id)
    .join(",");
  useEffect(() => {
    stagger.current?.sync(watchIds ? watchIds.split(",") : []);
  }, [watchIds]);

  const refresh = useCallback((id: string) => stagger.current?.soon(id), []);

  const priceOf = useCallback((mint: string) => void price(mint), [price]);
  const pricePosition = useCallback(
    (p: Position) => {
      if (p.chain === "base") void basePrice(p.token);
      else void price(p.token.mint);
      void price(cashOf(p).mint);
    },
    [price, basePrice],
  );

  const api = useMemo<Engine>(
    () => ({ prices, busy, startOrder, retrySwap, sell, cancel, refresh, priceOf, pricePosition }),
    [prices, busy, startOrder, retrySwap, sell, cancel, refresh, priceOf, pricePosition],
  );
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}
