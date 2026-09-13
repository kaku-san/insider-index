#!/usr/bin/env bash
# Rsync this tree to the Barely Stable box. Never copies secrets.
# Server env lives at /srv/projects/stocklana/.env (create it on the host).
set -euo pipefail

REMOTE="${DEPLOY_HOST:?set DEPLOY_HOST (user@host)}"
DEST="${DEPLOY_PATH:-/srv/projects/stocklana}"

rsync -az --delete \
  --exclude '.git/' \
  --exclude '.env' \
  --exclude '.env.local' \
  --exclude '.env*.local' \
  --exclude 'node_modules/' \
  --exclude '.next/' \
  ./ "${REMOTE}:${DEST}/"

echo "Synced to ${REMOTE}:${DEST}"
echo "Demo host: https://stocklana.barelystable.dev"
echo "Secrets stay on the server .env (not rsynced)."
