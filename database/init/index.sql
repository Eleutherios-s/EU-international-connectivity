BEGIN;

CREATE SCHEMA IF NOT EXISTS analysis;

-- ============================================================
-- (A1) Cross-border routes, by (gtfs_country, route_id)
-- ============================================================
DROP MATERIALIZED VIEW IF EXISTS analysis.crossborder_route_keys CASCADE;

CREATE MATERIALIZED VIEW analysis.crossborder_route_keys AS
SELECT
  r.gtfs_country,
  r.route_id
FROM gtfs_train.routes r
JOIN gtfs_train.trips t
  ON t.gtfs_country = r.gtfs_country
 AND t.route_id     = r.route_id
JOIN gtfs_train.stop_times st
  ON st.gtfs_country = t.gtfs_country
 AND st.trip_id      = t.trip_id
JOIN cities.city_stop cs
  ON cs.gtfs_country = st.gtfs_country
 AND cs.stop_id      = st.stop_id
JOIN cities.city c
  ON c.city_id = cs.city_id
GROUP BY r.gtfs_country, r.route_id
HAVING COUNT(DISTINCT c.country_code) >= 2;

CREATE UNIQUE INDEX IF NOT EXISTS uq_crossborder_route_keys
  ON analysis.crossborder_route_keys (gtfs_country, route_id);

CREATE INDEX IF NOT EXISTS idx_crossborder_route_keys_route
  ON analysis.crossborder_route_keys (route_id);


-- ============================================================
-- (Perf) Optional supporting indexes (skip if already exist)
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_stop_times_trip
  ON gtfs_train.stop_times (gtfs_country, trip_id);

CREATE INDEX IF NOT EXISTS idx_stop_times_stop
  ON gtfs_train.stop_times (gtfs_country, stop_id);

CREATE INDEX IF NOT EXISTS idx_trips_trip
  ON gtfs_train.trips (gtfs_country, trip_id);

CREATE INDEX IF NOT EXISTS idx_trips_route
  ON gtfs_train.trips (gtfs_country, route_id);

CREATE INDEX IF NOT EXISTS idx_city_stop_city
  ON cities.city_stop (city_id);

CREATE INDEX IF NOT EXISTS idx_city_stop_stop
  ON cities.city_stop (gtfs_country, stop_id);


-- ============================================================
-- (A2) TABLE 1: City -> route_dict + route_count
-- ============================================================
DROP MATERIALIZED VIEW IF EXISTS analysis.city_intl_routes_raw CASCADE;

CREATE MATERIALIZED VIEW analysis.city_intl_routes_raw AS
WITH city_route_foreign_stop AS (
  SELECT DISTINCT
    home.city_id,
    home.city_name,
    home.country_code,

    (r.gtfs_country || ':' || r.route_id) AS route_key,

    fcs.stop_id AS foreign_stop_id,
    fcs.stop_lon AS foreign_stop_lon,
    fcs.stop_lat AS foreign_stop_lat,

    foreign_city.country_code AS foreign_country_code,
    foreign_city.city_id      AS foreign_city_id,
    foreign_city.city_name    AS foreign_city_name

  FROM cities.city home

  JOIN cities.city_stop home_cs
    ON home_cs.city_id = home.city_id

  JOIN gtfs_train.stop_times home_st
    ON home_st.gtfs_country = home_cs.gtfs_country
   AND home_st.stop_id      = home_cs.stop_id

  JOIN gtfs_train.trips t
    ON t.gtfs_country = home_st.gtfs_country
   AND t.trip_id      = home_st.trip_id

  JOIN gtfs_train.routes r
    ON r.gtfs_country = t.gtfs_country
   AND r.route_id     = t.route_id

  -- only cross-border routes
  JOIN analysis.crossborder_route_keys cb
    ON cb.gtfs_country = r.gtfs_country
   AND cb.route_id     = r.route_id

  -- any stop on the same trip that belongs to a foreign city
  JOIN gtfs_train.stop_times fst
    ON fst.gtfs_country = t.gtfs_country
   AND fst.trip_id      = t.trip_id

  JOIN cities.city_stop fcs
    ON fcs.gtfs_country = fst.gtfs_country
   AND fcs.stop_id      = fst.stop_id

  JOIN cities.city foreign_city
    ON foreign_city.city_id = fcs.city_id

  WHERE foreign_city.country_code <> home.country_code
),
per_city_per_route AS (
  SELECT
    city_id,
    city_name,
    country_code,
    route_key,

    jsonb_object_agg(
      foreign_stop_id,
      jsonb_build_object(
        'stop_lon', foreign_stop_lon,
        'stop_lat', foreign_stop_lat,
        'country_code', foreign_country_code,
        'city_id', foreign_city_id,
        'city_name', foreign_city_name
      )
      ORDER BY foreign_stop_id
    ) AS foreign_stops,

    COUNT(DISTINCT foreign_stop_id) AS foreign_stop_count
  FROM city_route_foreign_stop
  GROUP BY city_id, city_name, country_code, route_key
)
SELECT
  city_id,
  city_name,
  country_code,

  jsonb_object_agg(
    route_key,
    jsonb_build_object(
      'foreign_stops', foreign_stops,
      'foreign_stop_count', foreign_stop_count
    )
    ORDER BY route_key
  ) AS route_dict,

  COUNT(*) AS route_count
FROM per_city_per_route
GROUP BY city_id, city_name, country_code;

CREATE UNIQUE INDEX IF NOT EXISTS uq_city_intl_routes_raw_city
  ON analysis.city_intl_routes_raw (city_id);


DROP VIEW IF EXISTS analysis.city_intl_routes CASCADE;

CREATE VIEW analysis.city_intl_routes AS
WITH stats AS (
  SELECT MIN(route_count) AS mn, MAX(route_count) AS mx
  FROM analysis.city_intl_routes_raw
)
SELECT
  r.city_id, r.city_name, r.country_code,
  r.route_dict,
  r.route_count,
  CASE WHEN s.mx = s.mn THEN 0
       ELSE (r.route_count - s.mn)::numeric / (s.mx - s.mn)
  END AS route_count_norm
FROM analysis.city_intl_routes_raw r
CROSS JOIN stats s;


-- ============================================================
-- (A3) TABLE 2: City -> trip_count (based on cross-border route keys)
-- ============================================================
DROP MATERIALIZED VIEW IF EXISTS analysis.city_intl_trips_raw CASCADE;

CREATE MATERIALIZED VIEW analysis.city_intl_trips_raw AS
WITH city_trip AS (
  SELECT DISTINCT
    home.city_id,
    home.city_name,
    home.country_code,
    t.gtfs_country,
    t.trip_id
  FROM cities.city home
  JOIN cities.city_stop home_cs
    ON home_cs.city_id = home.city_id
  JOIN gtfs_train.stop_times home_st
    ON home_st.gtfs_country = home_cs.gtfs_country
   AND home_st.stop_id      = home_cs.stop_id
  JOIN gtfs_train.trips t
    ON t.gtfs_country = home_st.gtfs_country
   AND t.trip_id      = home_st.trip_id
  JOIN analysis.crossborder_route_keys cb
    ON cb.gtfs_country = t.gtfs_country
   AND cb.route_id     = t.route_id
)
SELECT
  city_id,
  city_name,
  country_code,
  COUNT(*) AS trip_count
FROM city_trip
GROUP BY city_id, city_name, country_code;

CREATE UNIQUE INDEX IF NOT EXISTS uq_city_intl_trips_raw_city
  ON analysis.city_intl_trips_raw (city_id);


DROP VIEW IF EXISTS analysis.city_intl_trips CASCADE;

CREATE VIEW analysis.city_intl_trips AS
WITH stats AS (
  SELECT MIN(trip_count) AS mn, MAX(trip_count) AS mx
  FROM analysis.city_intl_trips_raw
)
SELECT
  t.city_id, t.city_name, t.country_code,
  t.trip_count,
  CASE WHEN s.mx = s.mn THEN 0
       ELSE (t.trip_count - s.mn)::numeric / (s.mx - s.mn)
  END AS trip_count_norm
FROM analysis.city_intl_trips_raw t
CROSS JOIN stats s;


-- ============================================================
-- (A4) Optional: city representative coordinate from STOPs
-- ============================================================
DROP MATERIALIZED VIEW IF EXISTS analysis.city_stop_centroid CASCADE;

CREATE MATERIALIZED VIEW analysis.city_stop_centroid AS
SELECT
  cs.city_id,
  MIN(c.city_name) AS city_name,
  MIN(c.country_code) AS country_code,
  AVG(cs.stop_lon)::double precision AS stop_center_lon,
  AVG(cs.stop_lat)::double precision AS stop_center_lat,
  COUNT(*) AS stop_count
FROM cities.city_stop cs
JOIN cities.city c
  ON c.city_id = cs.city_id
GROUP BY cs.city_id;

CREATE UNIQUE INDEX IF NOT EXISTS uq_city_stop_centroid_city
  ON analysis.city_stop_centroid (city_id);


-- ============================================================
-- (A5) City -> CROSSBORDER SHAPE keys (international only)
-- ============================================================
DROP MATERIALIZED VIEW IF EXISTS analysis.city_crossborder_shape_keys CASCADE;

CREATE MATERIALIZED VIEW analysis.city_crossborder_shape_keys AS
WITH
city_stop AS (
  SELECT gtfs_country, city_id, stop_id
  FROM cities.city_stop
),
trip_city AS (
  SELECT DISTINCT st.gtfs_country, st.trip_id, cs.city_id
  FROM gtfs_train.stop_times st
  JOIN city_stop cs
    ON cs.gtfs_country = st.gtfs_country
   AND cs.stop_id      = st.stop_id
),
trip_pairs AS (
  SELECT
    a.gtfs_country,
    a.city_id AS from_city_id,
    b.city_id AS to_city_id,
    a.trip_id
  FROM trip_city a
  JOIN trip_city b
    ON b.gtfs_country = a.gtfs_country
   AND b.trip_id      = a.trip_id
  WHERE a.city_id <> b.city_id
),
crossborder_pairs AS (
  SELECT tp.*
  FROM trip_pairs tp
  JOIN cities.city ca ON ca.city_id = tp.from_city_id
  JOIN cities.city cb ON cb.city_id = tp.to_city_id
  WHERE ca.country_code <> cb.country_code
),
trip_shapes AS (
  SELECT
    cp.gtfs_country,
    cp.from_city_id AS city_id,
    t.shape_id,
    cp.trip_id
  FROM crossborder_pairs cp
  JOIN gtfs_train.trips t
    ON t.gtfs_country = cp.gtfs_country
   AND t.trip_id      = cp.trip_id
  WHERE t.shape_id IS NOT NULL
)
SELECT
  gtfs_country,
  city_id,
  shape_id,
  COUNT(DISTINCT trip_id)::int AS trip_n
FROM trip_shapes
GROUP BY gtfs_country, city_id, shape_id;

CREATE UNIQUE INDEX IF NOT EXISTS uq_city_crossborder_shape_keys
  ON analysis.city_crossborder_shape_keys (gtfs_country, city_id, shape_id);

CREATE INDEX IF NOT EXISTS idx_city_crossborder_shape_keys_city
  ON analysis.city_crossborder_shape_keys (city_id);


-- ============================================================
-- (A6) City -> ALL SHAPE keys (domestic + crossborder)
-- ============================================================
DROP MATERIALIZED VIEW IF EXISTS analysis.city_shape_keys CASCADE;

CREATE MATERIALIZED VIEW analysis.city_shape_keys AS
WITH
city_stop AS (
  SELECT gtfs_country, city_id, stop_id
  FROM cities.city_stop
),
trip_city AS (
  SELECT DISTINCT st.gtfs_country, st.trip_id, cs.city_id
  FROM gtfs_train.stop_times st
  JOIN city_stop cs
    ON cs.gtfs_country = st.gtfs_country
   AND cs.stop_id      = st.stop_id
),
trip_shapes AS (
  SELECT
    tc.gtfs_country,
    tc.city_id,
    t.shape_id,
    tc.trip_id
  FROM trip_city tc
  JOIN gtfs_train.trips t
    ON t.gtfs_country = tc.gtfs_country
   AND t.trip_id      = tc.trip_id
  WHERE t.shape_id IS NOT NULL
)
SELECT
  gtfs_country,
  city_id,
  shape_id,
  COUNT(DISTINCT trip_id)::int AS trip_n
FROM trip_shapes
GROUP BY gtfs_country, city_id, shape_id;

CREATE UNIQUE INDEX IF NOT EXISTS uq_city_shape_keys
  ON analysis.city_shape_keys (gtfs_country, city_id, shape_id);

CREATE INDEX IF NOT EXISTS idx_city_shape_keys_city
  ON analysis.city_shape_keys (city_id);

COMMIT;
