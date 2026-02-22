FROM postgis/postgis:16-3.4

COPY init/gtfs_schema.sql /docker-entrypoint-initdb.d/gtfs_schema.sql
# COPY init/urau_schema.sql /docker-entrypoint-initdb.d/urau_schema.sql

# curl for downlading from internet, unzip for data, rm delete unnecessary
RUN apt-get update && apt-get install -y --no-install-recommends \
    gdal-bin curl unzip \
    && rm -rf /var/lib/apt/lists/*

EXPOSE 5432
