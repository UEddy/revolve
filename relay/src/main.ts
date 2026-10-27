import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { createRelay } from "./relay.ts";
import { toNode } from "./node.ts";

const envFile = process.env.RELAY_ENV_FILE ?? ".env";
if (existsSync(envFile)) process.loadEnvFile(envFile);

const appOrigin = process.env.APP_ORIGIN;
if (!appOrigin) throw new Error("APP_ORIGIN is not set");
const port = Number(process.env.PORT ?? "8788");
const host = process.env.HOST ?? "127.0.0.1";

for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => process.exit(0));

// Deliberately no request logging: no IPs, paths, user agents or timings.
const server = createServer(
  toNode(
    createRelay({
      APP_ORIGIN: appOrigin,
      SOLANA_RPC_URL: process.env.SOLANA_RPC_URL,
      JUP_API_BASE: process.env.JUP_API_BASE,
      JUP_API_KEY: process.env.JUP_API_KEY,
      NFT_COLLECTIONS: process.env.NFT_COLLECTIONS,
      OPENSEA_API_KEY: process.env.OPENSEA_API_KEY,
    }),
  ),
);
server.requestTimeout = 30_000;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;
server.listen(port, host, () => console.error(`relay on ${host}:${port} for ${appOrigin}`));
