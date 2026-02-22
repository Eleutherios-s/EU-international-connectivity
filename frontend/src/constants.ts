// src/constants.ts

// Backend base (NO trailing slash). Default works for local dev.
// You can set in .env: VITE_API_BASE_URL=http://localhost:8000
export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000";

export const API_PREFIX = "/api";

// Safety: initial city fetch cap (avoid rendering 200k markers at once)
export const CITY_INDEX_LIMIT = 8000;

// Default date range shown in panel
export const DEFAULT_DATE_FROM = "2024-01-01";
