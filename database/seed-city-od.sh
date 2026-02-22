#!/bin/sh
set -eu

echo "[CITY_OD] checking if analysis.city_od_min_time exists..."

EXISTS=$(psql -h database -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "
SELECT to_regclass('analysis.city_od_min_time') IS NOT NULL;
")

if [ "$EXISTS" = "t" ]; then
  echo "[CITY_OD] table already exists. Skipping rebuild."
  exit 0
fi

echo "[CITY_OD] building..."
psql -h database -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -v ON_ERROR_STOP=1 \
  -f /init/city-od-min-time.sql

echo "[CITY_OD] done."
