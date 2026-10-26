import { readFileSync } from "node:fs";
import { defineConfig, loadEnv, type Plugin } from "vite";
import { createRelay } from "../relay/src/relay.ts";
import { toNode } from "../relay/src/node.ts";
import { checkBuildEnv, type BuildTargets } from "./build-env.ts";

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

/** `npm run dev` only: the relay (../relay) mounted at /api, so dev needs no second process. */
function devRelay(env: Record<string, string>): Plugin {
  const handle = toNode(createRelay({ SOLANA_RPC_URL: env.SOLANA_RPC_URL, JUP_API_KEY: env.JUP_API_KEY }, undefined, "/api"));
  return {
    name: "revolve-dev-relay",
    apply: "serve",
    configureServer: (s) =>
      void s.middlewares.use((req, res, next) => (req.url?.startsWith("/api/") ? handle(req, res) : next())),
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

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  // Fails `vite build` on demo mode, a missing service, or plain http.
  const targets = command === "build" ? checkBuildEnv(mode, { ...env, ...process.env }) : null;
  return {
    plugins: [devRelay(env), ...(targets ? [narrowCsp(targets)] : [])],
    build: { target: "es2022", sourcemap: false },
    server: { port: 5180, strictPort: true, host: true },
    preview: { port: 4180, strictPort: true, host: true, headers: previewHeaders },
  };
});
