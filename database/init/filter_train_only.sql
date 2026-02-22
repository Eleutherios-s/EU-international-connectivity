BEGIN;

-- 1) 创建 train-only schema
CREATE SCHEMA IF NOT EXISTS gtfs_train;

-- 2) routes：只保留 rail/train（GTFS: route_type=2 + 扩展值）
DROP TABLE IF EXISTS gtfs_train.routes;
CREATE TABLE gtfs_train.routes AS
SELECT *
FROM gtfs.routes
WHERE route_type IN (2, 100, 101, 102, 103, 106);

-- 3) trips：只保留这些 routes 的 trips（必须按 gtfs_country + route_id 连接）
DROP TABLE IF EXISTS gtfs_train.trips;
CREATE TABLE gtfs_train.trips AS
SELECT t.*
FROM gtfs.trips t
JOIN gtfs_train.routes r
  ON r.gtfs_country = t.gtfs_country
 AND r.route_id     = t.route_id;

-- 4) stop_times：只保留这些 trips 的 stop_times（必须按 gtfs_country + trip_id）
DROP TABLE IF EXISTS gtfs_train.stop_times;
CREATE TABLE gtfs_train.stop_times AS
SELECT st.*
FROM gtfs.stop_times st
JOIN gtfs_train.trips t
  ON t.gtfs_country = st.gtfs_country
 AND t.trip_id      = st.trip_id;

-- 5) stops：只保留 train 使用到的 stops（必须按 gtfs_country + stop_id）
DROP TABLE IF EXISTS gtfs_train.stops;
CREATE TABLE gtfs_train.stops AS
SELECT s.*
FROM gtfs.stops s
JOIN (
  SELECT DISTINCT gtfs_country, stop_id
  FROM gtfs_train.stop_times
) x
  ON x.gtfs_country = s.gtfs_country
 AND x.stop_id      = s.stop_id;

-- 6) calendar：只保留 train trips 用到的 service_id（必须按 gtfs_country + service_id）
DROP TABLE IF EXISTS gtfs_train.calendar;
CREATE TABLE gtfs_train.calendar AS
SELECT c.*
FROM gtfs.calendar c
JOIN (
  SELECT DISTINCT gtfs_country, service_id
  FROM gtfs_train.trips
) x
  ON x.gtfs_country = c.gtfs_country
 AND x.service_id   = c.service_id;

-- 7) calendar_dates：同理
DROP TABLE IF EXISTS gtfs_train.calendar_dates;
CREATE TABLE gtfs_train.calendar_dates AS
SELECT cd.*
FROM gtfs.calendar_dates cd
JOIN (
  SELECT DISTINCT gtfs_country, service_id
  FROM gtfs_train.trips
) x
  ON x.gtfs_country = cd.gtfs_country
 AND x.service_id   = cd.service_id;

-- 8) shapes：注意 shapes 的主键里还有 shape_pt_sequence；连接时用 gtfs_country + shape_id
DROP TABLE IF EXISTS gtfs_train.shapes;
CREATE TABLE gtfs_train.shapes AS
SELECT sh.*
FROM gtfs.shapes sh
JOIN (
  SELECT DISTINCT gtfs_country, shape_id
  FROM gtfs_train.trips
  WHERE shape_id IS NOT NULL
) x
  ON x.gtfs_country = sh.gtfs_country
 AND x.shape_id     = sh.shape_id;

-- 9) frequencies：只保留 train trips 的 frequencies（必须按 gtfs_country + trip_id）
DROP TABLE IF EXISTS gtfs_train.frequencies;
CREATE TABLE gtfs_train.frequencies AS
SELECT f.*
FROM gtfs.frequencies f
JOIN gtfs_train.trips t
  ON t.gtfs_country = f.gtfs_country
 AND t.trip_id      = f.trip_id;

----------------------------------------------------

CREATE INDEX IF NOT EXISTS gtfs_train_trips_country_trip_idx
  ON gtfs_train.trips (gtfs_country, trip_id);

CREATE INDEX IF NOT EXISTS gtfs_train_stop_times_country_trip_idx
  ON gtfs_train.stop_times (gtfs_country, trip_id);

CREATE INDEX IF NOT EXISTS gtfs_train_stop_times_country_stop_idx
  ON gtfs_train.stop_times (gtfs_country, stop_id);

CREATE INDEX IF NOT EXISTS gtfs_train_routes_country_route_idx
  ON gtfs_train.routes (gtfs_country, route_id);

CREATE INDEX IF NOT EXISTS gtfs_train_trips_country_route_idx
  ON gtfs_train.trips (gtfs_country, route_id);


----------------------------------------------------

COMMIT;
