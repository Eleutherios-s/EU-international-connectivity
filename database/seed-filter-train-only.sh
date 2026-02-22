#!/bin/sh
set -eu

echo "[FILTER_TRAIN] waiting for postgres..."
until pg_isready -h database --dbname="$POSTGRES_DB" --username="$POSTGRES_USER"; do
  sleep 1
done
echo "[FILTER_TRAIN] postgres is ready"

echo "[FILTER_TRAIN] checking if gtfs_train.routes already built..."
if psql -h database -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc \
"SELECT 1 FROM information_schema.tables WHERE table_schema='gtfs_train' AND table_name='routes' LIMIT 1;" | grep -q 1 \
&& psql -h database -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc \
"SELECT 1 FROM gtfs_train.routes LIMIT 1;" | grep -q 1; then
  echo "[FILTER_TRAIN] gtfs_train already present, skipping"
  exit 0
fi

echo "[FILTER_TRAIN] running filter_train_only.sql ..."
psql -h database -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
  -f /init/filter_train_only.sql

echo "[FILTER_TRAIN] done."
