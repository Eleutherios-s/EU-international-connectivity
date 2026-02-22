export default interface CityCenterData {
  city: string,
  country: string,
  city_center: {
    lat: number,
    lon: number,
  },
  n_stops_in_city: number,
  stop_ids: number,
  stop_ids_truncated: number,
  limit: number
}
