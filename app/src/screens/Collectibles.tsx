// Read-only detail views for prediction markets and NFT collections. Buying
// these isn't built yet, so there is no buy button: just the numbers and a
// clear "Buying coming soon".

import { useEffect, useState } from "react";
import { cardCache } from "../components/DiscoverSection.tsx";
import { feeds, type MarketEvent, type NftCollection } from "../lib/discover.ts";
import { SOL_MINT } from "../lib/config.ts";
import { compact, usd } from "../lib/format.ts";
import { useEngine } from "../state/engine.tsx";
import { TokenIcon, TopBar } from "../components/bits.tsx";

function useItem<T>(find: () => T | undefined, load: () => Promise<T | undefined>) {
  const [item, setItem] = useState<T | undefined>(find);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (item) return;
    let live = true;
    load().then(
      (x) => live && (x ? setItem(x) : setError("Not found")),
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
    // Look up once per screen.
  }, []);
  return { item, error };
}

function ComingSoon({ what }: { what: string }) {
  return (
    <div className="warn low" style={{ margin: "16px 0" }}>
      <span className="dot" />
      <div>
        <b>Buying coming soon</b>
        <p>You can browse {what} here today. Buying them privately, like tokens and stocks, isn't available yet.</p>
      </div>
    </div>
  );
}

export function MarketScreen({ id }: { id: string }) {
  const { item: m, error } = useItem<MarketEvent>(
    () => cardCache.get("markets")?.cards.flatMap((c) => (c.kind === "market" && c.id === id ? [c.market] : []))[0],
    async () => (await feeds.markets()).find((x) => x.id === id),
  );
  if (!m) return <div className="screen"><TopBar title="" />{error ? <p className="empty">{error}</p> : <div className="skeleton" style={{ borderRadius: 22 }} />}</div>;
  return (
    <div className="screen">
      <TopBar title="" right={<span className="badge">Read only</span>} />
      <div className="row">
        <TokenIcon src={m.image} symbol={m.title} large />
        <div className="grow">
          <div className="eyebrow">Prediction market</div>
          <h1 style={{ margin: "4px 0 0", fontSize: 22 }}>{m.title}</h1>
        </div>
      </div>
      <ComingSoon what="prediction markets" />
      <h2>Chances</h2>
      <div className="card flat stack">
        {m.outcomes.map((o) => (
          <div key={o.name}>
            <div className="kv" style={{ padding: "0 0 6px" }}>
              <span style={{ color: "var(--ink)" }}>{o.name}</span>
              <strong className="num">{Math.round(o.p * 100)}%</strong>
            </div>
            <div className="bar" role="img" aria-label={`${o.name}: ${Math.round(o.p * 100)} percent`}>
              <div style={{ width: `${Math.max(1, o.p * 100)}%` }} />
            </div>
          </div>
        ))}
      </div>
      <h2>Details</h2>
      <div className="card flat small">
        <div className="kv"><span>Traded in 24h</span><span className="num">${compact(m.volume24h)}</span></div>
        {m.endDate && <div className="kv"><span>Ends</span><span>{new Date(m.endDate).toLocaleDateString()}</span></div>}
        <div className="kv"><span>Source</span><span>Polymarket</span></div>
      </div>
    </div>
  );
}

export function NftScreen({ symbol }: { symbol: string }) {
  const { prices, priceOf } = useEngine();
  useEffect(() => priceOf(SOL_MINT), [priceOf]);
  const { item: n, error } = useItem<NftCollection>(
    () => cardCache.get("nfts")?.cards.flatMap((c) => (c.kind === "nft" && c.id === symbol ? [c.nft] : []))[0],
    async () => (await feeds.nfts()).find((x) => x.symbol === symbol),
  );
  const sol = prices[SOL_MINT];
  const asUsd = (lamports: string | null) => (lamports && sol !== undefined ? usd((Number(lamports) / 1e9) * sol) : "–");
  if (!n) return <div className="screen"><TopBar title="" />{error ? <p className="empty">{error}</p> : <div className="skeleton" style={{ borderRadius: 22 }} />}</div>;
  return (
    <div className="screen">
      <TopBar title="" right={<span className="badge">Read only</span>} />
      <div className="row">
        <TokenIcon src={n.image} symbol={n.name} large />
        <div className="grow">
          <div className="eyebrow">NFT collection</div>
          <h1 style={{ margin: "4px 0 0", fontSize: 24 }}>{n.name}</h1>
        </div>
      </div>
      <div className="hero" style={{ textAlign: "left", padding: "18px 0 6px" }}>
        <div className="total num">{asUsd(n.floor)}</div>
        <div className="muted">Floor price</div>
      </div>
      <ComingSoon what="NFT collections" />
      <div className="stats">
        <div className="stat"><span className="faint">Listed</span><b className="num">{n.listed === null ? "–" : compact(n.listed)}</b></div>
        <div className="stat"><span className="faint">Traded in 7 days</span><b className="num">{asUsd(n.volume7d)}</b></div>
      </div>
      <p className="faint" style={{ marginTop: 14 }}>Prices from Magic Eden.</p>
    </div>
  );
}
