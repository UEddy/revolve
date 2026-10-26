import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { defineConfig, loadEnv, type Connect, type Plugin } from "vite";
import { handleImg, handleJup, handleRpc, type RelayEnv } from "./api/_relay.ts";

// Production headers live in vercel.json; `vite preview` serves the same
// ones so a build can be checked under the real CSP before deploying.
type VercelHeaders = { headers: { source: string; headers: { key: string; value: string }[] }[] };
const vercel = JSON.parse(readFileSync(new URL("./vercel.json", import.meta.url), "utf8")) as VercelHeaders;
const previewHeaders = Object.fromEntries(
  (vercel.headers.find((h) => h.source === "/(.*)")?.headers ?? []).map((h) => [
    h.key,
    // Locally the order service may be a plain-http worker on loopback.
    h.key === "Content-Security-Policy" ? h.value.replace("connect-src 'self' https:", "connect-src 'self' https: http://127.0.0.1:* http://localhost:*") : h.value,
  ]),
);

/** Runs the same relay code as the Vercel functions (api/) under `vite` and `vite preview`. */
function relay(env: RelayEnv): Plugin {
  const routes: Record<string, (req: Request) => Promise<Response>> = {
    "/api/rpc": (r) => handleRpc(r, env),
    "/api/jup": (r) => handleJup(r, env),
    "/api/img": (r) => handleImg(r),
  };
  const middleware: Connect.NextHandleFunction = (req: IncomingMessage, res: ServerResponse, next) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = routes[url.pathname];
    if (!route) return next();
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      try {
        const body = req.method === "POST" ? Buffer.concat(chunks) : undefined;
        const out = await route(new Request(url, { method: req.method, body }));
        res.statusCode = out.status;
        out.headers.forEach((v, k) => res.setHeader(k, v));
        res.end(Buffer.from(await out.arrayBuffer()));
      } catch {
        res.statusCode = 502;
        res.end('{"error":"relay failed"}');
      }
    });
  };
  return {
    name: "revolve-relay",
    configureServer: (s) => void s.middlewares.use(middleware),
    configurePreviewServer: (s) => void s.middlewares.use(middleware),
  };
}

/** Narrows connect-src to this origin plus the order service, on top of the header CSP. */
function connectCsp(orderApi: string | undefined): Plugin {
  let origin = "";
  try {
    if (orderApi && orderApi !== "mock") origin = new URL(orderApi).origin;
  } catch {
    throw new Error(`VITE_ORDER_API is not a URL: ${orderApi}`);
  }
  return {
    name: "revolve-connect-csp",
    apply: "build",
    transformIndexHtml: (html) =>
      html.replace("<head>", `<head>\n    <meta http-equiv="Content-Security-Policy" content="connect-src 'self'${origin ? " " + origin : ""}" />`),
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    plugins: [relay(env), connectCsp(env.VITE_ORDER_API)],
    build: { target: "es2022", sourcemap: false },
    server: { port: 5180, strictPort: true, host: true },
    preview: { port: 4180, strictPort: true, host: true, headers: previewHeaders },
  };
});
