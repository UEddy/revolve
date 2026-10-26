// Build-time settings. VITE_ORDER_API is the worker's base URL, or "mock" for
// a demo that never touches money (the UI says so on every screen).

// `env` is absent outside Vite (node tests), hence the optional chaining.
const env = (import.meta as { env?: { VITE_ORDER_API?: string; DEV?: boolean } }).env;
const raw = env?.VITE_ORDER_API?.trim() ?? "";

export const ORDER_API: string | "mock" | null = raw === "mock" ? "mock" : raw ? raw.replace(/\/$/, "") : env?.DEV ? "mock" : null;
export const MOCK = ORDER_API === "mock";

/** Same-origin privacy relay (api/). */
export const RELAY = "/api";

export const BUCKETS = ["0.005", "0.01", "0.05"] as const;
export type Bucket = (typeof BUCKETS)[number];

export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const ZEC_MINT = "A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS";

/** Lamports kept in the burner after the swap: fees, the new token account's rent, and enough to sell later. */
export const SWAP_RESERVE_LAMPORTS = 2_500_000n;
