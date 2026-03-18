# 🇪🇺 European Public Transport Connectivity

Interactive GIS platform for analyzing and visualizing international rail connectivity between European cities.

## Executive Summary

This project is a full-stack geospatial system that integrates multi-country GTFS feeds into a unified PostGIS database and provides an interactive web interface to explore:

- Cross-border rail routes 
- City-to-city travel time 
- Isochrone accessibility polygons
- A–B city connectivity comparison mode

The platform enables quantitative assessment of international rail accessibility, cross-border integration, and sustainable mobility potential.

## Problem Statement

European public transport data is fragmented across national GTFS feeds. Measuring international connectivity requires:

- Harmonizing multi-country GTFS datasets
- Aggregating stops to city-level spatial units (urban boundaries)
- Robust travel-time aggregation (beyond minimum time)
- Route geometry reconstruction and interactive visualization

This project addresses these challenges with spatial database engineering and an end-to-end web system.

## System Architecture

- Frontend (React + Leaflet)
- Backend (FastAPI)
- Database (PostgreSQL + PostGIS)


## Core Features

### 1) City Overview Map
- Visualizes all cities and high-level connectivity signals
- Click a city to enter Single-City mode

### 2) Single-City Mode
- Shows all international (cross-border) routes for the selected city
- Renders true GTFS shapes (not straight lines)
- Displays isochrone polygons (travel-time bands)

### 3) A–B City Mode
- Click a second city to switch to A–B connectivity mode
- Shows routes between City A and City B
- Exposes available service dates and example trips (implementation-specific)

### 4) Travel Time Modeling
- City-to-city travel time computed from stop-based routing outputs
- Aggregated as p25 (25th percentile) for robustness to outliers

### 5) Isochrone Polygons
- GeoJSON polygons representing travel-time accessibility bands
- Smoothed and rendered as connected layers on the map

## Tech Stack

- Database: PostgreSQL + PostGIS
- Backend: FastAPI (REST, GeoJSON)
- Frontend: React + Leaflet
- Containerization: Docker + Docker Compose
- Spatial processing: SQL (spatial joins, indexing, aggregation)

## Data

### GTFS
Multi-country GTFS feeds (rail-focused subset).

### City Boundaries
City polygons (e.g., Urban Audit / URAU) used for:
- stop-to-city assignment
- city-level aggregation and visualization

## Database Layout 

Schemas:
- `gtfs_train`: stops, routes, trips, stop_times, shapes
- `cities`: city_polygons, city_stops
- `analysis`: crossborder keys, international routes, city OD travel times (p25)

## API 

- `GET /api/cities/index`
- `GET /api/cities/{city_id}/crossborder/routes`
- `GET /api/od/cities`
- `GET /api/isochrones/cities/{city_id}`
- `GET /api/connections/{cityA}/{cityB}`

## Run Locally

### 1) Clone
```bash
git clone <repo-url>
cd <repo-folder>
```

### 2) Configure environment
Create a `.env` file:
```env
POSTGRES_DB=gis
POSTGRES_USER=user
POSTGRES_PASSWORD=password
GTFS_SOURCES_CSV=/seed/gtfs_sources.csv
CITIES_LB_URL=https://gisco-services.ec.europa.eu/distribution/v2/urau/gpkg/URAU_LB_2024_3035_CITIES.gpkg
URAU_RG_URL=https://gisco-services.ec.europa.eu/distribution/v2/urau/gpkg/URAU_RG_100K_2024_3035_CITIES.gpkg
database_url=postgresql+psycopg2://user:password@database:5432/gis
```

### 3) Start services
```
docker compose up --build
```
Typical endpoints:
Database: localhost:5432
Backend: http://localhost:8000
Frontend: http://localhost:5173 (or your configured port)

## Applications
International rail accessibility analysis
Cross-border integration and sustainable mobility evaluation
Tourism accessibility and planning
Regional transport policy and infrastructure assessment

## Author / Context
Developed as a GIS & Data Engineering project
University of Konstanz

## License
Academic project – educational use.
