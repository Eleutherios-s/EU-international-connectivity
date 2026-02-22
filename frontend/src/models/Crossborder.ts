// src/models/Crossborder.ts
import type { LonLat } from "./CityData";

export interface CrossborderCity {
  city_id: string;
  city_name: string;
  country_code: string;
  center: LonLat;
  include_shape: boolean;
  note?: string;
}


export interface CrossborderShapeRaw {
  shape_id: string;
  geometry: any; // GeoJSON geometry dict
}

export interface CrossborderRoutePayload {
  foreign_stops?: Record<string, any>;
  foreign_stop_count?: number;
  shape: CrossborderShapeRaw | null;
}

export interface CrossborderRoutesResponse {
  city: CrossborderCity;
  routes: Record<string, CrossborderRoutePayload>; // key: "<gtfs_country>:<route_id>"
}
