// src/models/Connections.ts

export interface ConnectionDateItem {
  service_date: string; // "YYYY-MM-DD"
  trip_count: number;
}

export interface ConnectionDatesResponse {
  city_id_a: string;
  city_id_b: string;
  date_from: string;
  date_to: string;
  items: ConnectionDateItem[];
  meta: Record<string, unknown>;
}

export interface StopTimeItem {
  stop_id: string;
  stop_name: string;
  arrival_time: string | null;
  departure_time: string | null;
  stop_sequence: number;
}

export interface TripItem {
  trip_id: string;
  service_id: string;
  direction_id: number | null;
  stops_in_city_a: StopTimeItem[];
  stops_in_city_b: StopTimeItem[];
}

export type GeoJSONLineString = {
  type: "LineString";
  coordinates: [number, number][];
};

export type GeoJSONFeature = {
  type: "Feature";
  geometry: GeoJSONLineString;
  properties?: Record<string, unknown>;
};

export interface ConnectionRouteItem {
  gtfs_country: string;
  route_id: string;
  route_short_name: string | null;
  route_long_name: string | null;
  shape: GeoJSONFeature | null;
  trips: TripItem[];
}

export interface ConnectionTripsResponse {
  meta: {
    city_id_a: string;
    city_id_b: string;
    service_date: string;
    include_shape: boolean;
    trip_returned: number;
    route_count: number;
  };
  routes: ConnectionRouteItem[];
}
