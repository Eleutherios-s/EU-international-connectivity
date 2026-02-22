// src/models/Isochrone.ts

export type GeoJSONPoint = {
  type: "Point";
  coordinates: [number, number]; // [lon, lat]
};

export type GeoJSONFeaturePoint = {
  type: "Feature";
  geometry: GeoJSONPoint;
  properties?: Record<string, any>;
};

export interface GeoJSONFeatureCollectionPoint {
  type: "FeatureCollection";
  features: GeoJSONFeaturePoint[];
  meta?: Record<string, any>;
}
