# Revolve relay

A small Node service on the droplet that carries the app's Solana RPC, Jupiter and token icon requests, so those providers see the droplet's address instead of the phone's and cannot tie a user's burners together by IP.

No dependencies beyond Node 24. No request logging: no IPs, paths, user agents or timings. Client headers never reach the handler (`src/node.ts` passes only method, path and body).

| Route | What |
| --- | --- |
| `POST /rpc` | One Solana JSON-RPC call (no batches). Methods: `getBalance`, `getTokenAccountsByOwner`, `getSignatureStatuses`, `getLatestBlockhash`, `sendTransaction`, `getAccountInfo`. |
| `GET /jup?path=...` | Jupiter token search/lists, prices, Ultra order. `POST /jup?path=ultra/v1/execute` sends a signed swap. |
| `GET /img?u=https://...` | Token icons. https only, no IP literals or local names, images only, 1 MB cap, served under a sandbox CSP. |
| `GET /health` | `{"ok":true}` |

CORS allows only `APP_ORIGIN`. Public responses (token lists, prices, icons) are cached in memory (24 MB cap, keyed by upstream URL only). Rate limits are global token buckets per route, so the relay holds no per-client state; over the limit it answers 429 and the app backs off.

## Run

```sh
cp .env.example .env   # APP_ORIGIN is required
npm start              # 127.0.0.1:8788
npm test
```

On the droplet: `deploy/revolve-relay.service` (systemd, memory capped) behind TLS, e.g. `deploy/Caddyfile.example`. Keep the reverse proxy's access logs off.

The app's dev server (`npm run dev` in `app/`) mounts this same code at `/api`, so local development needs no second process.
