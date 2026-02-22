CREATE SCHEMA IF NOT EXISTS gtfs;
SET search_path TO gtfs;

-- 1 agency
CREATE TABLE IF NOT EXISTS agency(
    gtfs_country    text NOT NULL,
    agency_id       text NOT NULL,
    agency_name     text NOT NULL,
    agency_url      text NOT NULL,
    agency_timezone text NOT NULL,
    agency_lang     text,
    agency_phone    text
);

-- 2 routes
CREATE TABLE IF NOT EXISTS routes(
    gtfs_country        text NOT NULL,
    route_id            text NOT NULL,
    agency_id           text,
    route_short_name    text,
    route_long_name     text,
    route_desc          text,
    route_type          integer NOT NULL,
    route_url           text,
    route_color         text,
    route_text_color    text
);

-- 3 stops
CREATE TABLE IF NOT EXISTS stops(
    gtfs_country         text NOT NULL,
    stop_id              text NOT NULL,
    stop_code            text,
    stop_name            text NOT NULL,
    stop_desc            text,
    stop_lat             double precision NOT NULL,
    stop_lon             double precision NOT NULL,
    location_type        integer,
    parent_station       text,
    wheelchair_boarding  integer,
    platform_code        text,
    level_id             text
);

-- 4 calendar
CREATE TABLE IF NOT EXISTS calendar(
    gtfs_country    text NOT NULL,
    service_id      text NOT NULL,
    monday          smallint NOT NULL,
    tuesday         smallint NOT NULL,
    wednesday       smallint NOT NULL,
    thursday        smallint NOT NULL,
    friday          smallint NOT NULL,
    saturday        smallint NOT NULL,
    sunday          smallint NOT NULL,
    start_date      date NOT NULL,
    end_date        date NOT NULL
);

-- 5 calendar_dates
CREATE TABLE IF NOT EXISTS calendar_dates(
    calendar_dates_id   bigserial,
    gtfs_country        text NOT NULL,
    service_id          text NOT NULL,
    date                date NOT NULL,
    exception_type      smallint
);

-- 6 trips
CREATE TABLE IF NOT EXISTS trips(
    gtfs_country            text NOT NULL,
    route_id                text NOT NULL,
    service_id              text NOT NULL,
    trip_id                 text NOT NULL,
    trip_headsign           text,
    trip_short_name         text,
    direction_id            smallint,
    block_id                text,
    shape_id                text,
    wheelchair_accessible   smallint,
    bikes_allowed           smallint
);

-- 7 stop_times
CREATE TABLE IF NOT EXISTS stop_times(
    stop_times_id       bigserial,
    gtfs_country        text NOT NULL,
    trip_id             text NOT NULL,
    stop_id             text NOT NULL,
    stop_sequence       integer NOT NULL,
    pickup_type         smallint,
    drop_off_type       smallint,
    stop_headsign       text,
    arrival_time        text,
    departure_time      text
);

-- 8 shapes
CREATE TABLE IF NOT EXISTS shapes(
    gtfs_country        text NOT NULL,
    shape_id            text NOT NULL,
    shape_pt_lat        double precision NOT NULL,
    shape_pt_lon        double precision NOT NULL,
    shape_pt_sequence   integer NOT NULL
);

-- 9 frequencies
CREATE TABLE IF NOT EXISTS frequencies(
    frequencies_id      bigserial,
    gtfs_country        text NOT NULL,
    trip_id             text NOT NULL,
    start_time          text,
    end_time            text,
    headway_secs        integer,
    exact_times         text
);

-- 10 levels
CREATE TABLE IF NOT EXISTS levels(
    gtfs_country    text NOT NULL,
    level_id        text NOT NULL,
    level_index     text
);

-- 11 pathways
CREATE TABLE IF NOT EXISTS pathways(
    gtfs_country        text NOT NULL,
    pathway_id          text NOT NULL,
    from_stop_id        text,
    to_stop_id          text,
    pathway_mode        smallint,
    is_bidirectional    smallint,
    traversal_time      text,
    length              text,
    stair_count         text,
    max_slope           text,
    min_width           text,
    signposted_as       text
);

-- 12 transfers
CREATE TABLE IF NOT EXISTS transfers(
    transfer_id         bigserial,
    gtfs_country        text NOT NULL,
    from_stop_id        text NOT NULL,
    to_stop_id          text NOT NULL,
    transfer_type       smallint,
    min_transfer_time   integer,
    from_route_id       text,
    to_route_id         text,
    from_trip_id        text,
    to_trip_id          text
);
