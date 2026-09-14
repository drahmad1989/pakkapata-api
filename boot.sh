#!/bin/bash
# PakkaPata boot script — runs inside ClawCloud container (node:20 image)
set -e
cd /app

export NODE_ENV=production
export DB_PATH=./data/geopata.db
export PORT="${PORT:-7860}"

echo "[boot] PakkaPata v0.10.9 boot starting..."
echo "[boot] installing dependencies (1-2 min)..."
npm install --omit=dev --no-audit --no-fund --loglevel=error

mkdir -p data
if [ ! -f data/geopata.db ]; then
  echo "[boot] restoring database from private dataset..."
  curl -sL --fail -H "Authorization: Bearer $HF_TOKEN" \
    "https://huggingface.co/datasets/dr1989/pakkapata-db/resolve/main/GEOPATA_DB_BACKUP.db.gz" \
    -o /tmp/db.gz
  gunzip -c /tmp/db.gz > data/geopata.db
  rm -f /tmp/db.gz
  echo "[boot] database restored:"
  ls -la data/
else
  echo "[boot] database already present, skipping restore"
fi

echo "[boot] starting server on port $PORT..."
exec node server.js
