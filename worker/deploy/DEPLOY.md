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
It (and the worker at startup) refuses a key path inside a git work tree or under
worker/, relay/, app/ or solver/; /opt/revolve/secrets is fine. If the worker
cannot load the key it still starts, logs `!!! MINT UNAVAILABLE`, and answers
`/mint/*` with 503 `mint_unavailable`. Replacing the key later invalidates every unspent credit, so do this once.

```bash
cd /opt/revolve/worker && sudo -u revolve node src/mint-keygen.ts /opt/revolve/secrets/mint-key.pem
ls -l /opt/revolve/secrets/mint-key.pem                   # -rw------- revolve revolve
grep -E '^MINT_KEY_(PATH|ID)=' /opt/revolve/worker/.env  # both set (stage.sh writes them)
```

## D5c [droplet] Base hot wallet (optional)

Base payouts (API_CONTRACT.md v1.4) need one EVM key, generated on the droplet
as `revolve` like the mint key, with the same path rules. Without it, or if it
can't be loaded, the worker logs `!!! BASE UNAVAILABLE` and runs Solana only;
`/limits` then has no `base` entry and the app shows Base as unavailable.

```bash
cd /opt/revolve/worker && sudo -u revolve node src/evm-keygen.ts /opt/revolve/secrets/evm-hotwallet.key   # prints the address
ls -l /opt/revolve/secrets/evm-hotwallet.key              # -rw------- revolve revolve
grep -E '^(EVM_KEY_PATH|BASE_)' /opt/revolve/worker/.env  # stage.sh writes these
```

Send ETH **on Base** to the printed address. Base inventory is
min(balance, `BASE_HOT_WALLET_CAP_WEI`) less `BASE_RESERVE_WEI` (0.0002 ETH by
default, for payout gas). Each payout adds `BASE_GAS_ALLOWANCE_WEI` (0.00003 ETH)
for the fresh wallet's own swap gas.

## D5d [droplet] Withdrawal hot wallet (optional)

Withdrawals of credits to shielded ZEC (CREDITS_CONTRACT.md v1.5) are paid from a
separate ZEC wallet with its own seed, never from the deposit address. Without it
the worker logs `!!! WITHDRAWALS UNAVAILABLE` and `/withdrawals` answers 503;
cash-ins to credits still work.

```bash
mkdir -p /opt/revolve/solver/data/payer && chown revolve:revolve /opt/revolve/solver/data/payer
sudo -u revolve /opt/revolve/solver/revolve-watcher payer-keygen /opt/revolve/secrets/zec-payer.seed
cat > /opt/revolve/solver/payer.env <<'EOF'
REVOLVE_PAYER_SEED_PATH=/opt/revolve/secrets/zec-payer.seed
REVOLVE_PAYER_BIRTHDAY=<current block height, from a block explorer>
REVOLVE_PAYER_DATA_DIR=/opt/revolve/solver/data/payer
REVOLVE_NETWORK=main
REVOLVE_LIGHTWALLETD=https://eu.zec.rocks:443
REVOLVE_TOR=1
EOF
chown revolve:revolve /opt/revolve/solver/payer.env && chmod 600 /opt/revolve/solver/payer.env
sudo -u revolve REVOLVE_ENV_FILE=/opt/revolve/solver/payer.env /opt/revolve/solver/revolve-watcher payer-address   # fund this u1… address
printf 'ZEC_PAYER_ENV_FILE=/opt/revolve/solver/payer.env\nWITHDRAW_DAILY_CAP_ZAT=50000000\n' >> /opt/revolve/worker/.env
```

Send ZEC to the printed address from the deposit wallet (Zodl), only as much as
withdrawals need for a while: it is a hot wallet. `payer-balance` (same env) syncs
and prints what is spendable; the worker checks it every 5 minutes and refuses
withdrawals it couldn't pay (the credits stay unspent).

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
- Update code: rerun D4's `git archive` line, run D5's two `npm ci` lines if a `package-lock.json` changed, then `systemctl restart revolve-worker revolve-relay`.
- Update the watcher (and the payer, same binary): CI builds it on every change to `solver/` and publishes it on the `watcher-latest` release (`.github/workflows/watcher.yml`). On the droplet:
  ```bash
  cd /tmp && R=https://github.com/UEddy/revolve/releases/download/watcher-latest
  curl -fsSLO $R/revolve-watcher && curl -fsSLO $R/revolve-watcher.sha256 && sha256sum -c revolve-watcher.sha256
  install -o revolve -g revolve -m 755 revolve-watcher /opt/revolve/solver/revolve-watcher && systemctl restart revolve-worker
  ```
- Roll back Caddy: `cp /etc/caddy/Caddyfile.floorfight.bak /etc/caddy/Caddyfile && systemctl reload caddy`.
