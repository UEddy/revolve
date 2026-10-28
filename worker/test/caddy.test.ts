import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// The reverse proxy forwards only the paths it lists; any other path gets
// Caddy's own 404, which a browser sees as a network error. Every route the
// worker serves must be listed, or it is unreachable in production.

const caddy = readFileSync(new URL("../deploy/Caddyfile", import.meta.url), "utf8");
const matchers = /@worker path (.+)/.exec(caddy)![1]!.trim().split(/\s+/);

/** Caddy path matching: exact, or a trailing `*` prefix. */
const forwarded = (path: string) => matchers.some((m) => (m.endsWith("*") ? path.startsWith(m.slice(0, -1)) : path === m));

test("every worker route is forwarded by the Caddyfile", () => {
  const routes = [
    "/limits",
    "/buckets",
    "/orders",
    "/orders/rv_0123456789",
    "/mint/key",
    "/mint/orders",
    "/mint/orders/rf_0123456789",
    "/mint/orders/rf_0123456789/sign",
    "/cashins",
    "/cashins/rf_0123456789/sent",
    "/withdrawals",
    "/withdrawals/rw_0123456789",
  ];
  for (const r of routes) assert.ok(forwarded(r), `${r} is not forwarded to the worker`);
  // And every literal path the server matches appears in that list.
  const server = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  for (const [, p] of server.matchAll(/path === "([^"]+)"/g)) assert.ok(routes.includes(p!), `${p} is served but not in this test's list`);
});
