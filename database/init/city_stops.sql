BEGIN;

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE SCHEMA IF NOT EXISTS cities;

-- 1) target table (NOW WITH gtfs_country)
CREATE TABLE IF NOT EXISTS cities.city_stop (
  gtfs_country    text NOT NULL,
  stop_id         text NOT NULL,
  city_id         text NOT NULL REFERENCES cities.city(city_id) ON DELETE CASCADE,
  stop_name       text,
  stop_lat        double precision,
  stop_lon        double precision,
  stop_geom_3035  geometry(Point, 3035) NOT NULL,
  PRIMARY KEY (gtfs_country, stop_id)
);

CREATE INDEX IF NOT EXISTS city_stop_city_idx
  ON cities.city_stop (city_id);

CREATE INDEX IF NOT EXISTS city_stop_country_idx
  ON cities.city_stop (gtfs_country);

CREATE INDEX IF NOT EXISTS city_stop_geom_gix
  ON cities.city_stop USING gist (stop_geom_3035);

-- 2) fill table with stops: lon/lat (EPSG:4326)
WITH cleaned AS (
  SELECT
    s.*,
    CASE
      WHEN s.stop_lat BETWEEN -90 AND 90 AND s.stop_lon BETWEEN -180 AND 180 THEN s.stop_lat
      WHEN s.stop_lon BETWEEN -90 AND 90 AND s.stop_lat BETWEEN -180 AND 180 THEN s.stop_lon
      ELSE NULL
    END AS lat_ok,
    CASE
      WHEN s.stop_lat BETWEEN -90 AND 90 AND s.stop_lon BETWEEN -180 AND 180 THEN s.stop_lon
      WHEN s.stop_lon BETWEEN -90 AND 90 AND s.stop_lat BETWEEN -180 AND 180 THEN s.stop_lat
      ELSE NULL
    END AS lon_ok
  FROM gtfs_train.stops s
)
INSERT INTO cities.city_stop (gtfs_country, stop_id, city_id, stop_name, stop_lat, stop_lon, stop_geom_3035)
SELECT
  s.gtfs_country,
  s.stop_id,
  c.city_id,
  s.stop_name,
  s.lat_ok,
  s.lon_ok,
  ST_Transform(
    ST_SetSRID(ST_MakePoint(s.lon_ok, s.lat_ok), 4326),
    3035
  ) AS stop_geom_3035
FROM cleaned s
JOIN cities.city c
  ON c.polygon_geom_3035 IS NOT NULL
WHERE s.lat_ok IS NOT NULL
  AND s.lon_ok IS NOT NULL
  AND NOT (s.lat_ok = 0 AND s.lon_ok = 0)
  AND ST_Intersects(
        c.polygon_geom_3035,
        ST_Transform(ST_SetSRID(ST_MakePoint(s.lon_ok, s.lat_ok), 4326), 3035)
      )
ON CONFLICT (gtfs_country, stop_id) DO NOTHING;

COMMIT;
