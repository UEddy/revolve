// Build-time settings. VITE_ORDER_API is the worker's base URL; VITE_RELAY_URL
// the privacy relay (../relay). Under `npm run dev` the order service defaults
// to "mock", a demo that never touches money, and the relay runs inside the
// dev server at /api. A production build refuses mock (build-env.ts), and
// this file refuses it again at runtime in case a bundle was built some
// other way.

// Read as static properties only: Vite replaces each one with its value, while
// touching `import.meta.env` as a whole would inline every VITE_* variable in
// the build environment (on Vercel that includes the VITE_VERCEL_* system
// variables) into the bundle. Outside Vite (node tests) there is no
// `import.meta.env`, hence the try.
let dev = false;
let raw = "";
let relayUrl = "";
try {
  dev = import.meta.env.DEV === true;
  raw = (import.meta.env.VITE_ORDER_API ?? "").trim();
  relayUrl = (import.meta.env.VITE_RELAY_URL ?? "").trim();
} catch {}

const wantsMock = raw === "mock" || (!raw && dev);
export const ORDER_API: string | "mock" | null = wantsMock ? (dev ? "mock" : null) : raw ? raw.replace(/\/$/, "") : null;
export const MOCK = ORDER_API === "mock";

/** The privacy relay: its own origin in production, the dev server's /api under `npm run dev`. */
export const RELAY = relayUrl.replace(/\/$/, "") || "/api";


export const SOL_MINT = "So11111111111111111111111111111111111111112";
/** Wormhole ETH on Solana: its Jupiter price stands in for ETH/USD (Ethereum and Robinhood Chain NFT floors). */
export const ETH_MINT = "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs";
export const ZEC_MINT = "A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS";

/** Lamports kept in the burner after the swap: fees, the new token account's rent, and enough to sell later. */
export const SWAP_RESERVE_LAMPORTS = 2_500_000n;
