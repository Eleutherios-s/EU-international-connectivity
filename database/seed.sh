#!/bin/sh

sh ./seed-cities.sh
sh ./seed-gtfs.sh
sh ./seed-filter-train-only.sh
sh ./seed-city-stops.sh
sh ./seed-index.sh
sh /seed-city-od.sh