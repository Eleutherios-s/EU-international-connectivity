-- =========================================================
-- city-od-min-time.sql
-- Build directed city-to-city robust in-vehicle time (p25 of dt_sec)
-- and store representative stop coordinates (EPSG:4326).
-- =========================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS analysis;

-- ---------- helper: parse GTFS time "HH:MM:SS" (supports HH>24) to seconds ----------
CREATE OR REPLACE FUNCTION analysis.gtfs_time_to_sec(t text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT
    CASE
      WHEN t IS NULL OR t = '' THEN NULL
      ELSE
        split_part(t, ':', 1)::int * 3600 +
        split_part(t, ':', 2)::int * 60 +
        split_part(t, ':', 3)::int
    END
$$;

-- ---------- target table ----------
CREATE TABLE IF NOT EXISTS analysis.city_od_min_time (
  gtfs_country   text NOT NULL,
  from_city_id   text NOT NULL,
  to_city_id     text NOT NULL,

  -- store representative STOP coords (EPSG:4326)
  from_lon       double precision,
  from_lat       double precision,
  to_lon         double precision,
  to_lat         double precision,

  -- robust in-vehicle time (p25 of dt_sec, seconds)
  min_time_sec   integer NOT NULL,

  -- debug lineage (witness edge)
  sample_trip_id text,
  from_stop_id   text,
  to_stop_id     text,

  updated_at     timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (gtfs_country, from_city_id, to_city_id)
);

CREATE INDEX IF NOT EXISTS idx_city_od_from
  ON analysis.city_od_min_time (gtfs_country, from_city_id);

CREATE INDEX IF NOT EXISTS idx_city_od_to
  ON analysis.city_od_min_time (gtfs_country, to_city_id);

-- ---------- speed: recommended indexes on base tables ----------
CREATE INDEX IF NOT EXISTS idx_stop_times_trip_seq
  ON gtfs_train.stop_times (gtfs_country, trip_id, stop_sequence);

CREATE INDEX IF NOT EXISTS idx_stop_times_stop
  ON gtfs_train.stop_times (gtfs_country, stop_id);

CREATE INDEX IF NOT EXISTS idx_city_stop_stop
  ON cities.city_stop (gtfs_country, stop_id);

CREATE INDEX IF NOT EXISTS idx_city_stop_city
  ON cities.city_stop (gtfs_country, city_id);

-- ---------- build/refresh ----------
-- Strategy:
-- 1) compute (trip, from_city, to_city) candidate dt_sec > 0 with direction (seq_from < seq_to)
-- 2) take p25(dt_sec) per (gtfs_country, from_city, to_city) as min_time_sec (robust)
-- 3) pick one witness row closest to p25 (NOT equality match)
-- 4) store witness stop coordinates (stop_lon/stop_lat) into from/to lon/lat

WITH
st AS (
  SELECT
    st.gtfs_country,
    st.trip_id,
    st.stop_id,
    st.stop_sequence,
    analysis.gtfs_time_to_sec(st.departure_time) AS dep_sec,
    analysis.gtfs_time_to_sec(st.arrival_time)   AS arr_sec
  FROM gtfs_train.stop_times st
),
st_city AS (
  SELECT
    st.gtfs_country, st.trip_id, st.stop_id, st.stop_sequence, st.dep_sec, st.arr_sec,
    cs.city_id
  FROM st
  JOIN cities.city_stop cs
    ON cs.gtfs_country = st.gtfs_country AND cs.stop_id = st.stop_id
  WHERE st.dep_sec IS NOT NULL AND st.arr_sec IS NOT NULL
),
pairs AS (
  SELECT
    a.gtfs_country,
    a.city_id AS from_city_id,
    b.city_id AS to_city_id,
    a.trip_id,
    a.stop_id AS from_stop_id,
    b.stop_id AS to_stop_id,
    (b.arr_sec - a.dep_sec) AS dt_sec
  FROM st_city a
  JOIN st_city b
    ON b.gtfs_country = a.gtfs_country
   AND b.trip_id      = a.trip_id
  WHERE a.city_id <> b.city_id
    AND a.stop_sequence < b.stop_sequence
    AND (b.arr_sec - a.dep_sec) > 300
),
best_dt AS (
  SELECT
    gtfs_country, from_city_id, to_city_id,
    CAST(percentile_cont(0.25) WITHIN GROUP (ORDER BY dt_sec) AS integer) AS p25_sec
  FROM pairs
  GROUP BY gtfs_country, from_city_id, to_city_id
),
witness_ranked AS (
  -- Pick a witness row whose dt_sec is closest to p25_sec (tie-breaker: smaller dt_sec, then trip_id)
  SELECT
    p.gtfs_country, p.from_city_id, p.to_city_id,
    p.dt_sec,
    p.trip_id AS sample_trip_id,
    p.from_stop_id,
    p.to_stop_id,
    b.p25_sec,
    ROW_NUMBER() OVER (
      PARTITION BY p.gtfs_country, p.from_city_id, p.to_city_id
      ORDER BY ABS(p.dt_sec - b.p25_sec) ASC, p.dt_sec ASC, p.trip_id ASC
    ) AS rn
  FROM pairs p
  JOIN best_dt b
    ON b.gtfs_country = p.gtfs_country
   AND b.from_city_id = p.from_city_id
   AND b.to_city_id   = p.to_city_id
),
witness AS (
  SELECT
    gtfs_country, from_city_id, to_city_id,
    dt_sec, sample_trip_id, from_stop_id, to_stop_id, p25_sec
  FROM witness_ranked
  WHERE rn = 1
),
stop_xy AS (
  SELECT gtfs_country, stop_id, stop_lon AS lon, stop_lat AS lat
  FROM cities.city_stop
)
INSERT INTO analysis.city_od_min_time (
  gtfs_country, from_city_id, to_city_id,
  from_lon, from_lat, to_lon, to_lat,
  min_time_sec,
  sample_trip_id, from_stop_id, to_stop_id,
  updated_at
)
SELECT
  b.gtfs_country, b.from_city_id, b.to_city_id,
  fs.lon AS from_lon, fs.lat AS from_lat,
  ts.lon AS to_lon,   ts.lat AS to_lat,
  b.p25_sec AS min_time_sec,
  w.sample_trip_id, w.from_stop_id, w.to_stop_id,
  now() AS updated_at
FROM best_dt b
LEFT JOIN witness w
  ON w.gtfs_country = b.gtfs_country
 AND w.from_city_id = b.from_city_id
 AND w.to_city_id   = b.to_city_id
LEFT JOIN stop_xy fs
  ON fs.gtfs_country = b.gtfs_country
 AND fs.stop_id      = w.from_stop_id
LEFT JOIN stop_xy ts
  ON ts.gtfs_country = b.gtfs_country
 AND ts.stop_id      = w.to_stop_id
ON CONFLICT (gtfs_country, from_city_id, to_city_id)
DO UPDATE SET
  from_lon       = EXCLUDED.from_lon,
  from_lat       = EXCLUDED.from_lat,
  to_lon         = EXCLUDED.to_lon,
  to_lat         = EXCLUDED.to_lat,
  min_time_sec   = EXCLUDED.min_time_sec,
  sample_trip_id = EXCLUDED.sample_trip_id,
  from_stop_id   = EXCLUDED.from_stop_id,
  to_stop_id     = EXCLUDED.to_stop_id,
  updated_at     = EXCLUDED.updated_at;

COMMIT;
