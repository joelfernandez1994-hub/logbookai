// ============================================================================
// LogbookAI — TRUCK STOP / PARKING DISCOVERY PROVIDER ABSTRACTION.
// ----------------------------------------------------------------------------
// LogbookAI's HOS engine (hosEngine.js / complianceStop.js / planTripStops)
// is solely responsible for deciding WHEN a driver needs to stop and roughly
// WHERE along the real route that is. LogbookAI does not have, and will
// never invent, real-time truck-stop or parking-availability data — that
// requires a live external source it does not have access to.
//
// This module is the seam between "a LogbookAI stop suggestion" and "an
// external truck-stop/parking discovery app". A specific provider (Trucker
// Path today) is never referenced directly from Trip.jsx or complianceStop.js
// — everything goes through getParkingProvider()/buildParkingHandoff() so a
// second provider (another truck-stop app, or a future in-house truck-stop
// database) can be added here later without touching the HOS stop planner.
//
// Trucker Path research (confirmed against their own fleet-navigation help
// center, not scraped or reverse-engineered):
//   - No public developer API exists for pulling live truck-stop/parking
//     availability data. Only enterprise/fleet dispatch integrations are
//     mentioned, gated behind contacting fleetsupport@truckerpath.com — not
//     something this integration can or does use.
//   - They DO publish a URL-launcher/deep-link URI scheme requiring no API
//     key: truckerpath://cal_route?daddr=LAT,LNG (destination REQUIRED, as
//     real coordinates — not a city name).
//   - Their docs explicitly say there is no automatic fallback if the app
//     isn't installed ("the link will not resolve") and they do not publish
//     a web fallback URL. We do not invent one — callers must handle the
//     "app not installed" case honestly (see Trip.jsx).
// ============================================================================

const truckerPath = {
  id: 'truckerPath',
  label: 'Trucker Path',
  // { lat, lng } must be REAL, route-derived coordinates (e.g. from the
  // complianceStop backend's stop_lat/stop_lng) — never a fabricated point.
  buildHandoffUrl(stop) {
    const { lat, lng } = stop || {};
    if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return `truckerpath://cal_route?daddr=${lat},${lng}`;
  },
  // No documented web fallback exists for this scheme — do not invent one.
  webFallbackUrl() {
    return null;
  },
};

const PROVIDERS = { truckerPath };

export function getParkingProvider(id = 'truckerPath') {
  return PROVIDERS[id] || null;
}

// True only when the stop carries real, route-derived coordinates — never
// true for a mileage-only/unresolved stop, so the UI never offers a handoff
// button pointing at a missing or fabricated location.
export function canHandoffToParking(stop, providerId = 'truckerPath') {
  const provider = getParkingProvider(providerId);
  if (!provider || !stop) return false;
  return !!provider.buildHandoffUrl(stop);
}

// Returns { providerId, providerLabel, appUrl, webUrl } or null if the stop
// has no usable coordinates yet (e.g. still resolving, or reverse geocoding
// hasn't returned lat/lng for this stop).
export function buildParkingHandoff(stop, providerId = 'truckerPath') {
  const provider = getParkingProvider(providerId);
  if (!provider) return null;
  const appUrl = provider.buildHandoffUrl(stop);
  if (!appUrl) return null;
  return { providerId, providerLabel: provider.label, appUrl, webUrl: provider.webFallbackUrl(stop) };
}
