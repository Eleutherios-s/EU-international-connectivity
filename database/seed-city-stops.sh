#!/bin/sh
set -eu

echo "[CITY_STOPS] waiting for postgres..."

until pg_isready -h database --dbname="$POSTGRES_DB" --username="$POSTGRES_USER" >/dev/null 2>&1; do
  sleep 1
done

echo "[CITY_STOPS] checking if cities.city_stop exists..."

if psql -h database -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc \
"SELECT to_regclass('cities.city_stop') IS NOT NULL;" | tr -d '[:space:]' | grep -q '^t$'; then
  echo "[CITY_STOPS] cities.city_stop exists, truncating..."
  psql -h database -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -c \
    "TRUNCATE TABLE cities.city_stop;"
fi

echo "[CITY_STOPS] running city_stops.sql..."

psql -h database \
     -U "$POSTGRES_USER" \
     -d "$POSTGRES_DB" \
     -v ON_ERROR_STOP=1 \
     -f /init/city_stops.sql

echo "[CITY_STOPS] done."
