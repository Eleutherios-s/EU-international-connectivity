from __future__ import annotations

import json
import heapq
from collections import defaultdict
from datetime import date
from typing import Any, Dict, List, Literal, Optional, Tuple

from fastapi import APIRouter, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sqlalchemy import create_engine, text

from settings import settings


# ============================
# App / DB
# ============================

DATABASE_URL = settings.database_url
engine = create_engine(DATABASE_URL, pool_pre_ping=True)

app = FastAPI(title="EU International Rail Connectivity API")
router = APIRouter(prefix="/api")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ============================
# Models
# ============================

class CityIndexItem(BaseModel):
    city_id: str
    city_name: str
    country_code: str
    iscapital: bool
    center: Dict[str, float]
    route_count: int
    route_count_norm: float
    trip_count: int
    trip_count_norm: float


class CityIndexResponse(BaseModel):
    items: List[CityIndexItem]
    meta: Dict[str, Any]


class CitySearchItem(BaseModel):
    city_id: str
    city_name: str
    country_code: str
    iscapital: bool
    center: Dict[str, float]


class CitySearchResponse(BaseModel):
    items: List[CitySearchItem]
    meta: Dict[str, Any]


class CrossborderRoutesResponse(BaseModel):
    city: Dict[str, Any]
    routes: Dict[str, Any]



class CityConnectionItem(BaseModel):
    city_id: str
    city_name: str
    country_code: str
    center: Dict[str, float]
    is_foreign_city: bool
    is_crossborder_connection: bool
    route_count: int
    trip_count: int


class CityRoutesOverviewResponse(BaseModel):
    city: Dict[str, Any]
    route_stats: Dict[str, Any]
    connected_cities: List[CityConnectionItem]

class GeoJSONFeature(BaseModel):
    type: Literal["Feature"] = "Feature"
    geometry: Dict[str, Any]
    properties: Dict[str, Any]


class GeoJSONFeatureCollection(BaseModel):
    type: Literal["FeatureCollection"] = "FeatureCollection"
    features: List[GeoJSONFeature]
    meta: Optional[Dict[str, Any]] = None


class ConnectionDateItem(BaseModel):
    service_date: str
    trip_count: int


class ConnectionDatesResponse(BaseModel):
    city_id_a: str
    city_id_b: str
    date_from: str
    date_to: str
    items: List[ConnectionDateItem]
    meta: Dict[str, Any]


class ConnectionTripsResponse(BaseModel):
    meta: Dict[str, Any]
    routes: List[Dict[str, Any]]


# ============================
# Helpers
# ============================

def _to_point_feature(lon: float, lat: float, props: Dict[str, Any]) -> GeoJSONFeature:
    return GeoJSONFeature(geometry={"type": "Point", "coordinates": [lon, lat]}, properties=props)


def _dijkstra_city_graph(
    edges: List[Tuple[str, str, int, Optional[float], Optional[float], Optional[float], Optional[float]]],
    origin_city_id: str,
    max_time_sec: int,
    limit: int,
) -> Tuple[Dict[str, int], Dict[str, Tuple[float, float]]]:
    """
    edges: (from_city_id, to_city_id, min_time_sec, from_lon, from_lat, to_lon, to_lat)
    returns:
      dist_sec[city_id] = shortest time seconds
      city_xy[city_id] = (lon, lat) inferred from edge endpoints
    """
    adj: Dict[str, List[Tuple[str, int]]] = defaultdict(list)
    city_xy: Dict[str, Tuple[float, float]] = {}

    for u, v, w, from_lon, from_lat, to_lon, to_lat in edges:
        if w <= 0:
            continue
        adj[u].append((v, w))
        if from_lon is not None and from_lat is not None:
            city_xy[u] = (float(from_lon), float(from_lat))
        if to_lon is not None and to_lat is not None:
            city_xy[v] = (float(to_lon), float(to_lat))

    dist: Dict[str, int] = {origin_city_id: 0}
    pq: List[Tuple[int, str]] = [(0, origin_city_id)]
    visited = 0

    while pq and visited < limit:
        d, u = heapq.heappop(pq)
        if d != dist.get(u):
            continue
        visited += 1
        if d > max_time_sec:
            continue

        for v, w in adj.get(u, []):
            nd = d + w
            if nd <= max_time_sec and nd < dist.get(v, 1_000_000_000):
                dist[v] = nd
                heapq.heappush(pq, (nd, v))

    return dist, city_xy


def _fill_missing_city_centers(city_xy: Dict[str, Tuple[float, float]], city_ids: List[str]) -> None:
    """
    Fill missing city coordinates using cities.city center_lon/center_lat.
    This is critical because analysis.city_od_min_time may have NULL lon/lat for many cities.
    """
    missing = [cid for cid in city_ids if cid not in city_xy]
    if not missing:
        return

    sql = text("""
      SELECT city_id, center_lon, center_lat
      FROM cities.city
      WHERE city_id = ANY(:ids)
        AND center_lon IS NOT NULL
        AND center_lat IS NOT NULL;
    """)

    with engine.connect() as conn:
        rows = conn.execute(sql, {"ids": missing}).mappings().all()

    for r in rows:
        city_xy[r["city_id"]] = (float(r["center_lon"]), float(r["center_lat"]))


def _fetch_city_center(city_id: str) -> Optional[Tuple[float, float]]:
    sql = text("""
      SELECT center_lon, center_lat
      FROM cities.city
      WHERE city_id = :cid
      LIMIT 1;
    """)
    with engine.connect() as conn:
        r = conn.execute(sql, {"cid": city_id}).mappings().first()
    if not r:
        return None
    if r["center_lon"] is None or r["center_lat"] is None:
        return None
    return float(r["center_lon"]), float(r["center_lat"])


def _fetch_shapes_by_id(shape_pairs: List[Tuple[str, str]]) -> Dict[Tuple[str, str], Dict[str, Any]]:
    """
    Fetch shapes geometry by (gtfs_country, shape_id).
    Returns: {(gtfs_country, shape_id): {"geometry": <GeoJSON dict>}}
    """
    if not shape_pairs:
        return {}

    values = ", ".join([f"(:c{i}, :s{i})" for i in range(len(shape_pairs))])
    params: Dict[str, Any] = {}
    for i, (c, sid) in enumerate(shape_pairs):
        params[f"c{i}"] = c
        params[f"s{i}"] = sid

    sql = text(f"""
        WITH wanted AS (
          SELECT * FROM (VALUES {values}) AS v(gtfs_country, shape_id)
        ),
        geom AS (
          SELECT
            s.gtfs_country,
            s.shape_id,
            ST_SetSRID(
              ST_MakeLine(
                ST_MakePoint(s.shape_pt_lon, s.shape_pt_lat)
                ORDER BY s.shape_pt_sequence
              ),
              4326
            ) AS geom_4326
          FROM gtfs_train.shapes s
          JOIN wanted w
            ON w.gtfs_country = s.gtfs_country
           AND w.shape_id     = s.shape_id
          GROUP BY s.gtfs_country, s.shape_id
        )
        SELECT
          gtfs_country,
          shape_id,
          ST_AsGeoJSON(geom_4326)::json AS geom
        FROM geom;
    """)

    out: Dict[Tuple[str, str], Dict[str, Any]] = {}
    with engine.connect() as conn:
        rows = conn.execute(sql, params).mappings().all()

    for r in rows:
        out[(r["gtfs_country"], r["shape_id"])] = {"geometry": r["geom"]}
    return out


def _service_active_cte(alias_date: str = "service_date") -> str:
    return f"""
    active_services AS (
      WITH base AS (
        SELECT c.gtfs_country, c.service_id
        FROM gtfs_train.calendar c
        WHERE {alias_date} BETWEEN to_date(lpad(c.start_date::text,8,'0'),'YYYYMMDD')
                              AND to_date(lpad(c.end_date::text,8,'0'),'YYYYMMDD')
          AND (
            (EXTRACT(ISODOW FROM {alias_date}) = 1 AND c.monday    = 1) OR
            (EXTRACT(ISODOW FROM {alias_date}) = 2 AND c.tuesday   = 1) OR
            (EXTRACT(ISODOW FROM {alias_date}) = 3 AND c.wednesday = 1) OR
            (EXTRACT(ISODOW FROM {alias_date}) = 4 AND c.thursday  = 1) OR
            (EXTRACT(ISODOW FROM {alias_date}) = 5 AND c.friday    = 1) OR
            (EXTRACT(ISODOW FROM {alias_date}) = 6 AND c.saturday  = 1) OR
            (EXTRACT(ISODOW FROM {alias_date}) = 7 AND c.sunday    = 1)
          )
      ),
      added AS (
        SELECT cd.gtfs_country, cd.service_id
        FROM gtfs_train.calendar_dates cd
        WHERE to_date(lpad(cd.date::text,8,'0'),'YYYYMMDD') = {alias_date}
          AND cd.exception_type = 1
      ),
      removed AS (
        SELECT cd.gtfs_country, cd.service_id
        FROM gtfs_train.calendar_dates cd
        WHERE to_date(lpad(cd.date::text,8,'0'),'YYYYMMDD') = {alias_date}
          AND cd.exception_type = 2
      )
      SELECT DISTINCT x.gtfs_country, x.service_id
      FROM (
        SELECT * FROM base
        UNION
        SELECT * FROM added
      ) x
      LEFT JOIN removed r
        ON r.gtfs_country = x.gtfs_country
       AND r.service_id   = x.service_id
      WHERE r.service_id IS NULL
    )
    """


def _service_active_cte_by_day(gs_cte_name: str = "gs") -> str:
    return f"""
    base AS (
      SELECT {gs_cte_name}.d AS d, c.gtfs_country, c.service_id
      FROM {gs_cte_name}
      JOIN gtfs_train.calendar c
        ON {gs_cte_name}.d BETWEEN to_date(lpad(c.start_date::text,8,'0'),'YYYYMMDD')
                           AND to_date(lpad(c.end_date::text,8,'0'),'YYYYMMDD')
      WHERE
        (EXTRACT(ISODOW FROM {gs_cte_name}.d) = 1 AND c.monday    = 1) OR
        (EXTRACT(ISODOW FROM {gs_cte_name}.d) = 2 AND c.tuesday   = 1) OR
        (EXTRACT(ISODOW FROM {gs_cte_name}.d) = 3 AND c.wednesday = 1) OR
        (EXTRACT(ISODOW FROM {gs_cte_name}.d) = 4 AND c.thursday  = 1) OR
        (EXTRACT(ISODOW FROM {gs_cte_name}.d) = 5 AND c.friday    = 1) OR
        (EXTRACT(ISODOW FROM {gs_cte_name}.d) = 6 AND c.saturday  = 1) OR
        (EXTRACT(ISODOW FROM {gs_cte_name}.d) = 7 AND c.sunday    = 1)
    ),
    added AS (
      SELECT {gs_cte_name}.d AS d, cd.gtfs_country, cd.service_id
      FROM {gs_cte_name}
      JOIN gtfs_train.calendar_dates cd
        ON to_date(lpad(cd.date::text,8,'0'),'YYYYMMDD') = {gs_cte_name}.d
      WHERE cd.exception_type = 1
    ),
    removed AS (
      SELECT {gs_cte_name}.d AS d, cd.gtfs_country, cd.service_id
      FROM {gs_cte_name}
      JOIN gtfs_train.calendar_dates cd
        ON to_date(lpad(cd.date::text,8,'0'),'YYYYMMDD') = {gs_cte_name}.d
      WHERE cd.exception_type = 2
    ),
    active_services AS (
      SELECT DISTINCT x.d, x.gtfs_country, x.service_id
      FROM (
        SELECT * FROM base
        UNION
        SELECT * FROM added
      ) x
      LEFT JOIN removed r
        ON r.d = x.d
       AND r.gtfs_country = x.gtfs_country
       AND r.service_id   = x.service_id
      WHERE r.service_id IS NULL
    )
    """


# ============================
# API 0: All cities index (+ iscapital)
# ============================

@router.get("/cities/index", response_model=CityIndexResponse)
def get_cities_index(limit: int = Query(1000, ge=1, le=200_000), offset: int = Query(0, ge=0)):
    sql = text("""
        SELECT
          c.city_id,
          c.city_name,
          c.country_code,
          COALESCE(c.is_capital, false) AS iscapital,
          c.center_lon,
          c.center_lat,
          COALESCE(r.route_count, 0)      AS route_count,
          COALESCE(r.route_count_norm, 0) AS route_count_norm,
          COALESCE(t.trip_count, 0)       AS trip_count,
          COALESCE(t.trip_count_norm, 0)  AS trip_count_norm
        FROM cities.city c
        LEFT JOIN analysis.city_intl_routes r
          ON r.city_id = c.city_id
        LEFT JOIN analysis.city_intl_trips t
          ON t.city_id = c.city_id
        ORDER BY c.city_id
        LIMIT :limit OFFSET :offset;
    """)
    with engine.connect() as conn:
        rows = conn.execute(sql, {"limit": limit, "offset": offset}).mappings().all()

    items: List[CityIndexItem] = []
    for row in rows:
        items.append(
            CityIndexItem(
                city_id=row["city_id"],
                city_name=row["city_name"],
                country_code=row["country_code"],
                iscapital=bool(row["iscapital"]),
                center={"lon": float(row["center_lon"]), "lat": float(row["center_lat"])},
                route_count=int(row["route_count"]),
                route_count_norm=float(row["route_count_norm"]),
                trip_count=int(row["trip_count"]),
                trip_count_norm=float(row["trip_count_norm"]),
            )
        )

    return CityIndexResponse(items=items, meta={"limit": limit, "offset": offset})


# ============================
# API 1: City lookup (name -> city_id)
# ============================

@router.get("/cities/search", response_model=CitySearchResponse)
def search_cities(
    name: str = Query(..., description="Case-insensitive substring match (ILIKE %name%)."),
    country_code: Optional[str] = Query(None, description="Optional exact country_code filter, e.g. DE"),
    limit: int = Query(20, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    sql = text("""
        SELECT
          city_id,
          city_name,
          country_code,
          COALESCE(is_capital, false) AS iscapital,
          center_lon,
          center_lat
        FROM cities.city
        WHERE city_name ILIKE :pat
          AND (:cc IS NULL OR country_code = :cc)
        ORDER BY country_code, city_name, city_id
        LIMIT :limit OFFSET :offset;
    """)
    with engine.connect() as conn:
        rows = conn.execute(
            sql,
            {"pat": f"%{name}%", "cc": country_code, "limit": limit, "offset": offset},
        ).mappings().all()

    items: List[CitySearchItem] = []
    for r in rows:
        items.append(
            CitySearchItem(
                city_id=r["city_id"],
                city_name=r["city_name"],
                country_code=r["country_code"],
                iscapital=bool(r["iscapital"]),
                center={"lon": float(r["center_lon"]), "lat": float(r["center_lat"])},
            )
        )

    return CitySearchResponse(items=items, meta={"name": name, "country_code": country_code, "limit": limit, "offset": offset})


# ============================
# API 2: Single city crossborder routes (for foreign stop pins, route list)
# ============================

@router.get("/cities/{city_id}/crossborder/routes", response_model=CrossborderRoutesResponse)
def get_city_crossborder_routes(city_id: str):
    sql = text("""
        SELECT
          c.city_id, c.city_name, c.country_code, c.center_lon, c.center_lat,
          r.route_dict
        FROM cities.city c
        JOIN analysis.city_intl_routes r
          ON r.city_id = c.city_id
        WHERE c.city_id = :city_id
        LIMIT 1;
    """)
    with engine.connect() as conn:
        row = conn.execute(sql, {"city_id": city_id}).mappings().first()

    if not row:
        raise HTTPException(status_code=404, detail="city_id not found or no crossborder routes for this city")

    route_dict_raw = row["route_dict"]
    route_dict = json.loads(route_dict_raw) if isinstance(route_dict_raw, str) else route_dict_raw
    if not isinstance(route_dict, dict):
        route_dict = {}

    city_obj = {
        "city_id": row["city_id"],
        "city_name": row["city_name"],
        "country_code": row["country_code"],
        "center": {"lon": float(row["center_lon"]), "lat": float(row["center_lat"])},
        "include_shape": False,
        "note": "This endpoint returns route_dict + foreign_stops for pin placement. Shapes are provided by /crossborder/shapes.",
    }

    return CrossborderRoutesResponse(city=city_obj, routes=route_dict)


# ============================
# API 2b: A-only crossborder SHAPES (GTFS-correct)
# ============================

@router.get("/cities/{city_id}/crossborder/shapes", response_model=GeoJSONFeatureCollection)
def get_city_crossborder_shapes(
    city_id: str,):
    """
    Returns a FeatureCollection of LineString railway shapes actually used by crossborder trips serving this city.

    IMPORTANT (for line coloring on the frontend):
    - We attach a *random* representative trip_id per (gtfs_country, shape_id).
    - We attach foreign_city_ids visited by that chosen trip.

    Shapes geometry uses GTFS shape points (stop/shape coordinates). City OD / isochrone points should use city centers.
    """

    sql_pick = text("""
      SELECT gtfs_country, shape_id, trip_n
      FROM analysis.city_shape_keys
      WHERE city_id = :city_id
      ORDER BY trip_n DESC;
    """)

    with engine.connect() as conn:
        picked = conn.execute(sql_pick, {"city_id": city_id}).mappings().all()

    if not picked:
        return GeoJSONFeatureCollection(
            features=[],
            meta={"city_id": city_id, "note": "No crossborder shapes found for this city."},
        )

    # 1) geometry for picked shapes
    shape_pairs = [(r["gtfs_country"], r["shape_id"]) for r in picked]
    shapes_by_id = _fetch_shapes_by_id(shape_pairs)

    # 2) For each picked shape, choose ONE random trip_id (among trips that serve city_id) and
    #    collect foreign_city_ids visited by that trip.
    values = ", ".join([f"(:c{i}, :s{i})" for i in range(len(shape_pairs))])
    params: Dict[str, Any] = {"city_id": city_id}
    for i, (c, sid) in enumerate(shape_pairs):
        params[f"c{i}"] = c
        params[f"s{i}"] = sid

    schema = "gtfs_train"

    sql_meta = text(f"""
      WITH wanted AS (
        SELECT * FROM (VALUES {values}) AS v(gtfs_country, shape_id)
      ),
      a_stops AS (
        SELECT gtfs_country, stop_id
        FROM cities.city_stop
        WHERE city_id = :city_id
      ),
      candidate AS (
        SELECT t.gtfs_country, t.shape_id, t.trip_id
        FROM {schema}.trips t
        JOIN {schema}.stop_times st
          ON st.gtfs_country = t.gtfs_country
         AND st.trip_id      = t.trip_id
        JOIN a_stops a
          ON a.gtfs_country = st.gtfs_country
         AND a.stop_id      = st.stop_id
        JOIN wanted w
          ON w.gtfs_country = t.gtfs_country
         AND w.shape_id     = t.shape_id
        WHERE t.shape_id IS NOT NULL
      ),
      picked_trip AS (
        SELECT DISTINCT ON (gtfs_country, shape_id)
          gtfs_country, shape_id, trip_id
        FROM candidate
        ORDER BY gtfs_country, shape_id, random()
      ),
      foreign_cities AS (
        SELECT
          pt.gtfs_country,
          pt.shape_id,
          jsonb_agg(DISTINCT cs.city_id) FILTER (WHERE cs.city_id <> :city_id) AS foreign_city_ids
        FROM picked_trip pt
        JOIN {schema}.stop_times st
          ON st.gtfs_country = pt.gtfs_country
         AND st.trip_id      = pt.trip_id
        JOIN cities.city_stop cs
          ON cs.gtfs_country = st.gtfs_country
         AND cs.stop_id      = st.stop_id
        GROUP BY pt.gtfs_country, pt.shape_id
      )
      SELECT
        pt.gtfs_country,
        pt.shape_id,
        pt.trip_id AS chosen_trip_id,
        COALESCE(fc.foreign_city_ids, '[]'::jsonb) AS foreign_city_ids
      FROM picked_trip pt
      LEFT JOIN foreign_cities fc
        ON fc.gtfs_country = pt.gtfs_country
       AND fc.shape_id     = pt.shape_id;
    """)

    meta_by_shape: Dict[Tuple[str, str], Dict[str, Any]] = {}
    with engine.connect() as conn:
        rows = conn.execute(sql_meta, params).mappings().all()
    for r in rows:
        meta_by_shape[(r["gtfs_country"], r["shape_id"])] = {
            "chosen_trip_id": r["chosen_trip_id"],
            "foreign_city_ids": r["foreign_city_ids"],
        }

    # 3) assemble features
    features: List[GeoJSONFeature] = []
    missing = 0
    for r in picked:
        key = (r["gtfs_country"], r["shape_id"])
        if key not in shapes_by_id:
            missing += 1
            continue

        meta = meta_by_shape.get(key, {"chosen_trip_id": None, "foreign_city_ids": []})

        features.append(
            GeoJSONFeature(
                geometry=shapes_by_id[key]["geometry"],
                properties={
                    "gtfs_country": r["gtfs_country"],
                    "shape_id": r["shape_id"],
                    "trip_n": int(r["trip_n"]),
                    "chosen_trip_id": meta.get("chosen_trip_id"),
                    "foreign_city_ids": meta.get("foreign_city_ids"),
                },
            )
        )

    return GeoJSONFeatureCollection(
        features=features,
        meta={
            "city_id": city_id,
            "returned": len(features),
            "missing_geom": missing,
            "note": "A-only shapes constrained to crossborder trips serving this city. Each shape carries a random chosen_trip_id and foreign_city_ids for line coloring.",
        },
    )




# ============================
# API 2c: A-only ALL routes overview (domestic + crossborder)
# ============================

@router.get("/cities/{city_id}/routes/overview", response_model=CityRoutesOverviewResponse)
def get_city_routes_overview(city_id: str):
    """
    For a given origin city:
    - all directly-connected cities (domestic + foreign) reached by any trip that serves the origin city's stops
    - per-route summary stats (used for counts/diagnostics)

    Classification:
      - is_foreign_city: connected city's country_code != origin.country_code
      - is_crossborder_connection: same as above (edge-level flag)

    Geometry (railway shapes) is provided by /cities/{city_id}/shapes.
    """

    sql_city = text("""
        SELECT city_id, city_name, country_code, center_lon, center_lat
        FROM cities.city
        WHERE city_id = :city_id
        LIMIT 1;
    """)
    with engine.connect() as conn:
        c = conn.execute(sql_city, {"city_id": city_id}).mappings().first()

    if not c:
        raise HTTPException(status_code=404, detail="city_id not found")

    origin_country = c["country_code"]
    schema = "gtfs_train"

    sql_conn = text(f"""
      WITH a_stops AS (
        SELECT gtfs_country, stop_id
        FROM cities.city_stop
        WHERE city_id = :city_id
      ),
      trips_a AS (
        SELECT DISTINCT t.gtfs_country, t.trip_id, t.route_id
        FROM {schema}.trips t
        JOIN {schema}.stop_times st
          ON st.gtfs_country = t.gtfs_country
         AND st.trip_id      = t.trip_id
        JOIN a_stops a
          ON a.gtfs_country = st.gtfs_country
         AND a.stop_id      = st.stop_id
      ),
      city_visits AS (
        SELECT DISTINCT
          ta.route_id,
          ta.trip_id,
          cs.city_id AS other_city_id,
          oc.country_code AS other_country
        FROM trips_a ta
        JOIN {schema}.stop_times st
          ON st.gtfs_country = ta.gtfs_country
         AND st.trip_id      = ta.trip_id
        JOIN cities.city_stop cs
          ON cs.gtfs_country = st.gtfs_country
         AND cs.stop_id      = st.stop_id
        JOIN cities.city oc
          ON oc.city_id = cs.city_id
      ),
      conn_city AS (
        SELECT
          other_city_id,
          MAX(other_country) AS country_code,
          COUNT(DISTINCT route_id) AS route_count,
          COUNT(DISTINCT trip_id)  AS trip_count
        FROM city_visits
        WHERE other_city_id <> :city_id
        GROUP BY other_city_id
      ),
      conn_city_named AS (
        SELECT
          cc.other_city_id AS city_id,
          c2.city_name,
          cc.country_code,
          c2.center_lon,
          c2.center_lat,
          cc.route_count,
          cc.trip_count
        FROM conn_city cc
        JOIN cities.city c2
          ON c2.city_id = cc.other_city_id
      ),
      route_stats AS (
        SELECT
          route_id::text AS route_id,
          COUNT(DISTINCT trip_id) AS trip_count,
          COUNT(DISTINCT other_city_id) FILTER (WHERE other_city_id <> :city_id) AS connected_city_n,
          BOOL_OR(other_country <> :origin_country) AS is_crossborder,
          jsonb_agg(DISTINCT other_city_id) FILTER (WHERE other_city_id <> :city_id) AS connected_city_ids
        FROM city_visits
        GROUP BY route_id
      )
      SELECT
        (SELECT COALESCE(jsonb_agg(to_jsonb(conn_city_named)), '[]'::jsonb) FROM conn_city_named) AS connected_cities,
        (SELECT COALESCE(jsonb_object_agg(route_id, to_jsonb(route_stats)), '{{}}'::jsonb) FROM route_stats) AS route_stats;
    """)

    with engine.connect() as conn:
        row = conn.execute(sql_conn, {"city_id": city_id, "origin_country": origin_country}).mappings().first()

    conn_cities = row["connected_cities"] if row else []
    route_stats = row["route_stats"] if row else {}

    out_conn: List[CityConnectionItem] = []
    for cc in (conn_cities or []):
        cc_country = cc.get("country_code")
        is_foreign = bool(cc_country and cc_country != origin_country)
        out_conn.append(
            CityConnectionItem(
                city_id=str(cc.get("city_id")),
                city_name=str(cc.get("city_name")),
                country_code=str(cc_country),
                center={"lon": float(cc.get("center_lon")), "lat": float(cc.get("center_lat"))},
                is_foreign_city=is_foreign,
                is_crossborder_connection=is_foreign,
                route_count=int(cc.get("route_count", 0)),
                trip_count=int(cc.get("trip_count", 0)),
            )
        )

    city_obj = {
        "city_id": c["city_id"],
        "city_name": c["city_name"],
        "country_code": origin_country,
        "center": {"lon": float(c["center_lon"]), "lat": float(c["center_lat"])},
        "include_shape": False,
        "note": "Use /cities/{city_id}/shapes for geometry. This endpoint returns connected cities + per-route summary only.",
    }

    return CityRoutesOverviewResponse(city=city_obj, route_stats=route_stats, connected_cities=out_conn)


# ============================
# API 2d: A-only ALL SHAPES (domestic + crossborder)
# ============================

@router.get("/cities/{city_id}/shapes", response_model=GeoJSONFeatureCollection)
def get_city_all_shapes(
    city_id: str,):
    """Return LineString railway shapes used by ANY trips serving this city."""

    sql_city = text("""
        SELECT city_id, country_code
        FROM cities.city
        WHERE city_id = :city_id
        LIMIT 1;
    """)
    with engine.connect() as conn:
        c = conn.execute(sql_city, {"city_id": city_id}).mappings().first()
    if not c:
        raise HTTPException(status_code=404, detail="city_id not found")

    origin_country = c["country_code"]
    schema = "gtfs_train"

    sql_pick = text(f"""
      WITH a_stops AS (
        SELECT gtfs_country, stop_id
        FROM cities.city_stop
        WHERE city_id = :city_id
      ),
      candidate AS (
        SELECT DISTINCT t.gtfs_country, t.shape_id, t.trip_id
        FROM {schema}.trips t
        JOIN {schema}.stop_times st
          ON st.gtfs_country = t.gtfs_country
         AND st.trip_id      = t.trip_id
        JOIN a_stops a
          ON a.gtfs_country = st.gtfs_country
         AND a.stop_id      = st.stop_id
        WHERE t.shape_id IS NOT NULL
      )
      SELECT gtfs_country, shape_id, COUNT(DISTINCT trip_id) AS trip_n
      FROM candidate
      GROUP BY gtfs_country, shape_id
      ORDER BY trip_n DESC;
    """)

    with engine.connect() as conn:
        picked = conn.execute(sql_pick, {"city_id": city_id}).mappings().all()

    if not picked:
        return GeoJSONFeatureCollection(features=[], meta={"city_id": city_id, "note": "No shapes found for this city."})

    shape_pairs = [(r["gtfs_country"], r["shape_id"]) for r in picked]
    shapes_by_id = _fetch_shapes_by_id(shape_pairs)

    values = ", ".join([f"(:c{i}, :s{i})" for i in range(len(shape_pairs))])
    params: Dict[str, Any] = {"city_id": city_id, "origin_country": origin_country}
    for i, (c0, sid) in enumerate(shape_pairs):
        params[f"c{i}"] = c0
        params[f"s{i}"] = sid

    sql_meta = text(f"""
      WITH wanted AS (
        SELECT * FROM (VALUES {values}) AS v(gtfs_country, shape_id)
      ),
      a_stops AS (
        SELECT gtfs_country, stop_id
        FROM cities.city_stop
        WHERE city_id = :city_id
      ),
      candidate AS (
        SELECT t.gtfs_country, t.shape_id, t.trip_id
        FROM {schema}.trips t
        JOIN {schema}.stop_times st
          ON st.gtfs_country = t.gtfs_country
         AND st.trip_id      = t.trip_id
        JOIN a_stops a
          ON a.gtfs_country = st.gtfs_country
         AND a.stop_id      = st.stop_id
        JOIN wanted w
          ON w.gtfs_country = t.gtfs_country
         AND w.shape_id     = t.shape_id
        WHERE t.shape_id IS NOT NULL
      ),
      picked_trip AS (
        SELECT DISTINCT ON (gtfs_country, shape_id)
          gtfs_country, shape_id, trip_id
        FROM candidate
        ORDER BY gtfs_country, shape_id, random()
      ),
      trip_cities AS (
        SELECT
          pt.gtfs_country,
          pt.shape_id,
          jsonb_agg(DISTINCT cs.city_id) FILTER (WHERE cs.city_id <> :city_id) AS connected_city_ids,
          jsonb_agg(DISTINCT cs.city_id) FILTER (WHERE cs.city_id <> :city_id AND oc.country_code <> :origin_country) AS foreign_city_ids,
          BOOL_OR(oc.country_code <> :origin_country) AS crossborder
        FROM picked_trip pt
        JOIN {schema}.stop_times st
          ON st.gtfs_country = pt.gtfs_country
         AND st.trip_id      = pt.trip_id
        JOIN cities.city_stop cs
          ON cs.gtfs_country = st.gtfs_country
         AND cs.stop_id      = st.stop_id
        JOIN cities.city oc
          ON oc.city_id = cs.city_id
        GROUP BY pt.gtfs_country, pt.shape_id
      )
      SELECT
        pt.gtfs_country,
        pt.shape_id,
        pt.trip_id AS chosen_trip_id,
        COALESCE(tc.connected_city_ids, '[]'::jsonb) AS connected_city_ids,
        COALESCE(tc.foreign_city_ids, '[]'::jsonb)   AS foreign_city_ids,
        COALESCE(tc.crossborder, false)              AS crossborder
      FROM picked_trip pt
      LEFT JOIN trip_cities tc
        ON tc.gtfs_country = pt.gtfs_country
       AND tc.shape_id     = pt.shape_id;
    """)

    meta_by_shape: Dict[Tuple[str, str], Dict[str, Any]] = {}
    with engine.connect() as conn:
        rows = conn.execute(sql_meta, params).mappings().all()
    for r in rows:
        meta_by_shape[(r["gtfs_country"], r["shape_id"])] = {
            "chosen_trip_id": r["chosen_trip_id"],
            "connected_city_ids": r["connected_city_ids"],
            "foreign_city_ids": r["foreign_city_ids"],
            "crossborder": bool(r["crossborder"]),
        }

    features: List[GeoJSONFeature] = []
    missing = 0
    for r in picked:
        key = (r["gtfs_country"], r["shape_id"])
        if key not in shapes_by_id:
            missing += 1
            continue
        meta = meta_by_shape.get(key, {"chosen_trip_id": None, "connected_city_ids": [], "foreign_city_ids": [], "crossborder": False})
        features.append(
            GeoJSONFeature(
                geometry=shapes_by_id[key]["geometry"],
                properties={
                    "gtfs_country": r["gtfs_country"],
                    "shape_id": r["shape_id"],
                    "trip_n": int(r["trip_n"]),
                    "chosen_trip_id": meta.get("chosen_trip_id"),
                    "connected_city_ids": meta.get("connected_city_ids"),
                    "foreign_city_ids": meta.get("foreign_city_ids"),
                    "crossborder": meta.get("crossborder"),
                },
            )
        )

    return GeoJSONFeatureCollection(
        features=features,
        meta={"city_id": city_id, "missing_geometry_n": missing, "note": "Domestic+crossborder shapes. Color via feature.properties.crossborder."},
    )

# ============================
# API 3: Connection Dates
# ============================

@router.get("/connections/dates", response_model=ConnectionDatesResponse)
def get_connection_dates(
    city_id_a: str = Query(...),
    city_id_b: str = Query(...),
    date_from: date = Query(..., description="YYYY-MM-DD"),
    date_to: date = Query(..., description="YYYY-MM-DD"),
    limit_days: int = Query(400, ge=1, le=4000),
):
    if date_to < date_from:
        raise HTTPException(status_code=422, detail="date_to must be >= date_from")

    span = (date_to - date_from).days + 1
    if span > limit_days:
        raise HTTPException(
            status_code=422,
            detail=f"Requested date range is {span} days, exceeds limit_days={limit_days}.",
        )

    sql = text(f"""
    WITH
    a_stops AS (
      SELECT gtfs_country, stop_id
      FROM cities.city_stop
      WHERE city_id = :city_id_a
    ),
    b_stops AS (
      SELECT gtfs_country, stop_id
      FROM cities.city_stop
      WHERE city_id = :city_id_b
    ),
    good_trips AS (
      SELECT t.gtfs_country, t.trip_id, t.service_id
      FROM gtfs_train.trips t
      WHERE EXISTS (
        SELECT 1
        FROM gtfs_train.stop_times st
        JOIN a_stops a
          ON a.gtfs_country = st.gtfs_country
         AND a.stop_id      = st.stop_id
        WHERE st.gtfs_country = t.gtfs_country
          AND st.trip_id      = t.trip_id
      )
      AND EXISTS (
        SELECT 1
        FROM gtfs_train.stop_times st
        JOIN b_stops b
          ON b.gtfs_country = st.gtfs_country
         AND b.stop_id      = st.stop_id
        WHERE st.gtfs_country = t.gtfs_country
          AND st.trip_id      = t.trip_id
      )
    ),
    gs AS (
      SELECT d::date AS d
      FROM generate_series(CAST(:date_from AS date), CAST(:date_to AS date), interval '1 day') AS d
    ),
    { _service_active_cte_by_day("gs") }
    SELECT
      gs.d AS service_date,
      COUNT(DISTINCT gt.trip_id)::int AS trip_count
    FROM gs
    JOIN active_services s
      ON s.d = gs.d
    JOIN good_trips gt
      ON gt.gtfs_country = s.gtfs_country
     AND gt.service_id   = s.service_id
    GROUP BY gs.d
    HAVING COUNT(DISTINCT gt.trip_id) > 0
    ORDER BY gs.d;
    """)

    params = {
        "city_id_a": city_id_a,
        "city_id_b": city_id_b,
        "date_from": date_from,
        "date_to": date_to,
    }

    with engine.begin() as conn:
        rows = conn.execute(sql, params).mappings().all()

    items = [
        ConnectionDateItem(service_date=str(r["service_date"]), trip_count=int(r["trip_count"]))
        for r in rows
    ]

    return ConnectionDatesResponse(
        city_id_a=city_id_a,
        city_id_b=city_id_b,
        date_from=str(date_from),
        date_to=str(date_to),
        items=items,
        meta={"note": "Dates where at least one trip runs and serves both cities."},
    )


# ============================
# API 4: Connection Trips (AB shapes are already trip.shape_id-constrained)
# ============================

@router.get("/connections/trips", response_model=ConnectionTripsResponse)
def get_connection_trips_for_date(
    city_id_a: str = Query(...),
    city_id_b: str = Query(...),
    service_date: str = Query(..., description="YYYY-MM-DD"),
    include_shape: bool = Query(True),
    limit_trips: int = Query(500, ge=1, le=5000),
    offset_trips: int = Query(0, ge=0),
):
    sql_trips = text(f"""
    WITH
    a_stops AS (
      SELECT gtfs_country, stop_id
      FROM cities.city_stop
      WHERE city_id = :city_id_a
    ),
    b_stops AS (
      SELECT gtfs_country, stop_id
      FROM cities.city_stop
      WHERE city_id = :city_id_b
    ),
    { _service_active_cte("CAST(:service_date AS date)") },
    good_trips AS (
      SELECT
        t.gtfs_country,
        t.trip_id,
        t.route_id,
        t.service_id,
        t.direction_id,
        t.shape_id
      FROM gtfs_train.trips t
      JOIN active_services s
        ON s.gtfs_country = t.gtfs_country
       AND s.service_id   = t.service_id
      WHERE EXISTS (
        SELECT 1
        FROM gtfs_train.stop_times st
        JOIN a_stops a
          ON a.gtfs_country = st.gtfs_country
         AND a.stop_id      = st.stop_id
        WHERE st.gtfs_country = t.gtfs_country
          AND st.trip_id      = t.trip_id
      )
      AND EXISTS (
        SELECT 1
        FROM gtfs_train.stop_times st
        JOIN b_stops b
          ON b.gtfs_country = st.gtfs_country
         AND b.stop_id      = st.stop_id
        WHERE st.gtfs_country = t.gtfs_country
          AND st.trip_id      = t.trip_id
      )
    )
    SELECT *
    FROM good_trips
    ORDER BY gtfs_country, route_id, trip_id
    OFFSET :offset_trips
    LIMIT  :limit_trips;
    """)

    sql_route = text("""
      SELECT gtfs_country, route_id, route_short_name, route_long_name
      FROM gtfs_train.routes
      WHERE gtfs_country = :gtfs_country AND route_id = :route_id
      LIMIT 1;
    """)

    sql_ab_times = text("""
    WITH
    a_stops AS (SELECT gtfs_country, stop_id FROM cities.city_stop WHERE city_id = :city_id_a),
    b_stops AS (SELECT gtfs_country, stop_id FROM cities.city_stop WHERE city_id = :city_id_b)
    SELECT
      st.stop_id,
      s.stop_name,
      st.arrival_time,
      st.departure_time,
      st.stop_sequence,
      CASE
        WHEN (st.gtfs_country, st.stop_id) IN (SELECT gtfs_country, stop_id FROM a_stops) THEN 'A'
        WHEN (st.gtfs_country, st.stop_id) IN (SELECT gtfs_country, stop_id FROM b_stops) THEN 'B'
        ELSE NULL
      END AS which_city
    FROM gtfs_train.stop_times st
    JOIN gtfs_train.stops s
      ON s.gtfs_country = st.gtfs_country AND s.stop_id = st.stop_id
    WHERE st.gtfs_country = :gtfs_country
      AND st.trip_id = :trip_id
      AND (
        (st.gtfs_country, st.stop_id) IN (SELECT gtfs_country, stop_id FROM a_stops)
        OR
        (st.gtfs_country, st.stop_id) IN (SELECT gtfs_country, stop_id FROM b_stops)
      )
    ORDER BY st.stop_sequence;
    """)

    with engine.connect() as conn:
        trips = conn.execute(sql_trips, {
            "city_id_a": city_id_a,
            "city_id_b": city_id_b,
            "service_date": service_date,
            "offset_trips": offset_trips,
            "limit_trips": limit_trips,
        }).mappings().all()

        routes_map: Dict[str, Dict[str, Any]] = {}
        shape_freq: Dict[Tuple[str, str], Dict[str, int]] = defaultdict(lambda: defaultdict(int))

        for t in trips:
            rk = f"{t['gtfs_country']}:{t['route_id']}"

            if rk not in routes_map:
                rrow = conn.execute(sql_route, {
                    "gtfs_country": t["gtfs_country"],
                    "route_id": t["route_id"]
                }).mappings().first()

                routes_map[rk] = {
                    "gtfs_country": t["gtfs_country"],
                    "route_id": t["route_id"],
                    "route_short_name": rrow["route_short_name"] if rrow else None,
                    "route_long_name": rrow["route_long_name"] if rrow else None,
                    "shape": None,
                    "trips": []
                }

            sid = t.get("shape_id")
            if sid:
                shape_freq[(t["gtfs_country"], t["route_id"])][str(sid)] += 1

            ab = conn.execute(sql_ab_times, {
                "city_id_a": city_id_a,
                "city_id_b": city_id_b,
                "gtfs_country": t["gtfs_country"],
                "trip_id": t["trip_id"],
            }).mappings().all()

            stops_a, stops_b = [], []
            for x in ab:
                item = {
                    "stop_id": x["stop_id"],
                    "stop_name": x["stop_name"],
                    "arrival_time": x["arrival_time"],
                    "departure_time": x["departure_time"],
                    "stop_sequence": int(x["stop_sequence"]),
                }
                if x["which_city"] == "A":
                    stops_a.append(item)
                elif x["which_city"] == "B":
                    stops_b.append(item)

            routes_map[rk]["trips"].append({
                "trip_id": t["trip_id"],
                "service_id": t["service_id"],
                "direction_id": t["direction_id"],
                "stops_in_city_a": stops_a,
                "stops_in_city_b": stops_b,
            })

    if include_shape and shape_freq:
        best_shape_by_route: Dict[Tuple[str, str], str] = {}
        for (gc, rid), counter in shape_freq.items():
            best_sid = sorted(counter.items(), key=lambda x: (-x[1], x[0]))[0][0]
            best_shape_by_route[(gc, rid)] = best_sid

        wanted: List[Tuple[str, str]] = [(gc, sid) for (gc, _rid), sid in best_shape_by_route.items()]
        shapes_by_id = _fetch_shapes_by_id(wanted)

        for rk, robj in routes_map.items():
            gc = robj["gtfs_country"]
            rid = robj["route_id"]
            sid = best_shape_by_route.get((gc, rid))
            if sid and (gc, sid) in shapes_by_id:
                robj["shape"] = {
                    "type": "Feature",
                    "geometry": shapes_by_id[(gc, sid)]["geometry"],
                    "properties": {"shape_id": sid}
                }

    return {
        "meta": {
            "city_id_a": city_id_a,
            "city_id_b": city_id_b,
            "service_date": service_date,
            "include_shape": include_shape,
            "trip_returned": sum(len(r["trips"]) for r in routes_map.values()),
            "route_count": len(routes_map),
            "note": "AB shapes are picked from trip.shape_id within AB good_trips.",
        },
        "routes": list(routes_map.values())
    }


# ============================
# API 5: City isochrone points
# ============================

@router.get("/isochrones/cities", response_model=GeoJSONFeatureCollection)
def get_isochrone_cities(
    origin_city_id: str = Query(...),
    max_time_min: int = Query(240, ge=1, le=24 * 60),
    interval_min: int = Query(15, ge=1, le=60),
    limit: int = Query(200_000, ge=1, le=1_000_000),
    max_edge_time_min: Optional[int] = Query(None),
):
    max_time_sec = max_time_min * 60

    sql_edges = text("""
        SELECT
          from_city_id,
          to_city_id,
          min_time_sec,
          from_lon,
          from_lat,
          to_lon,
          to_lat
        FROM analysis.city_od_min_time
        WHERE min_time_sec > 0
          AND min_time_sec <= :max_time_sec
          AND (:max_edge_time_sec IS NULL OR min_time_sec <= :max_edge_time_sec);
    """)

    params: Dict[str, Any] = {
        "max_time_sec": max_time_sec,
        "max_edge_time_sec": (max_edge_time_min * 60) if max_edge_time_min else None,
    }

    with engine.connect() as conn:
        rows = conn.execute(sql_edges, params).fetchall()

    edges: List[Tuple[str, str, int, Optional[float], Optional[float], Optional[float], Optional[float]]] = []
    for r in rows:
        edges.append((r[0], r[1], int(r[2]), r[3], r[4], r[5], r[6]))

    if not edges:
        raise HTTPException(status_code=404, detail="No edges found in analysis.city_od_min_time")

    dist_sec, city_xy = _dijkstra_city_graph(edges, origin_city_id, max_time_sec, limit)

    # Fill missing coordinates from cities.city center
    _fill_missing_city_centers(city_xy, list(dist_sec.keys()))
    origin_center = _fetch_city_center(origin_city_id)

    features: List[GeoJSONFeature] = []

    # Always include origin marker if possible
    if origin_center is not None:
        lon0, lat0 = origin_center
        features.append(_to_point_feature(lon0, lat0, {"city_id": origin_city_id, "travel_time_min": 0, "level_min": 0}))

    for city_id, dsec in dist_sec.items():
        if city_id == origin_city_id:
            continue
        if city_id not in city_xy:
            continue
        lon, lat = city_xy[city_id]

        tmin = int(round(dsec / 60))
        level = int((tmin // interval_min) * interval_min)
        features.append(_to_point_feature(lon, lat, {"city_id": city_id, "travel_time_min": tmin, "level_min": level}))

    return GeoJSONFeatureCollection(
        features=features,
        meta={
            "origin_city_id": origin_city_id,
            "max_time_min": max_time_min,
            "interval_min": interval_min,
            "limit": limit,
            "note": "Point isochrone. Use /isochrones/cities/polygons for connected bands.",
        },
    )

@router.get("/od/cities", response_model=GeoJSONFeatureCollection)
def od_cities_visual(
    from_city_id: str = Query(..., description="Origin city_id"),
    limit: int = Query(200000, ge=1, le=200000, description="Max number of points to return"),
    max_time_min: Optional[int] = Query(None, ge=1, le=24 * 60, description="Optional filter (minutes)"),
):
    """
    Visual (direct OD) endpoint:
    - Returns direct city->city OD results from analysis.city_od_min_time
    - Intended for heatmap rendering (points), not network shortest-path expansion.
    """
    params: Dict[str, Any] = {
        "from_city_id": from_city_id,
        "limit": limit,
        "max_time_sec": (max_time_min * 60) if max_time_min is not None else None,
    }

    sql = text("""
      SELECT
        o.to_city_id,
        o.min_time_sec,
        COALESCE(c.center_lon, o.to_lon) AS lon,
        COALESCE(c.center_lat, o.to_lat) AS lat
      FROM analysis.city_od_min_time o
      LEFT JOIN cities.city c
        ON c.city_id = o.to_city_id
      WHERE o.from_city_id = :from_city_id
        AND (:max_time_sec IS NULL OR o.min_time_sec <= :max_time_sec)
        AND o.min_time_sec > 0
      ORDER BY o.min_time_sec ASC
      LIMIT :limit;
    """)

    with engine.connect() as conn:
        rows = conn.execute(sql, params).mappings().all()

    
    origin_center = _fetch_city_center(from_city_id)

    features: List[GeoJSONFeature] = []

    # Always include origin point (travel_time_min=0) if we have a center.
    # This is critical for front-end isochrone rendering (rings should be centered on the origin).
    if origin_center is not None:
        lon0, lat0 = origin_center
        features.append(
            _to_point_feature(
                float(lon0),
                float(lat0),
                {
                    "from_city_id": from_city_id,
                    "to_city_id": from_city_id,
                    "travel_time_min": 0.0,
                },
            )
        )

    for r in rows:
        if r["lon"] is None or r["lat"] is None:
            continue

        travel_time_min = round(float(r["min_time_sec"]) / 60.0, 1)
        features.append(
            _to_point_feature(
                float(r["lon"]),
                float(r["lat"]),
                {
                    "from_city_id": from_city_id,
                    "to_city_id": r["to_city_id"],
                    # IMPORTANT: front-end overlay reads this key
                    "travel_time_min": travel_time_min,
                },
            )
        )

    return GeoJSONFeatureCollection(
        features=features,
        meta={
            "from_city_id": from_city_id,
            "origin_center": {"lon": origin_center[0], "lat": origin_center[1]} if origin_center else None,
            "limit": limit,
            "max_time_min": max_time_min,
            "note": "Direct OD points from analysis.city_od_min_time (visual endpoint). Includes origin point (travel_time_min=0) when available.",
        },
    )


app.include_router(router)
