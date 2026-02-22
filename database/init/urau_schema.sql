-- Build a clean, human-readable city reference table
-- Keeps the two raw source tables intact:
--   - urau.city_polygon   (MultiPolygon, SRID 3035)
--   - cities.city_point   (Point, SRID 3035)
-- Produces:
--   - cities.city         (one row per urau_code)

BEGIN;

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE SCHEMA IF NOT EXISTS cities;

-- Rebuild idempotently (safe for re-runs after each download)
DROP TABLE IF EXISTS cities.city CASCADE;

CREATE TABLE cities.city AS
SELECT
  -- stable identifiers
  p.urau_code                         AS city_id,
  p.cntr_code                         AS country_code,

  -- labels / categories
  p.urau_name                         AS city_name,
  p.urau_catg                         AS city_type,
  (p.city_cptl = 'Y')                 AS is_capital,

  -- center coordinates in WGS84 (lon/lat)
  ST_X(ST_Transform(pt.geom, 4326))   AS center_lon,
  ST_Y(ST_Transform(pt.geom, 4326))   AS center_lat,

  -- geometries
  pt.geom                             AS center_geom_3035,
  p.geom                              AS polygon_geom_3035
FROM urau.city_polygon p
LEFT JOIN cities.city_point pt
  ON pt.urau_code = p.urau_code
 AND pt.cntr_code = p.cntr_code;

-- Primary key on the stable city code
ALTER TABLE cities.city
  ADD CONSTRAINT city_pkey PRIMARY KEY (city_id);

-- Helpful indexes for spatial + common filters
CREATE INDEX city_country_code_idx ON cities.city (country_code);
CREATE INDEX city_city_type_idx    ON cities.city (city_type);
CREATE INDEX city_is_capital_idx   ON cities.city (is_capital);

CREATE INDEX city_center_geom_gix  ON cities.city USING gist (center_geom_3035);
CREATE INDEX city_polygon_geom_gix ON cities.city USING gist (polygon_geom_3035);

-- Optional: enforce expected SRIDs (won't fail if NULL)
ALTER TABLE cities.city
  ADD CONSTRAINT city_center_srid_chk
  CHECK (center_geom_3035 IS NULL OR ST_SRID(center_geom_3035) = 3035);

ALTER TABLE cities.city
  ADD CONSTRAINT city_polygon_srid_chk
  CHECK (polygon_geom_3035 IS NULL OR ST_SRID(polygon_geom_3035) = 3035);

COMMIT;
