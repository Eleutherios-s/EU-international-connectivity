SET search_path TO gtfs;

-- 1 agency
ALTER TABLE gtfs.agency
    ADD CONSTRAINT agency_pkey PRIMARY KEY (gtfs_country, agency_id);

-- 2 routes
ALTER TABLE gtfs.routes
    ADD CONSTRAINT routes_pkey PRIMARY KEY (gtfs_country, route_id);

ALTER TABLE gtfs.routes
    ADD CONSTRAINT routes_agency_fkey
    FOREIGN KEY (gtfs_country, agency_id)
    REFERENCES gtfs.agency (gtfs_country, agency_id);

-- 3 stops
ALTER TABLE gtfs.stops
    ADD CONSTRAINT stops_pkey PRIMARY KEY (gtfs_country, stop_id);

-- 4 calendar
ALTER TABLE gtfs.calendar
    ADD CONSTRAINT calendar_pkey PRIMARY KEY (gtfs_country, service_id);

-- 5 calendar_dates
ALTER TABLE gtfs.calendar_dates
    ADD CONSTRAINT calendar_dates_pkey PRIMARY KEY (calendar_dates_id);

ALTER TABLE gtfs.calendar_dates
    ADD CONSTRAINT calendar_dates_service_fkey
    FOREIGN KEY (gtfs_country, service_id)
    REFERENCES gtfs.calendar (gtfs_country, service_id);

ALTER TABLE gtfs.calendar_dates
    ADD CONSTRAINT calendar_dates_service_date_unique
    UNIQUE (gtfs_country, service_id, date);

-- 6 trips
ALTER TABLE gtfs.trips
    ADD CONSTRAINT trips_pkey PRIMARY KEY (gtfs_country, trip_id);

ALTER TABLE gtfs.trips
    ADD CONSTRAINT trips_route_id_fkey
    FOREIGN KEY (gtfs_country, route_id)
    REFERENCES gtfs.routes (gtfs_country, route_id);

ALTER TABLE gtfs.trips
    ADD CONSTRAINT trips_service_id_fkey
    FOREIGN KEY (gtfs_country, service_id)
    REFERENCES gtfs.calendar (gtfs_country, service_id);

-- 7 stop_times
ALTER TABLE gtfs.stop_times
    ADD CONSTRAINT stop_times_pkey PRIMARY KEY (stop_times_id);

ALTER TABLE gtfs.stop_times
    ADD CONSTRAINT stop_times_trip_fkey
    FOREIGN KEY (gtfs_country, trip_id)
    REFERENCES gtfs.trips (gtfs_country, trip_id);

ALTER TABLE gtfs.stop_times
    ADD CONSTRAINT stop_times_stop_fkey
    FOREIGN KEY (gtfs_country, stop_id)
    REFERENCES gtfs.stops (gtfs_country, stop_id);

ALTER TABLE gtfs.stop_times
    ADD CONSTRAINT stop_times_trip_seq_unique
    UNIQUE (gtfs_country, trip_id, stop_sequence);

-- 8 shapes
ALTER TABLE gtfs.shapes
    ADD CONSTRAINT shapes_pkey PRIMARY KEY (gtfs_country, shape_id, shape_pt_sequence);

-- 9 frequencies
ALTER TABLE gtfs.frequencies
    ADD CONSTRAINT frequencies_pkey PRIMARY KEY (frequencies_id);

ALTER TABLE gtfs.frequencies
    ADD CONSTRAINT frequencies_trip_fkey
    FOREIGN KEY (gtfs_country, trip_id)
    REFERENCES gtfs.trips (gtfs_country, trip_id);

-- 10 levels
ALTER TABLE gtfs.levels
    ADD CONSTRAINT levels_pkey PRIMARY KEY (gtfs_country, level_id);

-- 11 pathways
ALTER TABLE gtfs.pathways
    ADD CONSTRAINT pathways_pkey PRIMARY KEY (gtfs_country, pathway_id);

ALTER TABLE gtfs.pathways
    ADD CONSTRAINT pathways_from_stop_id_fkey
    FOREIGN KEY (gtfs_country, from_stop_id)
    REFERENCES gtfs.stops (gtfs_country, stop_id);

ALTER TABLE gtfs.pathways
    ADD CONSTRAINT pathways_to_stop_id_fkey
    FOREIGN KEY (gtfs_country, to_stop_id)
    REFERENCES gtfs.stops (gtfs_country, stop_id);

-- 12 transfers
ALTER TABLE gtfs.transfers
    ADD CONSTRAINT transfers_pkey PRIMARY KEY (transfer_id);

-- ALTER TABLE gtfs.transfers
--     ADD CONSTRAINT transfers_from_stop_fkey
--     FOREIGN KEY (gtfs_country, from_stop_id)
--     REFERENCES gtfs.stops (gtfs_country, stop_id);

-- ALTER TABLE gtfs.transfers
--     ADD CONSTRAINT transfers_to_stop_fkey
--     FOREIGN KEY (gtfs_country, to_stop_id)
--     REFERENCES gtfs.stops (gtfs_country, stop_id);

ALTER TABLE gtfs.transfers
    ADD CONSTRAINT transfers_from_route_fkey
    FOREIGN KEY (gtfs_country, from_route_id)
    REFERENCES gtfs.routes (gtfs_country, route_id);

ALTER TABLE gtfs.transfers
    ADD CONSTRAINT transfers_to_route_fkey
    FOREIGN KEY (gtfs_country, to_route_id)
    REFERENCES gtfs.routes (gtfs_country, route_id);

ALTER TABLE gtfs.transfers
    ADD CONSTRAINT transfers_from_trip_fkey
    FOREIGN KEY (gtfs_country, from_trip_id)
    REFERENCES gtfs.trips (gtfs_country, trip_id);

ALTER TABLE gtfs.transfers
    ADD CONSTRAINT transfers_to_trip_fkey
    FOREIGN KEY (gtfs_country, to_trip_id)
    REFERENCES gtfs.trips (gtfs_country, trip_id);
