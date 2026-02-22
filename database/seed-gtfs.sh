#!/bin/sh
set -eu

echo "[GTFS] waiting for postgres..."
until pg_isready -h database --dbname="$POSTGRES_DB" --username="$POSTGRES_USER" >/dev/null 2>&1; do
  sleep 1
done
echo "[GTFS] postgres is ready"

# Prefer CSV source list; fallback to GTFS_URL (single country)
GTFS_SOURCES_CSV="${GTFS_SOURCES_CSV:-}"

copy_by_header () {
  table="$1"
  file="$2"

  if [ ! -f "$file" ]; then
    echo "[GTFS] skip missing $(basename "$file")"
    return 0
  fi

  cols=$(head -n 1 "$file" | tr -d '\r')
  echo "[GTFS] importing $(basename "$file") -> $table"
  psql -h database --dbname="$POSTGRES_DB" --username="$POSTGRES_USER" -v ON_ERROR_STOP=1 -c \
    "\copy $table($cols) FROM '$file' WITH (FORMAT csv, HEADER true, NULL '');"
}

set_country_defaults () {
  cc="$1"
  echo "[GTFS][$cc] setting default gtfs_country on tables"
  for t in agency routes stops calendar calendar_dates trips stop_times shapes frequencies levels pathways transfers; do
    psql -h database --dbname="$POSTGRES_DB" --username="$POSTGRES_USER" -v ON_ERROR_STOP=1 -c \
      "ALTER TABLE gtfs.${t} ALTER COLUMN gtfs_country SET DEFAULT '${cc}';"
  done
}

import_one () {
  cc="$1"
  url="$2"

  echo "[GTFS][$cc] checking if already imported..."
  if psql -h database --dbname="$POSTGRES_DB" --username="$POSTGRES_USER" \
    -tAc "SELECT 1 FROM gtfs.agency WHERE gtfs_country='${cc}' LIMIT 1;" | grep -q 1; then
    echo "[GTFS][$cc] already present, skipping"
    return 0
  fi

  WORKDIR="/tmp/gtfs_${cc}"
  ZIP="$WORKDIR/gtfs.zip"
  rm -rf "$WORKDIR"
  mkdir -p "$WORKDIR"

  echo "[GTFS][$cc] downloading: $url"
  curl -L --fail --retry 5 --retry-delay 2 -o "$ZIP" "$url"

  echo "[GTFS][$cc] unzip"
  unzip -q "$ZIP" -d "$WORKDIR"

  set_country_defaults "$cc"

  # GTFS imports
  copy_by_header gtfs.agency          "$WORKDIR/agency.txt"
  copy_by_header gtfs.routes          "$WORKDIR/routes.txt"
  copy_by_header gtfs.stops           "$WORKDIR/stops.txt"
  copy_by_header gtfs.calendar        "$WORKDIR/calendar.txt"
  copy_by_header gtfs.calendar_dates  "$WORKDIR/calendar_dates.txt"
  copy_by_header gtfs.trips           "$WORKDIR/trips.txt"
  copy_by_header gtfs.stop_times      "$WORKDIR/stop_times.txt"
  copy_by_header gtfs.shapes          "$WORKDIR/shapes.txt"
  copy_by_header gtfs.frequencies     "$WORKDIR/frequencies.txt"
  copy_by_header gtfs.levels          "$WORKDIR/levels.txt"
  copy_by_header gtfs.pathways        "$WORKDIR/pathways.txt"
  copy_by_header gtfs.transfers       "$WORKDIR/transfers.txt"

  echo "[GTFS][$cc] import done"
}

if [ -n "$GTFS_SOURCES_CSV" ] && [ -f "$GTFS_SOURCES_CSV" ]; then
  echo "[GTFS] reading sources from CSV: $GTFS_SOURCES_CSV"
  tail -n +2 "$GTFS_SOURCES_CSV" | while IFS=, read -r cc url; do
    cc="$(echo "$cc" | tr '[:upper:]' '[:lower:]' | xargs)"
    url="$(echo "$url" | xargs)"
    [ -z "$cc" ] && continue
    [ -z "$url" ] && continue
    import_one "$cc" "$url"
  done
else
  : "${GTFS_URL:?GTFS_URL is not set and GTFS_SOURCES_CSV missing}"
  cc="${GTFS_COUNTRY:-de}"
  echo "[GTFS] no CSV, importing single country: $cc"
  import_one "$cc" "$GTFS_URL"
fi

echo "[GTFS] checking constraints..."
if psql -h database --dbname="$POSTGRES_DB" --username="$POSTGRES_USER" -tAc \
  "SELECT 1 FROM pg_constraint WHERE conname='agency_pkey' LIMIT 1;" | grep -q 1; then
  echo "[GTFS] constraints already present, skipping"
else
  echo "[GTFS] applying constraints"
  psql -h database --dbname="$POSTGRES_DB" --username="$POSTGRES_USER" -v ON_ERROR_STOP=1 -f /init/gtfs_constraints.sql
fi


echo "[GTFS] done"
