// ============================================================================
// LogbookAI — truck-stop discovery regression tests.
// Guards the exact constraints from the product spec:
//   - break/rest points come from HOS (not re-tested here, see
//     complianceStop.test.js) and truck-stop options are route-derived
//   - recommended stops are actually near the route (ranking/detour bound)
//   - detour is bounded/reasonable — a big backtrack is never preferred
//     just because a POI is a familiar/preferred chain
//   - no fake parking/fuel data is invented — only real tags are surfaced,
//     and classifyFit never claims a live availability number
//   - a driver can turn a specific recommendation into a Planned Stop
//   - Trip.jsx never talks to Trucker Path or any POI API directly (see
//     the modularity check in parkingProvider.test.js for the Trucker Path
//     half of this — this file covers the truck-stop-discovery half)
// ============================================================================
import { describe, it, expect, vi } from 'vitest';

// truckStopProvider.js imports base44 (for findTruckStopsNearStop's network
// call) at module scope; the pure ranking/classification functions under
// test here never touch it, but the import graph still needs a stand-in
// under vitest's node environment (base44Client reads `window` at import
// time) — same pattern as tripSync.test.js.
vi.mock('@/api/base44Client', () => ({ base44: { functions: { invoke: vi.fn() } } }));

import { rankTruckStops, classifyFit, pickTopStopsForType, buildPlannedStopFromTruckStop } from './truckStopProvider';
import tripSource from '../pages/Trip.jsx?raw';

const loves = { name: "Love's Travel Stop", lat: 30.29, lng: -82.98, has_fuel: true, has_parking_tag: true, is_named_truck_stop: true, off_route_mi: 1.2, distance_from_stop_mi: 0.5 };
const pilot = { name: 'Pilot Travel Center', lat: 30.30, lng: -82.99, has_fuel: true, has_parking_tag: true, is_named_truck_stop: true, off_route_mi: 2.0, distance_from_stop_mi: 1.1 };
const smallPump = { name: 'Joe’s Gas', lat: 30.31, lng: -83.0, has_fuel: true, has_parking_tag: false, is_named_truck_stop: false, off_route_mi: 0.3, distance_from_stop_mi: 0.2 };
const farBackTrack = { name: 'Remote Fuel Depot', lat: 31.0, lng: -83.5, has_fuel: true, has_parking_tag: true, is_named_truck_stop: true, off_route_mi: 40, distance_from_stop_mi: 39 };

describe('rankTruckStops — proximity/detour ranking', () => {
  it('ranks closer-to-route options first (route proximity is the primary key)', () => {
    const ranked = rankTruckStops([pilot, loves, smallPump]);
    expect(ranked[0]).toBe(smallPump); // 0.3 mi off route, closest
    expect(ranked[1]).toBe(loves); // 1.2 mi
    expect(ranked[2]).toBe(pilot); // 2.0 mi
  });

  it('bounds detour: excludes a big-backtrack POI when reasonable options exist', () => {
    const ranked = rankTruckStops([loves, pilot, farBackTrack], { maxDetourMiles: 5 });
    expect(ranked.map((p) => p.name)).not.toContain('Remote Fuel Depot');
  });

  it('never prefers a big-backtrack chain over a closer option just for being a named truck stop', () => {
    // farBackTrack is a "better" named truck stop than smallPump, but 40 mi
    // off route — must not be ranked ahead of a real, close-by option.
    const ranked = rankTruckStops([farBackTrack, smallPump], { maxDetourMiles: 5 });
    expect(ranked[0]).toBe(smallPump);
  });

  it('only relaxes the detour bound when NOTHING fits within it (never silently drops all options)', () => {
    const ranked = rankTruckStops([farBackTrack], { maxDetourMiles: 5 });
    expect(ranked.length).toBe(1);
    expect(ranked[0].name).toBe('Remote Fuel Depot');
  });

  it('handles missing/malformed input without throwing', () => {
    expect(rankTruckStops(null)).toEqual([]);
    expect(rankTruckStops(undefined)).toEqual([]);
    expect(rankTruckStops([])).toEqual([]);
  });
});

describe('classifyFit — never invents live availability', () => {
  it('a full-service named truck stop is a good fit for an overnight rest', () => {
    expect(classifyFit(loves).tenHourRest).toBe(true);
    expect(classifyFit(loves).fuelPlusBreak).toBe(true);
  });

  it('a bare fuel pump with no parking tag is NOT a good fit for an overnight rest', () => {
    expect(classifyFit(smallPump).tenHourRest).toBe(false);
    expect(classifyFit(smallPump).fuelPlusBreak).toBe(true); // still fine for a quick break
  });

  it('any real POI is treated as fine for a 30-minute break', () => {
    expect(classifyFit(smallPump).thirtyMinBreak).toBe(true);
    expect(classifyFit(loves).thirtyMinBreak).toBe(true);
  });

  it('never returns a numeric/live parking-count field — only a boolean fit judgment from real tags', () => {
    const fit = classifyFit(loves);
    expect(fit).not.toHaveProperty('parkingSpacesAvailable');
    expect(fit).not.toHaveProperty('liveParkingCount');
    expect(Object.values(fit).every((v) => typeof v === 'boolean')).toBe(true);
  });
});

describe('pickTopStopsForType — overnight rest prioritizes full-service stops', () => {
  it('for a 10-hour rest, puts full-service stops ahead of a closer fuel-only pump', () => {
    const ranked = rankTruckStops([smallPump, loves, pilot]); // smallPump ranks #1 by proximity alone
    const picked = pickTopStopsForType(ranked, 'rest', 3);
    expect(picked[0].name).not.toBe('Joe’s Gas');
    expect(classifyFit(picked[0]).tenHourRest).toBe(true);
  });

  it('for a 30-minute break, keeps pure route-proximity order (no overnight-suitability reshuffle)', () => {
    const ranked = rankTruckStops([smallPump, loves, pilot]);
    const picked = pickTopStopsForType(ranked, 'break', 3);
    expect(picked[0]).toBe(ranked[0]);
  });

  it('caps the result at the requested count', () => {
    const ranked = rankTruckStops([smallPump, loves, pilot, farBackTrack], { maxDetourMiles: 100 });
    expect(pickTopStopsForType(ranked, 'break', 2).length).toBe(2);
  });

  it('handles an empty list without throwing', () => {
    expect(pickTopStopsForType([], 'rest', 3)).toEqual([]);
  });
});

describe('buildPlannedStopFromTruckStop — a recommendation becomes a real Planned Stop', () => {
  it('builds a planned-stop entry naming the actual chosen truck stop, never a placeholder', () => {
    const hosStop = { type: 'rest', mile: 210, reason: '11-hour driving limit' };
    const entry = buildPlannedStopFromTruckStop(hosStop, loves, 'rest');
    expect(entry.type).toBe('rest');
    expect(entry.note).toContain("Love's Travel Stop");
    expect(entry.note).toContain('1.2 mi off route');
    expect(entry.note).toContain('11-hour driving limit');
    expect(entry.note).toContain('not yet logged'); // planning-only, never implies an official RODS entry
  });

  it('never fabricates a city/state when the POI has none', () => {
    const hosStop = { type: 'break', mile: 100, reason: '8-hour cumulative driving threshold' };
    const entry = buildPlannedStopFromTruckStop(hosStop, { ...loves, city: null, state: null }, 'break');
    expect(entry.city).toBe('');
  });
});

describe('modularity — Trip.jsx never talks to a truck-stop/POI data source directly', () => {
  it('Trip.jsx only reaches truck-stop discovery through truckStopProvider.js', () => {
    expect(tripSource).toContain("from '@/lib/truckStopProvider'");
    expect(tripSource).not.toContain('overpass-api.de');
    expect(tripSource).not.toContain('nominatim');
  });
});
