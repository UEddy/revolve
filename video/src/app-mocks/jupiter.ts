// Stands in for app/src/lib/jupiter.ts imports made from app components (see
// remotion.config.ts): everything is the real module except iconUrl, which
// serves the icons scripts/probe.mjs inlined instead of asking the relay.
// Imported by absolute path so the replacement doesn't apply to itself.

import snapshot from "../generated/discover.json";

export * from "../../../app/src/lib/jupiter.ts";

const icons = snapshot.icons as Record<string, string>;

export function iconUrl(src: string | undefined): string | undefined {
  return src ? icons[src] : undefined;
}
