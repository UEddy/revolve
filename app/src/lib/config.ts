// Build-time settings. VITE_ORDER_API is the worker's base URL; VITE_RELAY_URL
// the privacy relay (../relay). Under `npm run dev` the order service defaults
// to "mock", a demo that never touches money, and the relay runs inside the
// dev server at /api. A production build refuses mock (build-env.ts), and
// this file refuses it again at runtime in case a bundle was built some
// other way.

// `env` is absent outside Vite (node tests), hence the optional chaining.
const env = (import.meta as { env?: { VITE_ORDER_API?: string; VITE_RELAY_URL?: string; DEV?: boolean } }).env;
const dev = env?.DEV === true;
const raw = env?.VITE_ORDER_API?.trim() ?? "";

const wantsMock = raw === "mock" || (!raw && dev);
export const ORDER_API: string | "mock" | null = wantsMock ? (dev ? "mock" : null) : raw ? raw.replace(/\/$/, "") : null;
export const MOCK = ORDER_API === "mock";

/** The privacy relay: its own origin in production, the dev server's /api under `npm run dev`. */
export const RELAY = env?.VITE_RELAY_URL?.trim().replace(/\/$/, "") || "/api";

export const BUCKETS = ["0.005", "0.01", "0.05"] as const;
export type Bucket = (typeof BUCKETS)[number];

export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const ZEC_MINT = "A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS";

/** Lamports kept in the burner after the swap: fees, the new token account's rent, and enough to sell later. */
export const SWAP_RESERVE_LAMPORTS = 2_500_000n;
