import { useEffect, useMemo, useState } from "react";
import styles from "./App.module.css";

import { API_BASE_URL, API_PREFIX, CITY_INDEX_LIMIT, DEFAULT_DATE_FROM } from "./constants";

import type { CityIndexItem, CityIndexResponse } from "./models/CityData";
import type {
  ConnectionDatesResponse,
  ConnectionDateItem,
  ConnectionTripsResponse,
  ConnectionRouteItem,
  GeoJSONFeature,
} from "./models/Connections";

import type { CrossborderRoutesResponse } from "./models/Crossborder";
import type { GeoJSONFeatureCollectionPoint } from "./models/Isochrone";

import MapView from "./Components/Map";
import Overlay from "./Components/Overlay";

type GeoJSONFeatureCollection = {
  type: "FeatureCollection";
  features: GeoJSONFeature[];
  meta?: any;
};

type CityRoutesOverviewResponse = {
  city: any;
  route_stats: Record<string, any>;
  connected_cities: Array<{
    city_id: string;
    city_name: string;
    country_code: string;
    center: { lon: number; lat: number };
    is_foreign_city: boolean;
    is_crossborder_connection: boolean;
    route_count: number;
    trip_count: number;
  }>;
};


function toISODate(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function diffDaysInclusive(dateFrom: string, dateTo: string): number {
  const a = new Date(dateFrom + "T00:00:00");
  const b = new Date(dateTo + "T00:00:00");
  const ms = b.getTime() - a.getTime();
  const days = Math.floor(ms / (1000 * 60 * 60 * 24)) + 1;
  return Math.max(days, 1);
}

async function apiGet<T>(pathWithQuery: string): Promise<T> {
  const url = `${API_BASE_URL}${API_PREFIX}${pathWithQuery}`;
  const res = await fetch(url);
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${txt}`);
  }
  return (await res.json()) as T;
}

async function apiGetAllow404<T>(pathWithQuery: string): Promise<T | null> {
  const url = `${API_BASE_URL}${API_PREFIX}${pathWithQuery}`;
  const res = await fetch(url);

  if (res.status === 404) return null;

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${txt}`);
  }
  return (await res.json()) as T;
}

export default function App() {
  const [cities, setCities] = useState<CityIndexItem[]>([]);
  const [citiesLoading, setCitiesLoading] = useState(false);
  const [citiesError, setCitiesError] = useState<string | null>(null);

  const [cityA, setCityA] = useState<CityIndexItem | null>(null);
  const [cityB, setCityB] = useState<CityIndexItem | null>(null);

  const todayISO = useMemo(() => toISODate(new Date()), []);
  const [dateFrom, setDateFrom] = useState<string>(DEFAULT_DATE_FROM);
  const [dateTo, setDateTo] = useState<string>(todayISO);

  // A-only layers
  const [aCrossborder, setACrossborder] = useState<CrossborderRoutesResponse | null>(null); // for foreign stop pins
  const [aCrossborderShapesFC, setACrossborderShapesFC] = useState<GeoJSONFeatureCollection | null>(null); // A-only real shapes
  const [aIsochrones, setAIsochrones] = useState<GeoJSONFeatureCollectionPoint | null>(null); // keep points for debug (optional)
  const [aIsoPolygons, setAIsoPolygons] = useState<GeoJSONFeatureCollection | null>(null); // connected bands

  const [aLayersLoading, setALayersLoading] = useState(false);
  const [aLayersError, setALayersError] = useState<string | null>(null);

  // AB calendar + trips
  const [datesLoading, setDatesLoading] = useState(false);
  const [datesError, setDatesError] = useState<string | null>(null);
  const [dateItems, setDateItems] = useState<ConnectionDateItem[]>([]);
  const [selectedServiceDate, setSelectedServiceDate] = useState<string | null>(null);

  const [tripsLoading, setTripsLoading] = useState(false);
  const [tripsError, setTripsError] = useState<string | null>(null);
  const [routes, setRoutes] = useState<ConnectionRouteItem[]>([]);
  const [tripsMeta, setTripsMeta] = useState<ConnectionTripsResponse["meta"] | null>(null);

  const [limitTrips, setLimitTrips] = useState<number>(100);
  const [offsetTrips, setOffsetTrips] = useState<number>(0);

  // ========== load city index ==========
  useEffect(() => {
    let cancelled = false;

    (async () => {
      setCitiesLoading(true);
      setCitiesError(null);
      try {
        const data = await apiGet<CityIndexResponse>(`/cities/index?limit=${CITY_INDEX_LIMIT}&offset=0`);
        if (cancelled) return;
        setCities(data.items ?? []);
      } catch (e: any) {
        if (cancelled) return;
        setCitiesError(e?.message ?? String(e));
      } finally {
        if (cancelled) return;
        setCitiesLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // ========== A-only layers ==========
  useEffect(() => {
    if (!cityA) {
      setACrossborder(null);
      setACrossborderShapesFC(null);
      setAIsochrones(null);
      setAIsoPolygons(null);
      setALayersError(null);
      return;
    }

    let cancelled = false;

    (async () => {
      setALayersLoading(true);
      setALayersError(null);
      setAIsoPolygons(null);

      try {
        // 1) route_dict + foreign stops (pins)
        const r1 = await apiGetAllow404<CityRoutesOverviewResponse>(`/cities/${cityA.city_id}/routes/overview`);

        // 2) A-only shapes: GTFS-correct shapes from crossborder trips
        const rShapes = await apiGetAllow404<GeoJSONFeatureCollection>(
          `/cities/${cityA.city_id}/shapes?k=260`
        );

        // 3) OD points (best for isochrone-style overlay on the front-end)
        // NOTE: server should include the origin point (travel_time_min=0) for proper centering.
        const odQs = new URLSearchParams({
          from_city_id: cityA.city_id,
          max_time_min: "720",
          limit: "50000",
        });
        const rPts = await apiGet<GeoJSONFeatureCollectionPoint>(`/od/cities?${odQs.toString()}`);
        if (cancelled) return;

        setACrossborder(r1);
        setACrossborderShapesFC(rShapes);
        setAIsochrones(rPts);
      } catch (e: any) {
        if (cancelled) return;
        setALayersError(e?.message ?? String(e));
        setACrossborder(null);
        setACrossborderShapesFC(null);
        setAIsochrones(null);
        setAIsoPolygons(null);
      } finally {
        if (cancelled) return;
        setALayersLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [cityA?.city_id]);

  // ========== AB dates ==========
  useEffect(() => {
    if (!cityA || !cityB) {
      setDateItems([]);
      setSelectedServiceDate(null);
      setRoutes([]);
      setTripsMeta(null);
      return;
    }

    let cancelled = false;

    (async () => {
      setDatesLoading(true);
      setDatesError(null);

      const span = diffDaysInclusive(dateFrom, dateTo);

      try {
        const qs = new URLSearchParams({
          city_id_a: cityA.city_id,
          city_id_b: cityB.city_id,
          date_from: dateFrom,
          date_to: dateTo,
          limit_days: String(span),
        });

        const data = await apiGet<ConnectionDatesResponse>(`/connections/dates?${qs.toString()}`);
        if (cancelled) return;

        const items = data.items ?? [];
        setDateItems(items);

        const first = items.length > 0 ? items[0].service_date : null;
        setSelectedServiceDate(first);

        setOffsetTrips(0);
      } catch (e: any) {
        if (cancelled) return;
        setDatesError(e?.message ?? String(e));
        setDateItems([]);
        setSelectedServiceDate(null);
      } finally {
        if (cancelled) return;
        setDatesLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [cityA?.city_id, cityB?.city_id, dateFrom, dateTo]);

  // ========== AB trips ==========
  useEffect(() => {
    if (!cityA || !cityB || !selectedServiceDate) {
      setRoutes([]);
      setTripsMeta(null);
      return;
    }

    let cancelled = false;

    (async () => {
      setTripsLoading(true);
      setTripsError(null);

      try {
        const qs = new URLSearchParams({
          city_id_a: cityA.city_id,
          city_id_b: cityB.city_id,
          service_date: selectedServiceDate,
          limit_trips: String(limitTrips),
          offset_trips: String(offsetTrips),
        });

        const data = await apiGet<ConnectionTripsResponse>(`/connections/trips?${qs.toString()}`);
        if (cancelled) return;

        setRoutes(data.routes ?? []);
        setTripsMeta(data.meta ?? null);
      } catch (e: any) {
        if (cancelled) return;
        setTripsError(e?.message ?? String(e));
        setRoutes([]);
        setTripsMeta(null);
      } finally {
        if (cancelled) return;
        setTripsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [cityA?.city_id, cityB?.city_id, selectedServiceDate, limitTrips, offsetTrips]);

  // ========== shape arrays for Map component ==========
  const aCrossborderShapes: GeoJSONFeature[] = useMemo(() => {
    if (!aCrossborderShapesFC?.features) return [];
    return aCrossborderShapesFC.features.filter((f) => f?.geometry?.type === "LineString");
  }, [aCrossborderShapesFC]);

  const abShapes: GeoJSONFeature[] = useMemo(() => {
    return routes
      .map((r) => (r as any).shape)
      .filter((s): s is GeoJSONFeature => Boolean(s && s.geometry && s.geometry.type === "LineString"));
  }, [routes]);

  // polygons FC for Map
  const aIsoPolygonsFC: GeoJSONFeatureCollection | null = useMemo(() => {
    if (!aIsoPolygons?.features) return null;
    return aIsoPolygons;
  }, [aIsoPolygons]);

  function onCityMarkerClick(clicked: CityIndexItem) {
    if (!cityA) {
      setCityA(clicked);
      setCityB(null);
      return;
    }
    if (cityA && !cityB) {
      if (clicked.city_id === cityA.city_id) return;
      setCityB(clicked);
      return;
    }
    setCityA(clicked);
    setCityB(null);
  }

  function clearSelection() {
    setCityA(null);
    setCityB(null);

    setACrossborder(null);
    setACrossborderShapesFC(null);
    setAIsochrones(null);
    setAIsoPolygons(null);
    setALayersError(null);

    setDateItems([]);
    setSelectedServiceDate(null);

    setRoutes([]);
    setTripsMeta(null);

    setDatesError(null);
    setTripsError(null);

    setOffsetTrips(0);
  }

  function resetBOnly() {
    setCityB(null);

    setDateItems([]);
    setSelectedServiceDate(null);

    setRoutes([]);
    setTripsMeta(null);

    setDatesError(null);
    setTripsError(null);

    setOffsetTrips(0);
  }

  const aCrossborderRouteCount = aCrossborder?.routes ? Object.keys(aCrossborder.routes).length : 0;

  return (
    <div className={styles.layout}>
      <div className={styles.mapPane}>
        <MapView
          cities={cities}
          loading={citiesLoading}
          error={citiesError}
          cityA={cityA}
          cityB={cityB}
          onCityClick={onCityMarkerClick}
          aIsochrones={aIsochrones}
          aIsoPolygons={aIsoPolygonsFC}
          aCrossborder={aCrossborder}
          aCrossborderShapes={aCrossborderShapes}
          abShapes={abShapes}
        />
      </div>

      <div className={styles.sidePane}>
        <Overlay
          cityA={cityA}
          cityB={cityB}
          onClear={clearSelection}
          onResetB={resetBOnly}
          dateFrom={dateFrom}
          dateTo={dateTo}
          onChangeDateFrom={setDateFrom}
          onChangeDateTo={setDateTo}
          aLayersLoading={aLayersLoading}
          aLayersError={aLayersError}
          aCrossborderRouteCount={aCrossborderRouteCount}
          datesLoading={datesLoading}
          datesError={datesError}
          dateItems={dateItems}
          selectedServiceDate={selectedServiceDate}
          onSelectServiceDate={(d) => {
            setSelectedServiceDate(d);
            setOffsetTrips(0);
          }}
          tripsLoading={tripsLoading}
          tripsError={tripsError}
          tripsMeta={tripsMeta}
          routes={routes}
          limitTrips={limitTrips}
          offsetTrips={offsetTrips}
          onChangeLimitTrips={setLimitTrips}
          onChangeOffsetTrips={setOffsetTrips}
        />
      </div>
    </div>
  );
}
