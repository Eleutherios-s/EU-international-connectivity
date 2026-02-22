# Databases

## GTFS
Holds the entire ground truth in `gtfs` tables.

### non-exhaustive ER Diagram
```mermaid
erDiagram

STOPS {

int stop_id PK

lat stop_lat

lng stop_lon

enum location_type

}

ROUTES {

string route_id PK

enum route_type

int route_sort_order

}

ROUTES }|--|| TRIPS : has

CALENDAR ||--|{ TRIPS : has

TRIPS }|--|| SHAPES : has

TRIPS {

int trip_id PK

string route_id FK

int service_id FK

int shape_id FK

}

TRIPS ||--|{ FREQUENCIES : has

FREQUENCIES {

%% Probably unimportant as not covered in DE data

int trip_id PK, FK

time start_time PK

time end_time

int headway_secs

}

TRIPS }|--|| STOP_TIMES : has

STOPS }|--|| STOP_TIMES : has

STOP_TIMES {

int trip_id PK, FK

time arrival_time

time departure_time

int stop_id FK

int stop_sequence

}

CALENDAR {

int service_id PK

bool monday

bool tuesday

bool wednesday

bool thursday

bool friday

bool saturday

bool sunday

date start_date

date end_date

}

CALENDAR_DATES }|--|| CALENDAR : has

CALENDAR_DATES {

int service_id PK, FK

date date

enum exception_type

}

SHAPES {

int shape_id PK

lat shape_pt_lat

lon shape_pt_lon

int shape_pt_sequence PK
}

%% ROUTES }|--|{ TRANSFERS : has
%% STOPS }|--|{ TRANSFERS : has
%% TRIPS }|--|{ TRANSFERS : has

TRANSFERS {
%% Ignorable for the start
}
```

## EPTC
Holds the entire preprocessed data that the European Public Transport Connectivity project will display and work with.
```mermaid
erDiagram
    CITIES }|--O{ STOPS : "has"
    STOPS }|--|{ ROUTE_DATA : "has"
    ROUTE_DATA }|--|{ ROUTES : "has"

    CITIES {
        string city_name PK
        char(2) country_code PK
        float longitude
        float latitude
        array polygon
    }

    STOPS {
        string stop_id PK
        float longitude
        float latitude
    }

    ROUTES {
        string route_id PK
        int route_sort_order PK
        array city_time_data
        float frequency
    }

    ROUTE_DATA {
        string route_id PK, FK
        string stop_id PK, FK
        int stop_order
        float delta_time
    }
```
