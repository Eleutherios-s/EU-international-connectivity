#!/bin/sh
set -eu

echo "[INDEX] waiting for postgres..."

until pg_isready -h database --dbname="$POSTGRES_DB" --username="$POSTGRES_USER" >/dev/null 2>&1; do
  sleep 1
done

echo "[INDEX] checking if analysis.crossborder_route_keys already built..."
if psql -h database --dbname="$POSTGRES_DB" --username="$POSTGRES_USER" -tAc \
"SELECT to_regclass('analysis.crossborder_route_keys') IS NOT NULL;" | tr -d '[:space:]' | grep -q '^t$'; then
  echo "[INDEX] analysis already present, skipping"
  exit 0
fi

echo "[INDEX] running index.sql..."

psql -h database \
     -U "$POSTGRES_USER" \
     -d "$POSTGRES_DB" \
     -v ON_ERROR_STOP=1 \
     -f /init/index.sql

echo "[INDEX] done."
