// Prediction markets and NFT collections on the Discover tab: a two-column
// grid of cards for one category, loaded through the relay's read-only feeds.

import { useEffect, useState } from "react";
import { CHAIN_LABEL, CHAIN_SHORT, loadCards, nftChain, nftId, nftUsd, type Card, type Category } from "../lib/discover.ts";
import { compact, pct, price, shortPrice, usd } from "../lib/format.ts";
import { href } from "../router.ts";
import { useEngine } from "../state/engine.tsx";
import { ETH_MINT, SOL_MINT } from "../lib/config.ts";
import { TokenIcon } from "./bits.tsx";

const TTL_MS = 60_000;

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

export function CardGrid({ cat }: { cat: Category }) {
  const { cards, error, retry } = useCards(cat);
  const { prices, priceOf } = useEngine();
  useEffect(() => {
    priceOf(SOL_MINT);
    if (cat === "nfts") priceOf(ETH_MINT);
  }, [cat, priceOf]);
  if (error) {
    return (
      <div className="dsc-empty">
        <p className="faint">{error}</p>
        <button className="btn small ghost" onClick={retry}>Try again</button>
      </div>
    );
  }
  if (cards && cards.length === 0) return <p className="empty">Nothing to show right now.</p>;
  return (
    <div className="dsc-grid" role="list">
      {cards
        ? cards.map((c) => (
            <div key={`${c.kind}:${c.id}`} role="listitem">
              <CardView card={c} prices={prices} />
            </div>
          ))
        : Array.from({ length: 6 }, (_, i) => <div key={i} className="dsc-card skeleton" />)}
    </div>
  );
}
