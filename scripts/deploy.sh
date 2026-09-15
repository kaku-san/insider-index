#!/usr/bin/env bash
# Rsync this tree to the production host. Never copies secrets.
# Server env lives at /srv/projects/stocklana/.env (create it on the host).
set -euo pipefail

REMOTE="${DEPLOY_HOST:?set DEPLOY_HOST (user@host)}"
DEST="${DEPLOY_PATH:-/srv/projects/stocklana}"

rsync -az --delete \
  --exclude '.git/' \
  --exclude '.data/' \
  --exclude '.env' \
  --exclude '.env.*' \
  --exclude '.env.local' \
  --exclude '.env*.local' \
  --exclude 'node_modules/' \
  --exclude '.next/' \
  ./ "${REMOTE}:${DEST}/"

echo "Synced to ${REMOTE}:${DEST}"
echo "Production host: https://insiderindex.xyz"
echo "Secrets stay on the server .env (not rsynced)."
