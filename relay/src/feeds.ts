// Read-only market feeds for Discover: Polymarket events, and NFT collections
// from Magic Eden (Solana) and OpenSea (Ethereum, Robinhood Chain). Each feed is one fixed upstream URL (nothing from the client
// reaches the query), projected down to the few fields the app shows, and
// cached, so phones download kilobytes instead of the upstream's megabytes
// and the upstream sees the relay, rarely, instead of every phone.

export type Outcome = { name: string; p: number };

export type MarketEvent = {
  id: string;
  title: string;
  image?: string;
  volume24h: number;
  endDate?: string;
  /** Open outcomes, most likely first (at most 6). */
  outcomes: Outcome[];
};

type RawMarket = {
  question?: string;
  groupItemTitle?: string;
  outcomes?: string;
  outcomePrices?: string;
  active?: boolean;
  closed?: boolean;
};
type RawEvent = {
  id?: string | number;
  title?: string;
  image?: string;
  icon?: string;
  volume24hr?: number;
  endDate?: string;
  negRisk?: boolean;
  markets?: RawMarket[];
};

const https = (u: unknown): string | undefined => (typeof u === "string" && u.startsWith("https://") ? u : undefined);

function parseList(s: unknown): unknown[] {
  if (typeof s !== "string") return [];
  try {
    const v: unknown = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

const prob = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
};

/**
 * Polymarket Gamma `/events` to MarketEvent[].
 * - Multi-outcome events (negRisk): one Yes/No market per outcome; the
 *   outcome's chance is its Yes price. When the open outcomes add up to
 *   less than half, the event is effectively decided and is skipped.
 * - Ladders (every open market has its own label, e.g. price levels): each
 *   level with its Yes price.
 * - Otherwise the event's main market names its outcomes (e.g. two teams).
 */
export function projectPolymarket(body: unknown, max = 12): MarketEvent[] {
  if (!Array.isArray(body)) return [];
  const out: MarketEvent[] = [];
  const byYes = (ms: RawMarket[]): Outcome[] =>
    ms.flatMap((m) => {
      const p = prob(parseList(m.outcomePrices)[0]);
      const name = m.groupItemTitle || m.question;
      return p === null || !name ? [] : [{ name, p }];
    });
  for (const e of body as RawEvent[]) {
    const open = (e.markets ?? []).filter((m) => m.active !== false && m.closed !== true);
    if (!open.length || !e.title || e.id === undefined) continue;
    let outcomes: Outcome[];
    if (e.negRisk) {
      outcomes = byYes(open);
      if (outcomes.reduce((s, o) => s + o.p, 0) < 0.5) continue;
    } else if (open.length > 1 && open.every((m) => m.groupItemTitle)) {
      outcomes = byYes(open);
    } else {
      const m = open[0]!;
      const names = parseList(m.outcomes);
      const prices = parseList(m.outcomePrices);
      outcomes = names.flatMap((n, i) => {
        const p = prob(prices[i]);
        return typeof n === "string" && p !== null ? [{ name: n, p }] : [];
      });
    }
    if (!outcomes.length) continue;
    outcomes.sort((a, b) => b.p - a.p);
    out.push({
      id: String(e.id),
      title: e.title,
      image: https(e.image) ?? https(e.icon),
      volume24h: Number(e.volume24hr) || 0,
      endDate: typeof e.endDate === "string" ? e.endDate : undefined,
      outcomes: outcomes.slice(0, 6),
    });
    if (out.length >= max) break;
  }
  return out;
}

export type NftChain = "solana" | "ethereum" | "robinhood";
/** What an amount is counted in, in base units: SOL in lamports (9), ETH in wei (18), USD in micro-dollars (6). */
export type NftUnit = "SOL" | "ETH" | "USD";
export const UNIT_DECIMALS: Record<NftUnit, number> = { SOL: 9, ETH: 18, USD: 6 };

export type NftCollection = {
  symbol: string;
  name: string;
  image?: string;
  chain: NftChain;
  /** Floor price in base units of `floorUnit` (the app shows it in USD). */
  floor: string | null;
  floorUnit: NftUnit;
  listed: number | null;
  owners: number | null;
  volume7d: string | null;
  volumeUnit: NftUnit;
};

const SYMBOL = /^[a-z0-9_-]{1,64}$/;

export type NftEntry = { symbol: string; name: string };

/** `symbol:Name,symbol:Name` from the environment, or the defaults. Bad symbols are dropped. */
export function nftList(env: string | undefined, fallback: readonly NftEntry[]): NftEntry[] {
  const parsed = (env ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [symbol = "", ...name] = s.split(":");
      return { symbol: symbol.trim(), name: name.join(":").trim() || symbol.trim() };
    });
  return (parsed.length ? parsed : [...fallback]).filter((e) => SYMBOL.test(e.symbol)).slice(0, 16);
}

/**
 * Magic Eden `/stats` (+ optional `/v2/collections/:symbol` metadata, which
 * is far more rate-limited) to one card. Null when the stats are unusable.
 */
export function projectNft(entry: NftEntry, meta: unknown, stats: unknown): NftCollection | null {
  const m = (meta ?? {}) as { name?: unknown; image?: unknown };
  const s = (stats ?? {}) as { floorPrice?: unknown; listedCount?: unknown; volume7d?: unknown };
  const lamports = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? BigInt(Math.round(v)).toString() : null);
  const floor = lamports(s.floorPrice);
  if (floor === null) return null;
  return {
    symbol: entry.symbol,
    name: typeof m.name === "string" && m.name ? m.name : entry.name,
    image: https(m.image),
    chain: "solana",
    floor,
    floorUnit: "SOL",
    listed: typeof s.listedCount === "number" ? s.listedCount : null,
    owners: null,
    volume7d: lamports(s.volume7d),
    volumeUnit: "SOL",
  };
}

/** OpenSea quotes amounts as a decimal plus a symbol. ETH and WETH count as ETH, dollar stablecoins as USD; anything else is dropped. */
const USD_STABLES = new Set(["USDC", "USDT", "USDG", "PYUSD", "DAI", "USDS"]);
function unitOf(symbol: unknown): NftUnit | null {
  if (typeof symbol !== "string") return null;
  const s = symbol.toUpperCase();
  if (s === "ETH" || s === "WETH") return "ETH";
  return USD_STABLES.has(s) ? "USD" : null;
}

/** A positive decimal amount to base units. ETH keeps 9 decimals (gwei), plenty for a price shown in dollars. */
export function toBase(v: unknown, unit: NftUnit): string | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return null;
  const dec = UNIT_DECIMALS[unit];
  const kept = Math.min(dec, 9);
  return (BigInt(Math.round(v * 10 ** kept)) * 10n ** BigInt(dec - kept)).toString();
}

/**
 * OpenSea `/collections/:slug/stats` (+ `/collections/:slug` metadata) to one
 * card. Null without a usable floor: no listings (floor 0) or an unknown currency.
 */
export function projectOpenSea(entry: NftEntry, chain: "ethereum" | "robinhood", meta: unknown, stats: unknown): NftCollection | null {
  const m = (meta ?? {}) as { name?: unknown; image_url?: unknown };
  const s = (stats ?? {}) as {
    total?: { floor_price?: unknown; floor_price_symbol?: unknown; num_owners?: unknown };
    intervals?: { interval?: unknown; volume?: unknown; volume_symbol?: unknown }[];
  };
  const floorUnit = unitOf(s.total?.floor_price_symbol);
  const floor = floorUnit && toBase(s.total?.floor_price, floorUnit);
  if (!floorUnit || !floor) return null;
  const week = Array.isArray(s.intervals) ? s.intervals.find((i) => i?.interval === "seven_day") : undefined;
  const volumeUnit = unitOf(week?.volume_symbol) ?? floorUnit;
  const owners = s.total?.num_owners;
  return {
    symbol: entry.symbol,
    name: typeof m.name === "string" && m.name ? m.name : entry.name,
    image: https(m.image_url),
    chain,
    floor,
    floorUnit,
    listed: null,
    owners: typeof owners === "number" && Number.isInteger(owners) && owners >= 0 ? owners : null,
    // No sales this week is a real zero, not a missing number.
    volume7d: week ? (toBase(week.volume, volumeUnit) ?? "0") : null,
    volumeUnit,
  };
}
