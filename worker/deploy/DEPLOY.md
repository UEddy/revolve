# Deploy: watcher + worker + relay on the droplet

Droplet `157.230.27.98` (Ubuntu, 512 MB + 2 GB swap, Caddy installed), host
`revolveapp.duckdns.org`. Run each labelled block in order. **[local]** blocks
run in WSL, **[droplet]** blocks in an SSH session as root (`ssh root@157.230.27.98`).

Layout on the droplet, all owned by the `revolve` system user:

```
/opt/revolve/solver/revolve-watcher   Rust binary, built locally, copied up
/opt/revolve/solver/.env              Orchard-only UFVK (600)
/opt/revolve/solver/data/             watcher wallet DB + Tor state (700)
/opt/revolve/worker/                  worker checkout + .env (600) + data/ (700)
/opt/revolve/relay/                   relay checkout + .env (600)
/opt/revolve/secrets/hotwallet.json   Solana hot wallet (600, dir 700)
/opt/revolve/secrets/mint-key.pem     credits mint key, generated on the droplet (600)
```

The watcher has no unit of its own: the worker starts it as a child process.
Public routes: `/orders`, `/orders/<id>`, `/limits`, `/buckets`, `/mint/*` go to the worker; `/relay/*`
goes to the relay with the prefix stripped; everything else returns 404. Build the
app with `VITE_ORDER_API=https://revolveapp.duckdns.org` and
`VITE_RELAY_URL=https://revolveapp.duckdns.org/relay`.

## D0 [local] Point DNS at the droplet

The record must be the droplet's IP before Caddy can get a certificate. Pass
`ip=` explicitly: auto-detection records whatever network the updater is on.

```bash
curl "https://www.duckdns.org/update?domains=revolveapp&token=<DUCKDNS_TOKEN>&ip=157.230.27.98"   # expect: OK
curl -s -H 'accept: application/dns-json' 'https://dns.google/resolve?name=revolveapp.duckdns.org&type=A' | grep -o '"data":"[^"]*"'
# expect "data":"157.230.27.98"
```

## D1 [local] Stop the local worker

Only one worker may ever pay from the hot wallet. Stop the local one (and its
watcher) for good before the droplet's starts.

```bash
P=$(ss -ltnp | grep ':8787 ' | grep -oP 'pid=\K[0-9]+'); [ -n "$P" ] && kill "$P"
sleep 3; pgrep -x revolve-watcher || echo "local worker and watcher stopped"
```

## D2 [local] Build the watcher and stage secrets + state

```bash
cd ~/revolve && git pull --rebase --autostash
cd solver && cargo build --release && cd ..
objdump -T solver/target/release/revolve-watcher | grep -oE 'GLIBC_[0-9.]+' | sort -Vu | tail -1   # needs <= droplet glibc (D3)
read -rsp 'Solana RPC URL: ' SOLANA_RPC_URL && export SOLANA_RPC_URL && echo   # private https RPC; kept out of shell history
worker/deploy/stage.sh https://<APP_ORIGIN>     # the app's exact https origin; prints no secrets
unset SOLANA_RPC_URL
```

## D3 [droplet] Base setup: user, directories, Node 24

```bash
ldd --version | head -1                          # glibc must be >= the version D2 printed (2.34)
id revolve 2>/dev/null || useradd --system --home-dir /opt/revolve --shell /usr/sbin/nologin revolve
mkdir -p /opt/revolve/{solver/data,worker/data,relay,secrets}
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt-get install -y nodejs
node -v                                          # expect v24.x, at /usr/bin/node
ufw status | grep -E '80|443' || echo "check firewall allows 80 and 443"
```

## D4 [local] Upload code, binary, env files, state, hot wallet key

Code comes from the committed tree only (`git archive`), so nothing untracked or
ignored can ride along. The hot wallet key goes straight from
`~/revolve-secrets` to the droplet and is never copied into the repo.

```bash
H=root@157.230.27.98; S=~/revolve-secrets/deploy
cd ~/revolve
git archive HEAD worker relay | ssh $H 'tar -x -C /opt/revolve'
scp solver/target/release/revolve-watcher $H:/opt/revolve/solver/revolve-watcher
scp $S/solver.env $H:/opt/revolve/solver/.env
scp $S/worker.env $H:/opt/revolve/worker/.env
scp $S/relay.env  $H:/opt/revolve/relay/.env
scp $S/state/wallet.sqlite $H:/opt/revolve/solver/data/wallet.sqlite
scp $S/state/worker.sqlite $H:/opt/revolve/worker/data/worker.sqlite
scp ~/revolve-secrets/hotwallet.json $H:/opt/revolve/secrets/hotwallet.json
```

## D5 [droplet] Permissions, dependencies, watcher check

```bash
chown -R revolve:revolve /opt/revolve
chmod 700 /opt/revolve/secrets /opt/revolve/solver/data /opt/revolve/worker/data
chmod 600 /opt/revolve/secrets/hotwallet.json /opt/revolve/solver/.env /opt/revolve/worker/.env /opt/revolve/relay/.env
chmod 755 /opt/revolve/solver/revolve-watcher
cd /opt/revolve/worker && sudo -u revolve HOME=/opt/revolve npm ci --omit=dev
cd /opt/revolve/relay  && sudo -u revolve HOME=/opt/revolve npm ci --omit=dev
cd /opt/revolve/solver && sudo -u revolve ./revolve-watcher address
grep -o '^DEPOSIT_UA=.\{20\}' /opt/revolve/worker/.env   # must start the same as the address above
```

## D5b [droplet] Credits mint key

Generated on the droplet as `revolve`, so it never leaves the server. The script
refuses to overwrite an existing key and prints only the public key fingerprint.
Replacing the key later invalidates every unspent credit, so do this once.

```bash
cd /opt/revolve/worker && sudo -u revolve node src/mint-keygen.ts /opt/revolve/secrets/mint-key.pem
ls -l /opt/revolve/secrets/mint-key.pem                   # -rw------- revolve revolve
grep -E '^MINT_KEY_(PATH|ID)=' /opt/revolve/worker/.env  # both set (stage.sh writes them)
```

## D6 [droplet] Start the services

```bash
cp /opt/revolve/worker/deploy/revolve-worker.service /etc/systemd/system/
cp /opt/revolve/relay/deploy/revolve-relay.service   /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now revolve-relay revolve-worker
journalctl -u revolve-worker -f      # wait for "order API on 127.0.0.1:8787"; Tor bootstrap takes ~30 s
curl -s localhost:8787/buckets; echo # 503 not_ready for a few seconds, then the bucket list
curl -s localhost:8788/health; echo  # {"ok":true}
```

## D7 [droplet] Replace the Caddyfile (old floorfight site goes away)

```bash
cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.floorfight.bak
cp /opt/revolve/worker/deploy/Caddyfile /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl reload caddy
journalctl -u caddy --since "2 min ago" | grep -iE 'certificate obtained|error' | tail -5
```

## D8 [local] Smoke test over HTTPS

```bash
B=https://revolveapp.duckdns.org; O=https://<APP_ORIGIN>
curl -s $B/limits; echo                                                    # min/max/step/indicative USD
curl -s $B/mint/key; echo                                                  # key_id k1, public key, 0.001
curl -s $B/buckets; echo                                                   # bucket list (deprecated)
curl -s $B/relay/health; echo                                              # {"ok":true}
curl -s -o /dev/null -w '%{http_code}\n' $B/                               # 404
curl -s -o /dev/null -w '%{http_code}\n' $B/orders/rv_0000000000           # 404
curl -si -X OPTIONS -H "Origin: $O" $B/orders | grep -i access-control-allow-origin   # your app origin
```

## D9 [droplet] Privacy check: no client IPs anywhere

```bash
ls /var/log/caddy 2>/dev/null || echo "no caddy log dir"
# Caddy's admin API logs our own reloads (from 127.0.0.1 to localhost:2019); those are not client traffic.
journalctl -u caddy -u revolve-worker -u revolve-relay --since today | grep -v '"logger":"admin.api"' | grep -cE 'remote_ip|client_ip|X-Forwarded-For'   # expect 0
```

## Operating

- Review items: `cd /opt/revolve/worker && sudo -u revolve node src/admin.ts list`
  (and `pay-out ...`, see `src/admin.ts`). Run from an SSH shell only.
- Update code: rerun D4's `git archive` line, then `systemctl restart revolve-worker revolve-relay`.
- Update the watcher: rebuild locally, `scp` the binary (D4), `systemctl restart revolve-worker`.
- Roll back Caddy: `cp /etc/caddy/Caddyfile.floorfight.bak /etc/caddy/Caddyfile && systemctl reload caddy`.
