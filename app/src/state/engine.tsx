// Everything that happens on its own while the vault is open: polling
// orders, buying the asset as soon as a payout lands, and the staggered
// per-burner balance checks behind the portfolio.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useVault } from "./vault.tsx";
import { newBurner } from "../lib/burner.ts";
import { MOCK, SOL_MINT, SWAP_RESERVE_LAMPORTS } from "../lib/config.ts";
import { buildMemo, zip321 } from "../lib/memo.ts";
import { createOrder, getOrder, type OrderState } from "../lib/orders.ts";
import { ultraOrder, usdPrice } from "../lib/jupiter.ts";
import { lamports, tokenRaw } from "../lib/solana.ts";
import { buyWithPayout, fundedEnough, NotFunded, sellAll } from "../lib/swap.ts";
import { Stagger } from "../lib/stagger.ts";
import { random } from "../lib/bytes.ts";
import type { Position, Stage, TokenRef } from "../lib/model.ts";

const POLL_MS: [number, number] = [9_000, 18_000];
const PRICE_TTL_MS = 60_000;
const MAX_AUTO_SWAPS = 3;
const RETRY_MS = 15_000;

type Engine = {
  prices: Record<string, number>;
  busy: Record<string, string>;
  startOrder(token: TokenRef, amountZec: string): Promise<string>;
  retrySwap(id: string): void;
  sell(id: string): Promise<void>;
  refresh(id: string): void;
  /** Fetches one asset's price now (no wallet involved, so no stagger needed). */
  priceOf(mint: string): void;
};

const Ctx = createContext<Engine | null>(null);

export function useEngine(): Engine {
  const e = useContext(Ctx);
  if (!e) throw new Error("useEngine outside EngineProvider");
  return e;
}

export function paymentLink(p: Position): string {
  return zip321(p.order.depositUa, p.order.amountZec, buildMemo(p.order.id, p.burner.pub));
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

  // ---- buy: burner first, then the order, both sealed before the link exists ----
  const startOrder = useCallback(
    async (token: TokenRef, amountZec: string) => {
      const burner = newBurner();
      const quote = await createOrder(amountZec);
      paymentLink({ burner, order: { id: quote.order_id, depositUa: quote.deposit_ua, amountZec: quote.amount_zec } } as Position);
      const id = Array.from(random(8), (b) => b.toString(16).padStart(2, "0")).join("");
      const pos: Position = {
        id,
        createdAt: Date.now(),
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
            if (s?.payout_signature) p.order.payoutSig = s.payout_signature;
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
        if (p.token.mint === SOL_MINT) {
          await updatePosition(p.id, (x) => void (x.stage = "held"));
          return;
        }
        let out: { sig: string; inAmount: string; outAmount: string };
        if (p.demo) {
          const spend = BigInt(p.order.payoutLamports) - SWAP_RESERVE_LAMPORTS;
          const q = await ultraOrder(SOL_MINT, p.token.mint, spend);
          out = { sig: "demo", inAmount: q.inAmount, outAmount: q.outAmount };
        } else {
          // The chain is the record: if an earlier attempt landed but its
          // answer was lost, the asset is already there. Never buy twice.
          const already = await tokenRaw(p.burner.pub, p.token.mint);
          if (already > 0n) {
            await updatePosition(p.id, (x) => {
              x.stage = "held";
              x.balance = { lamports: x.balance?.lamports ?? "0", tokenRaw: already.toString(), at: Date.now() };
            });
            return;
          }
          out = await buyWithPayout(p);
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
        const check = p.demo ? Promise.resolve(0n) : tokenRaw(p.burner.pub, p.token.mint);
        void check
          .then((raw) => updatePosition(p.id, (x) => void (x.stage = raw > 0n ? "held" : "funded")))
          .catch(() => updatePosition(p.id, (x) => void (x.stage = "funded")))
          .finally(() => inFlight.current.delete(p.id));
      }
    }
  }, [positions, runSwap, updatePosition]);

  const retrySwap = useCallback(
    (id: string) => {
      const p = latest.current.find((x) => x.id === id);
      if (p) void runSwap(p);
    },
    [runSwap],
  );

  const sell = useCallback(
    async (id: string) => {
      const p = latest.current.find((x) => x.id === id);
      if (!p || inFlight.current.has(id)) return;
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
        await sellAll(p);
        await updatePosition(id, (x) => {
          x.stage = "closed";
          x.balance = { lamports: x.balance?.lamports ?? "0", tokenRaw: "0", at: Date.now() };
        });
      } finally {
        inFlight.current.delete(id);
        setBusyFor(id, null);
      }
    },
    [updatePosition],
  );

  // ---- staggered balance checks, one burner at a time ----
  useEffect(() => {
    if (!data) return;
    const s = new Stagger(async (id) => {
      const p = latest.current.find((x) => x.id === id);
      if (!p) return;
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
  }, [!!data, price, updatePosition]);

  const watchIds = positions
    .filter((p) => p.stage === "held" || p.stage === "funded" || p.stage === "swap_failed" || (p.stage === "settling" && (p.order.status === "paid_out" || p.order.status === "gone")))
    .map((p) => p.id)
    .join(",");
  useEffect(() => {
    stagger.current?.sync(watchIds ? watchIds.split(",") : []);
  }, [watchIds]);

  const refresh = useCallback((id: string) => stagger.current?.soon(id), []);

  const priceOf = useCallback((mint: string) => void price(mint), [price]);

  const api = useMemo<Engine>(
    () => ({ prices, busy, startOrder, retrySwap, sell, refresh, priceOf }),
    [prices, busy, startOrder, retrySwap, sell, refresh, priceOf],
  );
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}
