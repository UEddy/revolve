import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { defineConfig, loadEnv, type Plugin } from "vite";
import { checkBuildEnv, type BuildTargets } from "./build-env.ts";
import { stripDotfiles } from "./build-dist.ts";

// Production headers live in vercel.json; `vite preview` serves the same
// ones so a build can be checked under the real CSP before deploying.
type VercelHeaders = { headers: { source: string; headers: { key: string; value: string }[] }[] };
const vercel = JSON.parse(readFileSync(new URL("./vercel.json", import.meta.url), "utf8")) as VercelHeaders;
const previewHeaders = Object.fromEntries(
  (vercel.headers.find((h) => h.source === "/(.*)")?.headers ?? []).map((h) => [
    h.key,
    // Locally the order service and relay may be plain http on loopback.
    h.key === "Content-Security-Policy" ? h.value.replace(/(connect-src|img-src) ([^;]*)/g, "$1 $2 http://127.0.0.1:* http://localhost:*") : h.value,
  ]),
);

// The parts of ../relay the dev server uses. Declared here rather than
// imported so app/ type-checks and builds on its own (Vercel deploys app/
// alone, without ../relay).
type FetchHandler = (req: Request) => Promise<Response>;
type RelayModule = { createRelay(env: { SOLANA_RPC_URL?: string; JUP_API_KEY?: string; OPENSEA_API_KEY?: string }, state: undefined, prefix: string): FetchHandler };
type NodeModule = { toNode(handler: FetchHandler): (req: IncomingMessage, res: ServerResponse) => void };

/**
 * `npm run dev` only: the relay (../relay) mounted at /api, so dev needs no
 * second process. Loaded at runtime from a computed path, so neither the
 * build nor the type check ever resolves ../relay.
 */
function devRelay(env: Record<string, string>): Plugin {
  return {
    name: "revolve-dev-relay",
    apply: "serve",
    async configureServer(server) {
      const dir = resolve(server.config.root, "../relay/src");
      if (!existsSync(dir)) throw new Error(`npm run dev needs the relay next to the app (${dir}); run it from the repo checkout`);
      const load = <T,>(file: string) => import(pathToFileURL(resolve(dir, file)).href) as Promise<T>;
      const [{ createRelay }, { toNode }] = await Promise.all([load<RelayModule>("relay.ts"), load<NodeModule>("node.ts")]);
      const handle = toNode(createRelay({ SOLANA_RPC_URL: env.SOLANA_RPC_URL, JUP_API_KEY: env.JUP_API_KEY, OPENSEA_API_KEY: env.OPENSEA_API_KEY }, undefined, "/api"));
      server.middlewares.use((req, res, next) => (req.url?.startsWith("/api/") ? handle(req, res) : next()));
    },
  };
}

/** Narrows connect-src and img-src to this origin plus the order service and relay, on top of the header CSP. */
function narrowCsp(t: BuildTargets): Plugin {
  const connect = [...new Set(["'self'", t.orderOrigin, t.relayOrigin])].join(" ");
  const img = `'self' blob: data: ${t.relayOrigin}`;
  return {
    name: "revolve-csp",
    apply: "build",
    transformIndexHtml: (html) =>
      html.replace("<head>", `<head>\n    <meta http-equiv="Content-Security-Policy" content="connect-src ${connect}; img-src ${img}" />`),
  };
}

/** Second guard behind the public/ hygiene: nothing starting with a dot is ever deployed (build-dist.ts). */
function noDotfiles(): Plugin {
  let outDir = "dist";
  let warn: (msg: string) => void = () => {};
  return {
    name: "revolve-no-dotfiles",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
      warn = (msg) => config.logger.warn(msg);
    },
    closeBundle() {
      const removed = stripDotfiles(outDir);
      if (removed.length) warn(`removed from ${outDir}: ${removed.join(", ")}`);
    },
  };
}

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  // Fails `vite build` on demo mode, a missing service, or plain http.
  const targets = command === "build" ? checkBuildEnv(mode, { ...env, ...process.env }) : null;
  return {
    plugins: [...(command === "serve" ? [devRelay(env)] : []), noDotfiles(), ...(targets ? [narrowCsp(targets)] : [])],
    build: { target: "es2022", sourcemap: false },
    // Loopback only. To test from a phone on the LAN, opt in for that session:
    // `npm run dev -- --host` (or `npm run preview -- --host`).
    server: { port: 5180, strictPort: true, host: "localhost" },
    preview: { port: 4180, strictPort: true, host: "localhost", headers: previewHeaders },
  };
});
