// ============================================================================
// LogbookAI — TRUCK-STOP DISCOVERY provider abstraction.
// ----------------------------------------------------------------------------
// Separate concern from parkingProvider.js (which only builds the Trucker
// Path deep-link for a live parking CHECK). This module answers a different
// question: "which real, named truck stops actually exist near the route
// point where the HOS engine says a stop is needed?" — using only supported,
// public data. Today that's OpenStreetMap/Overpass, reached through the
// truckStopSearch backend function (base44/functions/truckStopSearch/entry.ts).
// No scraping of Trucker Path or any private/undocumented endpoint.
//
//   Route + HOS  →  planTripStops() picks the mile  →  findTruckStopsNearStop()
//   asks a supported POI source what's really there  →  rankTruckStops() /
//   pickTopStopsForType() decide which 2-3 are worth showing.
//
// HOS decides WHEN/roughly WHERE (complianceStop.js). This module NEVER
// moves that point — it only orders and filters real POIs found near it,
// favoring minimal detour over brand preference, and it never fabricates
// live parking or fuel-price data: only tags a real data source actually set
// are ever surfaced.
//
// A second discovery provider (another POI API, or an in-house truck-stop
// database) only needs to expose the same POI shape — { name, lat, lng,
// has_fuel, has_parking_tag, is_named_truck_stop, off_route_mi,
// distance_from_stop_mi } — and be wired in here; Trip.jsx never changes.
// ============================================================================

import { base44 } from '@/api/base44Client';

// Fetches candidate truck-stop POIs near a specific mile along the real
// route (see truckStopSearch/entry.ts — currently backed by OpenStreetMap's
// public Overpass API). Returns the raw response; call rankTruckStops() to
// order/filter it before showing anything to the driver.
export async function findTruckStopsNearStop({ origin, destination, targetMiles, radiusMiles = 12 } = {}) {
  const res = await base44.functions.invoke('truckStopSearch', {
    origin, destination, target_miles: targetMiles, radius_miles: radiusMiles,
  });
  return res?.data || res;
}

// Ranking, per product spec — in priority order:
//   1. proximity to the route (off_route_mi)          — primary sort key
//   2. closeness to the required HOS stop point        — tiebreaker
//   3. minimal detour                                   — hard bound via maxDetourMiles
//   4. truck suitability (named chain / hgv tag / etc.) — tiebreaker
//   5/6. parking / fuel availability, if the source has the tag           — folds into suitability
// A POI requiring a large backtrack is never preferred just for being a
// familiar/preferred chain — maxDetourMiles is only relaxed when NOTHING
// found fits within it (better to show a farther real option than none).
export function rankTruckStops(pois, { maxDetourMiles = 5 } = {}) {
  if (!Array.isArray(pois)) return [];
  const scored = pois.map((p) => ({
    ...p,
    suitabilityScore: (p.is_named_truck_stop ? 2 : 0) + (p.has_fuel ? 1 : 0) + (p.has_parking_tag ? 1 : 0),
  }));
  const withinDetour = scored.filter((p) => (p.off_route_mi ?? Infinity) <= maxDetourMiles);
  const pool = withinDetour.length ? withinDetour : scored;
  return [...pool].sort((a, b) =>
    (a.off_route_mi ?? Infinity) - (b.off_route_mi ?? Infinity) ||
    (a.distance_from_stop_mi ?? Infinity) - (b.distance_from_stop_mi ?? Infinity) ||
    (b.suitabilityScore - a.suitabilityScore)
  );
}

// Whether a given real truck stop is a practical fit for each stop purpose.
// A bare fuel pump island with no truck parking is a poor fit for an
// overnight rest even if it happens to be the closest thing to the road.
export function classifyFit(poi) {
  const isFullStop = !!(poi?.is_named_truck_stop || (poi?.has_fuel && poi?.has_parking_tag));
  return {
    thirtyMinBreak: true, // any real fuel/service-area POI works for a short break
    fuelPlusBreak: !!poi?.has_fuel,
    tenHourRest: isFullStop,
  };
}

// Picks the 2-3 options worth showing for a given HOS stop type. For an
// overnight rest/restart, full-service truck stops (real parking, per OSM
// tags) are prioritized ahead of a fuel-only stop even if slightly farther,
// since a small fuel-only pump island is a poor overnight fit — but ranking
// order (route proximity first) is preserved within each group, so this
// never reaches past a bounded detour just to prefer a chain.
export function pickTopStopsForType(rankedPois, stopType, count = 3) {
  if (!Array.isArray(rankedPois) || !rankedPois.length) return [];
  if (stopType !== 'rest' && stopType !== 'restart') return rankedPois.slice(0, count);
  const full = rankedPois.filter((p) => classifyFit(p).tenHourRest);
  const rest = rankedPois.filter((p) => !classifyFit(p).tenHourRest);
  return [...full, ...rest].slice(0, count);
}

// Pure helper: builds a Planned Stops entry from a specific, real truck stop
// the driver picked — never a fabricated location. Distinct from the
// existing generic "Add" (mileage-only) path in Trip.jsx, which stays
// available for when the driver doesn't want a specific chain.
export function buildPlannedStopFromTruckStop(hosStop, poi, addType) {
  const name = poi?.name || 'Truck stop';
  const detour = Number.isFinite(poi?.off_route_mi) ? ` (~${poi.off_route_mi.toFixed(1)} mi off route)` : '';
  const cityState = [poi?.city, poi?.state].filter(Boolean).join(', ');
  return {
    type: addType,
    city: cityState,
    note: `${name}${detour} — ${hosStop?.reason || ''}. Planning suggestion — not yet logged.`,
  };
}
