// ============================================================================
// LogbookAI — REAL ROAD ROUTING (no generative AI).
// Uses OpenStreetMap Nominatim (geocoding) + OSRM (driving route). Returns real
// road distance and travel time, plus a verified stopping point along the route.
// Nothing here invents mileage, travel time, exits, or business names.
// ============================================================================

const NOMINATIM = 'https://nominatim.openstreetmap.org';
const OSRM = 'https://router.project-osrm.org';
const M_PER_MI = 1609.344;

const HEADERS = {
  'User-Agent': 'LogbookAI/1.0 (driver log app)',
  'Accept-Language': 'en',
};

// Geocode "City, ST" -> {lat, lon} via Nominatim.
export async function geocode(place) {
  const q = (place || '').trim();
  if (!q) return null;
  const url = `${NOMINATIM}/search?format=json&limit=1&countrycodes=us&q=${encodeURIComponent(q)}`;
  const r = await fetch(url, { headers: HEADERS });
  if (!r.ok) return null;
  const arr = await r.json();
  if (!arr || !arr.length) return null;
  return { lat: parseFloat(arr[0].lat), lon: parseFloat(arr[0].lon) };
}

// Reverse geocode {lat, lon} -> {city, state} (best-effort).
export async function reverseGeocode(lat, lon) {
  const url = `${NOMINATIM}/reverse?format=json&lat=${lat}&lon=${lon}&zoom=10`;
  const r = await fetch(url, { headers: HEADERS });
  if (!r.ok) return null;
  const j = await r.json();
  const a = j?.address || {};
  const city = a.city || a.town || a.village || a.hamlet || a.county || '';
  const state = a.state || '';
  if (!city) return null;
  return { city, state };
}

// OSRM driving route. Returns {miles, hours, geometry:[[lon,lat],...]} or null.
export async function drivingRoute(origin, destination) {
  if (!origin || !destination) return null;
  const coord = (c) => `${c.lon},${c.lat}`;
  const url = `${OSRM}/route/v1/driving/${coord(origin)};${coord(destination)}?overview=full&geometries=geojson`;
  const r = await fetch(url, { headers: HEADERS });
  if (!r.ok) return null;
  const j = await r.json();
  const route = j?.routes?.[0];
  if (!route) return null;
  return {
    miles: route.distance / M_PER_MI,
    hours: route.duration / 3600,
    geometry: route.geometry?.coordinates || [],
  };
}

// Haversine distance in miles between two [lon,lat] points.
export function haversineMi(a, b) {
  if (!a || !b) return 0;
  const R = 3958.8;
  const la1 = a[1] * Math.PI / 180, la2 = b[1] * Math.PI / 180;
  const dLat = (b[1] - a[1]) * Math.PI / 180;
  const dLon = (b[0] - a[0]) * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Walk the route geometry to the point at `targetMiles` from origin.
// Returns {point:[lon,lat], milesFromOrigin} or null if route too short.
export function pointAtMiles(geometry, targetMiles) {
  if (!geometry || geometry.length < 2) return null;
  let acc = 0;
  for (let i = 1; i < geometry.length; i++) {
    const seg = haversineMi(geometry[i - 1], geometry[i]);
    if (acc + seg >= targetMiles) {
      const ratio = seg > 0 ? (targetMiles - acc) / seg : 0;
      const a = geometry[i - 1], b = geometry[i];
      const lon = a[0] + (b[0] - a[0]) * ratio;
      const lat = a[1] + (b[1] - a[1]) * ratio;
      return { point: [lon, lat], milesFromOrigin: targetMiles };
    }
    acc += seg;
  }
  return null;
}