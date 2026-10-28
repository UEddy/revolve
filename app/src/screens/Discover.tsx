// The Discover tab: the category chips and carousel on top, then search,
// trending, new launches and stocks, straight from Jupiter's token data.

import { useEffect, useState } from "react";
import { tokens, isStock, type JupToken } from "../lib/jupiter.ts";
import { compact, pct, price, ago } from "../lib/format.ts";
import { href } from "../router.ts";
import { TokenIcon } from "../components/bits.tsx";
import { Search } from "../components/icons.tsx";
import { DiscoverSection } from "../components/DiscoverSection.tsx";

type Tab = "trending" | "new" | "stocks";
const TABS: { key: Tab; label: string }[] = [
  { key: "trending", label: "Trending" },
  { key: "new", label: "New" },
  { key: "stocks", label: "Stocks" },
];

// Lists survive moving between screens, so going back does not refetch.
const cache = new Map<string, { at: number; list: JupToken[] }>();
export const seen = new Map<string, JupToken>();

function useList(key: string, load: () => Promise<JupToken[]>, ttl = 60_000) {
  const hit = cache.get(key);
  const [state, setState] = useState<{ list: JupToken[] | null; error: string | null }>({ list: hit?.list ?? null, error: null });
  useEffect(() => {
    let live = true;
    const c = cache.get(key);
    if (c && Date.now() - c.at < ttl) {
      setState({ list: c.list, error: null });
      return;
    }
    setState({ list: c?.list ?? null, error: null });
    load()
      .then((list) => {
        cache.set(key, { at: Date.now(), list });
        for (const t of list) seen.set(t.id, t);
        if (live) setState({ list, error: null });
      })
      .catch((e: Error) => live && setState({ list: null, error: e.message }));
    return () => {
      live = false;
    };
    // Keyed on `key` alone: `load` is a fresh closure every render.
  }, [key]);
  return state;
}

export function TokenRow({ t, showAge }: { t: JupToken; showAge?: boolean }) {
  const change = t.stats24h?.priceChange;
  const launched = t.firstPool?.createdAt ?? t.createdAt;
  return (
    <a className="trow" href={href.token(t.id)}>
      <TokenIcon src={t.icon} symbol={t.symbol} />
      <div className="grow">
        <div className="name">
          {t.symbol} {t.isVerified && <span className="badge ok">✓</span>} {isStock(t) && <span className="badge">Stock</span>}
        </div>
        <div className="sub">
          {t.name}
          {showAge && launched ? ` · ${ago(launched)} old` : t.mcap ? ` · ${compact(t.mcap)} cap` : ""}
        </div>
      </div>
      <div className="right num">
        <div>{price(t.usdPrice)}</div>
        {change !== undefined && <div className={`small ${change >= 0 ? "up" : "down"}`}>{pct(change)}</div>}
      </div>
    </a>
  );
}

function Results({ list, error, showAge }: { list: JupToken[] | null; error: string | null; showAge?: boolean }) {
  if (error) return <p className="empty">{error}</p>;
  if (!list)
    return (
      <div className="list">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="skeleton" />
        ))}
      </div>
    );
  if (!list.length) return <p className="empty">Nothing found.</p>;
  return (
    <div className="list">
      {list.map((t) => (
        <TokenRow key={t.id} t={t} showAge={showAge} />
      ))}
    </div>
  );
}

function TabList({ tab }: { tab: Tab }) {
  const loader = tab === "trending" ? tokens.trending : tab === "new" ? tokens.fresh : tokens.stocks;
  const s = useList(`tab:${tab}`, loader, tab === "new" ? 20_000 : 60_000);
  return <Results {...s} showAge={tab === "new"} />;
}

function SearchList({ query }: { query: string }) {
  const s = useList(`q:${query}`, () => tokens.search(query));
  return <Results {...s} />;
}

export function Discover() {
  const [tab, setTab] = useState<Tab>(() => (sessionStorage.getItem("rv.tab") as Tab) || "trending");
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setQuery(text.trim()), 350);
    return () => clearTimeout(t);
  }, [text]);
  useEffect(() => sessionStorage.setItem("rv.tab", tab), [tab]);
  return (
    <div className="screen">
      <h1 style={{ marginTop: 6 }}>Discover</h1>
      <DiscoverSection />
      <a className="card flat row" href={href.base} style={{ margin: "14px 0", color: "inherit", textDecoration: "none" }}>
        <div className="grow">
          <b>Buy on Base</b>
          <div className="faint small">Tokens on Coinbase's chain, each in a fresh Base wallet</div>
        </div>
        <span aria-hidden>›</span>
      </a>
      <div className="search" style={{ position: "sticky" }}>
        <Search />
        <input
          className="input"
          type="search"
          placeholder="Search any token or stock"
          value={text}
          onChange={(e) => setText(e.target.value)}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="search"
        />
      </div>
      {query ? (
        <div style={{ marginTop: 14 }}>
          <SearchList query={query} />
        </div>
      ) : (
        <>
          <div className="seg" role="group">
            {TABS.map((t) => (
              <button key={t.key} aria-pressed={tab === t.key} onClick={() => setTab(t.key)}>
                {t.label}
              </button>
            ))}
          </div>
          <TabList key={tab} tab={tab} />
        </>
      )}
    </div>
  );
}
