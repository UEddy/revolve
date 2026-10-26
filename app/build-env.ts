// Checks the build-time settings before `vite build` writes anything.
// A production bundle must talk to a real order service and a real relay:
// demo mode can never ship.

export type BuildTargets = { orderOrigin: string; relayOrigin: string; relayUrl: string };

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

function origin(name: string, value: string | undefined, mode: string): URL {
  const v = value?.trim();
  if (!v) throw new Error(`${name} must be set for a build`);
  if (v === "mock") throw new Error(`${name}=mock is demo mode, which is for \`npm run dev\` only and can never be built`);
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    throw new Error(`${name} is not a URL: ${v}`);
  }
  if (url.protocol === "https:") return url;
  // Plain http only to this machine, and never in a production build.
  if (url.protocol === "http:" && LOOPBACK.has(url.hostname) && mode !== "production") return url;
  throw new Error(`${name} must be https${mode === "production" ? "" : " (or http on loopback outside production mode)"}: ${v}`);
}

export function checkBuildEnv(mode: string, env: Record<string, string | undefined>): BuildTargets {
  const order = origin("VITE_ORDER_API", env.VITE_ORDER_API, mode);
  const relay = origin("VITE_RELAY_URL", env.VITE_RELAY_URL, mode);
  return { orderOrigin: order.origin, relayOrigin: relay.origin, relayUrl: relay.href.replace(/\/$/, "") };
}
