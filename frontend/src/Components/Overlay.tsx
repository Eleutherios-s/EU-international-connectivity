// src/Components/Overlay.tsx
import styles from "./Overlay.module.css";

import type { CityIndexItem } from "../models/CityData";
import type { ConnectionDateItem, ConnectionRouteItem, ConnectionTripsResponse } from "../models/Connections";

function CityBadge({ label, city }: { label: "A" | "B"; city: CityIndexItem | null }) {
  return (
    <div className={styles.badge}>
      <div className={styles.badgeLabel}>{label}</div>
      {city ? (
        <div className={styles.badgeBody}>
          <div className={styles.badgeTitle}>{city.city_name}</div>
          <div className={styles.badgeMeta}>
            <span>{city.country_code}</span>
            <span>·</span>
            {city.iscapital === true && <span>Capital</span>}
          </div>
        </div>
      ) : (
        <div className={styles.badgeBody}>
          <div className={styles.badgeTitleMuted}>Not selected</div>
          <div className={styles.badgeMetaMuted}>Click a city marker</div>
        </div>
      )}
    </div>
  );
}

function TripRow({ r }: { r: ConnectionRouteItem }) {
  const tripCount = r.trips?.length ?? 0;
  return (
    <div className={styles.routeCard}>
      <div className={styles.routeHeader}>
        <div className={styles.routeTitle}>
          <div className={styles.routeName}>
            {r.route_short_name ? `#${r.route_short_name}` : "(no short name)"}{" "}
            {r.route_long_name ? `— ${r.route_long_name}` : ""}
          </div>
          <div className={styles.routeMeta}>
            <span>{r.gtfs_country}</span>
            <span>·</span>
            <code>{r.route_id}</code>
            <span>·</span>
            <span>trips: {tripCount}</span>
          </div>
        </div>
      </div>

      <div className={styles.tripList}>
        {r.trips.slice(0, 30).map((t) => {
          return (
            <div key={t.trip_id} className={styles.tripItem}>
              <div className={styles.tripTop}>
               Trip id: <code>{t.trip_id}</code>
                <span className={styles.dot}>·</span>
                <span>
                  Service id: <code>{t.service_id}</code>
                </span>
                <span className={styles.dot}>·</span>
              </div>

              <div className={styles.tripTimes}>
                <div className={styles.tripTimesCol}>
                  <div className={styles.tripTimesLabel}>City A stops</div>
                  {t.stops_in_city_a?.slice(0, 2).map((s) => (
                    <div key={s.stop_id} className={styles.stopLine}>
                      <span>{s.stop_name}</span>
                      <span className={styles.timeMono}>{s.departure_time ?? s.arrival_time ?? ""}</span>
                    </div>
                  ))}
                  {(!t.stops_in_city_a || t.stops_in_city_a.length === 0) && (
                    <div className={styles.muted}>no stop found in A</div>
                  )}
                </div>

                <div className={styles.tripTimesCol}>
                  <div className={styles.tripTimesLabel}>City B stops</div>
                  {t.stops_in_city_b?.slice(0, 2).map((s) => (
                    <div key={s.stop_id} className={styles.stopLine}>
                      <span>{s.stop_name}</span>
                      <span className={styles.timeMono}>{s.arrival_time ?? s.departure_time ?? ""}</span>
                    </div>
                  ))}
                  {(!t.stops_in_city_b || t.stops_in_city_b.length === 0) && (
                    <div className={styles.muted}>no stop found in B</div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
        {tripCount > 30 && <div className={styles.muted}>Showing first 30 trips for this route…</div>}
      </div>
    </div>
  );
}

export default function Overlay(props: {
  cityA: CityIndexItem | null;
  cityB: CityIndexItem | null;

  onClear: () => void;   // Reset A/B
  onResetB: () => void;  // Reset B only

  dateFrom: string;
  dateTo: string;
  onChangeDateFrom: (v: string) => void;
  onChangeDateTo: (v: string) => void;

  // Single-city A layer status
  aLayersLoading: boolean;
  aLayersError: string | null;
  aCrossborderRouteCount: number;

  // A-B dates
  datesLoading: boolean;
  datesError: string | null;
  dateItems: ConnectionDateItem[];
  selectedServiceDate: string | null;
  onSelectServiceDate: (d: string) => void;

  // A-B trips/routes
  tripsLoading: boolean;
  tripsError: string | null;
  tripsMeta: ConnectionTripsResponse["meta"] | null;
  routes: ConnectionRouteItem[];

  limitTrips: number;
  offsetTrips: number;
  onChangeLimitTrips: (n: number) => void;
  onChangeOffsetTrips: (n: number) => void;
}) {
  const {
    cityA,
    cityB,
    onClear,
    onResetB,
    dateFrom,
    dateTo,
    onChangeDateFrom,
    onChangeDateTo,
    aLayersLoading,
    aLayersError,
    aCrossborderRouteCount,
    datesLoading,
    datesError,
    dateItems,
    selectedServiceDate,
    onSelectServiceDate,
    tripsLoading,
    tripsError,
    tripsMeta,
    routes,
    limitTrips,
    offsetTrips,
    onChangeLimitTrips,
    onChangeOffsetTrips,
  } = props;

  const readyAB = Boolean(cityA && cityB);

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <div className={styles.headerTitle}>EU Rail Connectivity</div>

        <div style={{ display: "flex", gap: 8 }}>
          <button
            className={styles.secondaryBtn}
            onClick={onResetB}
            disabled={!cityB}
          >
            Reset B
          </button>

          <button
            className={styles.primaryBtn}
            onClick={onClear}
          >
            Reset A/B
          </button>
        </div>
      </div>

      <div className={styles.section}>
        <CityBadge label="A" city={cityA} />
        <CityBadge label="B" city={cityB} />
      </div>

      {/* Single-city A status */}
      {cityA && (
        <div className={styles.section}>
          <div className={styles.sectionTitle}>City A layers</div>
          <div className={styles.metaCard}>
            {aLayersLoading && <div></div>}
            {aLayersError && <div className={styles.error}>A-layer error: {aLayersError}</div>}
            {!aLayersLoading && !aLayersError && (
              <>
                <div>
                  <b>International route count:</b> {aCrossborderRouteCount}
                </div>
                <div className={styles.muted}></div>
              </>
            )}
          </div>
        </div>
      )}

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Date range (A–B)</div>
        <div className={styles.row}>
          <label className={styles.label}>
            from
            <input
              className={styles.input}
              type="date"
              value={dateFrom}
              onChange={(e) => onChangeDateFrom(e.target.value)}
              disabled={!readyAB}
            />
          </label>
          <label className={styles.label}>
            to
            <input
              className={styles.input}
              type="date"
              value={dateTo}
              onChange={(e) => onChangeDateTo(e.target.value)}
              disabled={!readyAB}
            />
          </label>
        </div>

        {!readyAB && <div className={styles.muted}>Select city A and B to load available service dates.</div>}
        {datesLoading && <div>Loading dates…</div>}
        {datesError && <div className={styles.error}>Dates error: {datesError}</div>}
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Service dates (A–B)</div>
        <div className={styles.dateList}>
          {dateItems.length === 0 && readyAB && !datesLoading && !datesError && (
            <div className={styles.muted}>No service dates found in range.</div>
          )}

          {dateItems.map((it) => {
            const active = it.service_date === selectedServiceDate;
            return (
              <button
                key={it.service_date}
                className={`${styles.dateBtn} ${active ? styles.dateBtnActive : ""}`}
                onClick={() => onSelectServiceDate(it.service_date)}
              >
                <span className={styles.dateText}>{it.service_date}</span>
                <span className={styles.dateCount}>{it.trip_count}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Trips & routes (A–B)</div>

        <div className={styles.row}>
          <label className={styles.label}>
            limit_trips
            <input
              className={styles.input}
              type="number"
              value={limitTrips}
              min={1}
              max={5000}
              onChange={(e) => onChangeLimitTrips(Number(e.target.value))}
              disabled={!readyAB || !selectedServiceDate}
            />
          </label>
          <label className={styles.label}>
            Offset trips
            <input
              className={styles.input}
              type="number"
              value={offsetTrips}
              min={0}
              onChange={(e) => onChangeOffsetTrips(Number(e.target.value))}
              disabled={!readyAB || !selectedServiceDate}
            />
          </label>
        </div>

        {tripsLoading && <div>Loading trips…</div>}
        {tripsError && <div className={styles.error}>Trips error: {tripsError}</div>}

        {tripsMeta && (
          <div className={styles.metaCard}>
            <div>
              <b>Service date:</b> {tripsMeta.service_date}
            </div>
            <div>
              <b>Rounte counts:</b> {tripsMeta.route_count} · <b>Trip count:</b> {tripsMeta.trip_returned}
            </div>
          </div>
        )}

        <div className={styles.routesWrap}>
          {routes.map((r) => (
            <div
              key={`${r.gtfs_country}:${r.route_id}`}
              className={styles.hideRouteHeader}
            >
              <TripRow r={r} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
