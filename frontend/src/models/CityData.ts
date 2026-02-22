// src/models/CityData.ts

export type LonLat = { lon: number; lat: number };

export interface CityIndexItem {
  city_id: string;
  city_name: string;
  country_code: string;
  iscapital: boolean;
  center: LonLat;

  route_count: number;
  route_count_norm: number;
  trip_count: number;
  trip_count_norm: number;
}

export interface CityIndexResponse {
  items: CityIndexItem[];
  meta: {
    limit: number;
    offset: number;
  };
}
