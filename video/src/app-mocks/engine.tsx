// Stands in for app/src/state/engine.tsx inside the video (see
// remotion.config.ts). The Discover carousel only reads prices; they come
// from the live snapshot taken by scripts/probe.mjs.

import snapshot from "../generated/discover.json";

const prices = snapshot.prices as Record<string, number>;

export function useEngine() {
  return { prices, busy: {}, priceOf: () => {} };
}
