// The Discover tab's top section: category chips and one compact
// carousel for the active category. Three cards show at a time with the
// next one peeking in; scroll-snap per card, page dots, arrows for mice,
// and a one-time swipe hint.

import { useCallback, useEffect, useRef, useState } from "react";
import { CATEGORIES, CHAIN_LABEL, CHAIN_SHORT, loadCards, nftChain, nftId, nftUsd, pageAt, type Card, type Category } from "../lib/discover.ts";
import { compact, pct, price, shortPrice, usd } from "../lib/format.ts";
import { href } from "../router.ts";
import { useEngine } from "../state/engine.tsx";
import { ETH_MINT, SOL_MINT } from "../lib/config.ts";
import { TokenIcon } from "./bits.tsx";
import { Back } from "./icons.tsx";

const TTL_MS = 60_000;
const HINT_KEY = "revolve.discover.hinted";

// Shared with the market and NFT detail screens, so opening a card is instant.
export const cardCache = new Map<Category, { at: number; cards: Card[] }>();

function useCards(c: Category) {
  const hit = cardCache.get(c);
  const [state, setState] = useState<{ cards: Card[] | null; error: string | null }>({ cards: hit?.cards ?? null, error: null });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let live = true;
    const h = cardCache.get(c);
    setState({ cards: h?.cards ?? null, error: null });
    if (h && Date.now() - h.at < TTL_MS) return;
    loadCards(c).then(
      (cards) => {
        cardCache.set(c, { at: Date.now(), cards });
        if (live) setState({ cards, error: null });
      },
      (e: Error) => live && setState((s) => ({ cards: s.cards, error: s.cards ? null : e.message })),
    );
    return () => {
      live = false;
    };
  }, [c, nonce]);
  return { ...state, retry: () => setNonce((n) => n + 1) };
}

function readHinted(): boolean {
  try {
    return localStorage.getItem(HINT_KEY) === "1";
  } catch {
    return true; // no storage: skip the hint rather than repeat it every visit
  }
}

function CardView({ card, prices }: { card: Card; prices: Record<string, number> }) {
  if (card.kind === "token") {
    const t = card.token;
    const ch = t.stats24h?.priceChange;
    return (
      <a className="dsc-card" href={href.token(t.id)}>
        <TokenIcon src={t.icon} symbol={t.symbol} />
        <span className="dsc-name">{t.symbol}</span>
        <span className="dsc-sub dsc-two">{t.name}</span>
        <span className="dsc-num num" title={price(t.usdPrice)}>{shortPrice(t.usdPrice)}</span>
        <span className={`dsc-sub num ${ch === undefined ? "" : ch >= 0 ? "up" : "down"}`}>{ch === undefined ? " " : pct(ch)}</span>
      </a>
    );
  }
  if (card.kind === "market") {
    const m = card.market;
    const lead = m.outcomes[0]!;
    return (
      <a className="dsc-card" href={href.market(m.id)}>
        <TokenIcon src={m.image} symbol={m.title} />
        <span className="dsc-name dsc-two">{m.title}</span>
        <span className="dsc-num num">{Math.round(lead.p * 100)}%</span>
        <span className="dsc-sub">{lead.name}</span>
      </a>
    );
  }
  const n = card.nft;
  const floorUsd = nftUsd(n.floor, n.floorUnit, prices);
  return (
    <a className="dsc-card" href={href.nft(nftId(n))}>
      <span className="dsc-top">
        <TokenIcon src={n.image} symbol={n.name} />
        <span className="dsc-chain" title={CHAIN_LABEL[nftChain(n)]}>{CHAIN_SHORT[nftChain(n)]}</span>
      </span>
      <span className="dsc-name dsc-two">{n.name}</span>
      <span className="dsc-num num">{floorUsd === null ? "…" : usd(floorUsd)}</span>
      <span className="dsc-sub">Floor{n.listed !== null ? ` · ${compact(n.listed)} listed` : ""}</span>
    </a>
  );
}

export function DiscoverSection() {
  const [cat, setCat] = useState<Category>(() => {
    try {
      return (sessionStorage.getItem("rv.dsc") as Category) || "memes";
    } catch {
      return "memes";
    }
  });
  const { cards, error, retry } = useCards(cat);
  const { prices, priceOf } = useEngine();
  const track = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState(0);
  const [hint, setHint] = useState(false);
  const count = cards?.length ?? 0;
  const pages = Math.max(1, Math.ceil(count / 3));

  useEffect(() => priceOf(SOL_MINT), [priceOf]);
  useEffect(() => {
    if (cat === "nfts") priceOf(ETH_MINT);
  }, [cat, priceOf]);
  useEffect(() => {
    try {
      sessionStorage.setItem("rv.dsc", cat);
    } catch {}
    track.current?.scrollTo({ left: 0 });
    setPage(0);
  }, [cat]);

  // One-time swipe hint, the first time cards are on screen.
  useEffect(() => {
    if (!count || readHinted()) return;
    setHint(true);
    try {
      localStorage.setItem(HINT_KEY, "1");
    } catch {}
    const t = setTimeout(() => setHint(false), 2_000);
    return () => clearTimeout(t);
  }, [count > 0]);

  const step = () => {
    const el = track.current;
    const first = el?.firstElementChild as HTMLElement | null;
    if (!el || !first) return 1;
    return first.getBoundingClientRect().width + parseFloat(getComputedStyle(el).columnGap || "0");
  };
  const onScroll = useCallback(() => {
    const el = track.current;
    if (el) setPage(pageAt(el.scrollLeft, el.scrollWidth - el.clientWidth, step(), count));
  }, [count]);
  const goPage = (p: number) => {
    const instant = matchMedia("(prefers-reduced-motion: reduce)").matches;
    track.current?.scrollTo({ left: Math.max(0, Math.min(pages - 1, p)) * 3 * step(), behavior: instant ? "auto" : "smooth" });
  };

  return (
    <section className="dsc" aria-label="Browse by category">
      <div className="dsc-chips" role="tablist" aria-label="Category">
        {CATEGORIES.map((c) => (
          <button key={c.key} role="tab" aria-selected={cat === c.key} className="dsc-chip" onClick={() => setCat(c.key)}>
            {c.label}
          </button>
        ))}
      </div>
      <div className="dsc-body">
        {error ? (
          <div className="dsc-empty">
            <p className="faint">{error}</p>
            <button className="btn small ghost" onClick={retry}>Try again</button>
          </div>
        ) : (
          <>
            <button className="dsc-arrow prev" aria-label="Previous" onClick={() => goPage(page - 1)} disabled={page === 0}>
              <Back />
            </button>
            <div ref={track} className={`dsc-track${hint ? " hint" : ""}`} onScroll={onScroll} role="list">
              {cards
                ? cards.map((c) => (
                    <div key={`${c.kind}:${c.id}`} role="listitem" className="dsc-slot">
                      <CardView card={c} prices={prices} />
                    </div>
                  ))
                : Array.from({ length: 4 }, (_, i) => (
                    <div key={i} className="dsc-slot">
                      <div className="dsc-card skeleton" />
                    </div>
                  ))}
            </div>
            <button className="dsc-arrow next" aria-label="Next" onClick={() => goPage(page + 1)} disabled={page >= pages - 1}>
              <Back />
            </button>
          </>
        )}
      </div>
      <div className="dsc-dots" aria-hidden={pages < 2}>
        {cards && pages > 1 &&
          Array.from({ length: pages }, (_, i) => (
            <button key={i} className="dsc-dot" aria-label={`Page ${i + 1} of ${pages}`} aria-current={i === page} onClick={() => goPage(i)} />
          ))}
      </div>
      {cards && cards.length === 0 && <p className="faint center">Nothing to show right now.</p>}
    </section>
  );
}
