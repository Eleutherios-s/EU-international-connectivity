#!/bin/sh
set -eu

# Seed: import two "city reference" layers
#  1) Cities points (LB): URAU_RG_2024_3035_CITIES.gpkg
#  2) City/FUA polygon: URAU_RG_2024_3035.gpkg OR your chosen polygon dataset
#
# Target tables (stable names, avoid confusing "gpkg" table names):
#   cities.city_point      (Point, SRID 3035)
#   urau.city_polygon     (MultiPolygon, SRID 3035)

echo "[CITIES] waiting for postgres..."
until pg_isready -h database --dbname="$POSTGRES_DB" --username="$POSTGRES_USER" >/dev/null 2>&1; do
  sleep 1
done
echo "[CITIES] postgres is ready"

# ---- URL defaults (override via .env) ----
# IMPORTANT: do NOT wrap these in quotes in .env.
: "${CITIES_LB_URL:=https://gisco-services.ec.europa.eu/distribution/v2/urau/gpkg/URAU_LB_2024_3035_CITIES.gpkg}"
: "${URAU_RG_URL:=https://gisco-services.ec.europa.eu/distribution/v2/urau/gpkg/URAU_RG_100K_2024_3035_CITIES.gpkg}"

# If you *really* want to keep the /gpkg/ form in .env, the downloader below will try a fallback without /gpkg/.
WORKDIR="/tmp/cities"
CITIES_LB_GPKG="$WORKDIR/URAU_RG_2024_3035_CITIES.gpkg"
URAU_RG_GPKG="$WORKDIR/URAU_RG_100K_2024_3035_CITIES.gpkg"

rm -rf "$WORKDIR"
mkdir -p "$WORKDIR"

# Strip accidental quotes from .env values (common cause of 404)
CITIES_LB_URL=$(printf "%s" "$CITIES_LB_URL" | tr -d '"')
URAU_RG_URL=$(printf "%s" "$URAU_RG_URL" | tr -d '"')

psql_cmd='psql -h database --dbname="$POSTGRES_DB" --username="$POSTGRES_USER" -tAc'
pg_dsn="PG:dbname=$POSTGRES_DB host=database user=$POSTGRES_USER password=$POSTGRES_PASSWORD"

table_exists(){
  # $1 = regclass string like '"schema"."table"'
  eval $psql_cmd "\"SELECT to_regclass('$1') IS NOT NULL;\"" | tr -d '[:space:]' | grep -q '^t$'
}

download(){
  # $1=url $2=out $3=fallback(optional)
  url="$1"; out="$2"; fb="${3:-}"
  echo "[CITIES] downloading: $url"
  if ! curl -L --fail --retry 5 --retry-delay 2 -o "$out" "$url"; then
    if [ -n "$fb" ]; then
      echo "[CITIES] download failed, trying fallback: $fb"
      curl -L --fail --retry 5 --retry-delay 2 -o "$out" "$fb"
    else
      echo "[CITIES] ERROR: download failed: $url" >&2
      exit 1
    fi
  fi
}

# Create target schemas (idempotent)
echo "[CITIES] ensuring schemas exist (cities, urau)"
psql -h database --dbname="$POSTGRES_DB" --username="$POSTGRES_USER" -v ON_ERROR_STOP=1 <<'SQL'
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE SCHEMA IF NOT EXISTS cities;
CREATE SCHEMA IF NOT EXISTS urau;
SQL

# ---- 1) Cities points (LB) -> cities.city_point ----
if table_exists '"cities"."city_point"'; then
  echo "[CITIES] cities.city_point already present, skipping import"
else
  # fallback: if user provided .../urau/gpkg/... try .../urau/...
  CITIES_LB_FALLBACK=$(printf "%s" "$CITIES_LB_URL" | sed 's#/urau/gpkg/#/urau/#')
  if [ "$CITIES_LB_FALLBACK" = "$CITIES_LB_URL" ]; then
    CITIES_LB_FALLBACK=""
  fi

  download "$CITIES_LB_URL" "$CITIES_LB_GPKG" "$CITIES_LB_FALLBACK"

  echo "[CITIES] importing city points -> cities.city_point"
  ogr2ogr -f PostgreSQL "$pg_dsn" \
    "$CITIES_LB_GPKG" \
    -lco SCHEMA=cities \
    -nln city_point \
    -lco GEOMETRY_NAME=geom \
    -lco FID=fid \
    -nlt POINT \
    -lco OVERWRITE=YES
fi

# ---- 2) URAU polygon -> urau.city_polygon ----
if table_exists '"urau"."city_polygon"'; then
  echo "[CITIES] urau.city_polygon already present, skipping import"
else
  URAU_RG_FALLBACK=$(printf "%s" "$URAU_RG_URL" | sed 's#/urau/gpkg/#/urau/#')
  if [ "$URAU_RG_FALLBACK" = "$URAU_RG_URL" ]; then
    URAU_RG_FALLBACK=""
  fi

  download "$URAU_RG_URL" "$URAU_RG_GPKG" "$URAU_RG_FALLBACK"

  echo "[CITIES] importing polygon -> urau.city_polygon"
  ogr2ogr -f PostgreSQL "$pg_dsn" \
    "$URAU_RG_GPKG" \
    -lco SCHEMA=urau \
    -nln city_polygon \
    -lco GEOMETRY_NAME=geom \
    -lco FID=fid \
    -nlt PROMOTE_TO_MULTI \
    -lco OVERWRITE=YES
fi

echo "[CITIES] done"


# ---- 3) Build clean reference table (cities.city) ----
# Runs every time so the derived table stays in sync after each download/import.
: "${CITY_REF_SQL:=/init/urau_schema.sql}"

if [ -f "$CITY_REF_SQL" ]; then
  echo "[CITIES] building clean city reference table -> cities.city"
  psql -h database --dbname="$POSTGRES_DB" --username="$POSTGRES_USER" -v ON_ERROR_STOP=1 -f "$CITY_REF_SQL"
else
  echo "[CITIES] WARNING: CITY_REF_SQL not found at $CITY_REF_SQL (skipping)"
fi


