#!/usr/bin/env bash
# Builds everything the droplet needs that must not live in the repo, under
# ~/revolve-secrets/deploy (mode 700): the three env files and a snapshot of the
# watcher and worker databases. Prints no secrets.
#
#   worker/deploy/stage.sh <app origin, e.g. https://revolve-xyz.vercel.app>
set -euo pipefail

APP_ORIGIN=${1:?usage: stage.sh <app origin>}
case "$APP_ORIGIN" in https://*) ;; *) echo "app origin must be https://..." >&2; exit 1 ;; esac
APP_ORIGIN=${APP_ORIGIN%/}

REPO=$(cd "$(dirname "$0")/../.." && pwd)
OUT=${STAGE_DIR:-$HOME/revolve-secrets/deploy}
BIN=$REPO/solver/target/release/revolve-watcher
umask 077
mkdir -p "$OUT/state"

# Orchard-only key: the transparent and Sapling parts never reach the server.
UFVK=$(cd "$REPO/solver" && "$BIN" ufvk)
UA=$(cd "$REPO/solver" && "$BIN" address)
BIRTHDAY=$(grep '^REVOLVE_BIRTHDAY=' "$REPO/solver/.env" | cut -d= -f2)

cat > "$OUT/solver.env" <<EOF
REVOLVE_UFVK=$UFVK
REVOLVE_BIRTHDAY=$BIRTHDAY
REVOLVE_NETWORK=main
REVOLVE_LIGHTWALLETD=https://eu.zec.rocks:443
REVOLVE_TOR=1
REVOLVE_DATA_DIR=/opt/revolve/solver/data
REVOLVE_POLL_SECS=30
EOF

cat > "$OUT/worker.env" <<EOF
PORT=8787
APP_ORIGIN=$APP_ORIGIN
DEPOSIT_UA=$UA
DB_PATH=/opt/revolve/worker/data/worker.sqlite
WATCHER_BIN=/opt/revolve/solver/revolve-watcher
WATCHER_ENV_FILE=/opt/revolve/solver/.env
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
SOLANA_KEYPAIR_PATH=/opt/revolve/secrets/hotwallet.json
SOL_RESERVE_LAMPORTS=10000000
LAMPORTS_PER_ZEC=
SPREAD_BPS=150
SWAP_FEE_LAMPORTS=5000000
QUOTE_TTL_SECS=900
MAX_OPEN_ORDERS=20
EOF

cat > "$OUT/relay.env" <<EOF
APP_ORIGIN=$APP_ORIGIN
PORT=8788
HOST=127.0.0.1
SOLANA_RPC_URL=
JUP_API_KEY=
EOF

# Consistent copies via SQLite's backup API. The worker DB carries the settled
# note hashes (so a paid note is never reviewed or paid again) and review items.
python3 -I - "$REPO" "$OUT/state" <<'PY'
import sqlite3, sys
repo, out = sys.argv[1:]
for src, dst in [("solver/data/wallet.sqlite", "wallet.sqlite"), ("worker/data/worker.sqlite", "worker.sqlite")]:
    s = sqlite3.connect(f"file:{repo}/{src}?mode=ro", uri=True)
    d = sqlite3.connect(f"{out}/{dst}")
    s.backup(d)
    d.close()
    s.close()
w = sqlite3.connect(f"{out}/worker.sqlite")
open_orders = w.execute("SELECT COUNT(*) FROM orders WHERE status IN ('awaiting_payment','seen','confirmed','paying')").fetchone()[0]
settled = w.execute("SELECT COUNT(*) FROM settled_notes").fetchone()[0]
review = w.execute("SELECT COUNT(*) FROM review_notes").fetchone()[0]
print(f"state: {settled} settled notes, {review} review notes, {open_orders} open orders")
if open_orders:
    sys.exit("refusing: local worker still has open orders; settle them before moving")
PY

echo "staged in $OUT:"
echo "  solver.env  (Orchard-only UFVK, ${#UFVK} chars), worker.env, relay.env, state/"
echo "  deposit UA  ${UA:0:12}..."
