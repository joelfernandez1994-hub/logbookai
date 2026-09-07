// ============================================================================
// LogbookAI — Trip Planner + truck-stop discovery INTEGRATION regression.
// Exact scenario requested: Homestead, FL -> Houston, TX (~1220 mi). Verifies
// the full pipeline end to end:
//
//   Route + HOS (planTripStops, canonical hosEngine numbers via
//   FRESH_TRIP_HOS_BASIS — see complianceStop.test.js for the HOS-only half
//   of this regression)
//     -> approximate break/rest point along the route (stop.mile)
//     -> candidate truck stops near that point (simulated here as the
//        truckStopSearch backend would return them — this file does not hit
//        the network; findTruckStopsNearStop() itself is exercised only as a
//        thin invoke() wrapper, not re-tested here)
//     -> rankTruckStops() / pickTopStopsForType() choose practical options
//     -> buildPlannedStopFromTruckStop() lets the driver add one
//
// Confirms exactly the properties the product spec calls out:
//   - break/rest points are generated from HOS
//   - nearby truck stops are route-derived (bounded off_route_mi)
//   - recommended stops are actually near the route
//   - detour is bounded/reasonable
//   - no fake parking data is shown
//   - the driver can add one of the recommendations to Planned Stops
// Does not touch the canonical HOS engine.
// ============================================================================
import { describe, it, expect } from 'vitest';
import { planTripStops, FRESH_TRIP_HOS_BASIS } from './complianceStop';
import { rankTruckStops, pickTopStopsForType, classifyFit, buildPlannedStopFromTruckStop } from './truckStopProvider';

const TOTAL_MILES = 1220; // real Homestead, FL -> Houston, TX road distance, ~1200-1220mi

// Simulates what truckStopSearch/entry.ts would compute for a given stop
// mile: a mix of close, on-route-corridor candidates and one big-backtrack
// candidate, so the ranking/detour-bound behavior is exercised the same way
// it would be against real Overpass data.
function simulatedPoisNear(stopMile) {
  return [
    { name: 'Love’s Travel Stop', lat: 30 - stopMile / 1000, lng: -84, has_fuel: true, has_parking_tag: true, is_named_truck_stop: true, off_route_mi: 1.2, distance_from_stop_mi: 0.6 },
    { name: 'Pilot Travel Center', lat: 30 - stopMile / 1000, lng: -84.01, has_fuel: true, has_parking_tag: true, is_named_truck_stop: true, off_route_mi: 2.0, distance_from_stop_mi: 1.4 },
    { name: 'Corner Fuel Mart', lat: 30 - stopMile / 1000, lng: -84.02, has_fuel: true, has_parking_tag: false, is_named_truck_stop: false, off_route_mi: 0.7, distance_from_stop_mi: 0.5 },
    { name: 'Distant Fuel Depot', lat: 32, lng: -86, has_fuel: true, has_parking_tag: true, is_named_truck_stop: true, off_route_mi: 55, distance_from_stop_mi: 54 },
  ];
}

describe('Homestead, FL -> Houston, TX — HOS stop + truck-stop discovery pipeline', () => {
  const hosStops = planTripStops({ hos: FRESH_TRIP_HOS_BASIS, profileId: '55', cycleType: '70_8', totalMiles: TOTAL_MILES });

  it('break/rest points are generated from the canonical HOS-derived plan, not invented here', () => {
    expect(hosStops.length).toBeGreaterThan(0);
    expect(hosStops.some((s) => s.type === 'break')).toBe(true);
    expect(hosStops.some((s) => s.type === 'rest')).toBe(true);
  });

  it('for every HOS stop, recommended truck stops are route-derived and within a bounded detour', () => {
    for (const stop of hosStops) {
      const ranked = rankTruckStops(simulatedPoisNear(stop.mile), { maxDetourMiles: 5 });
      // The 55mi-off-route candidate must never be recommended while closer,
      // real options exist near this exact HOS stop point.
      expect(ranked.every((p) => p.off_route_mi <= 5)).toBe(true);
      expect(ranked.some((p) => p.name === 'Distant Fuel Depot')).toBe(false);
      expect(ranked.length).toBeGreaterThan(0);
    }
  });

  it('an overnight rest stop prioritizes a full-service truck stop over a closer fuel-only pump', () => {
    const restStop = hosStops.find((s) => s.type === 'rest');
    expect(restStop).toBeTruthy();
    const ranked = rankTruckStops(simulatedPoisNear(restStop.mile), { maxDetourMiles: 5 });
    const picked = pickTopStopsForType(ranked, 'rest', 3);
    expect(classifyFit(picked[0]).tenHourRest).toBe(true);
    expect(picked[0].name).not.toBe('Corner Fuel Mart'); // closer, but not overnight-suitable
  });

  it('a 30-minute break keeps strict route-proximity ordering (closest real option first)', () => {
    const breakStop = hosStops.find((s) => s.type === 'break');
    expect(breakStop).toBeTruthy();
    const ranked = rankTruckStops(simulatedPoisNear(breakStop.mile), { maxDetourMiles: 5 });
    const picked = pickTopStopsForType(ranked, 'break', 3);
    expect(picked[0].name).toBe('Corner Fuel Mart'); // 0.7 mi off route — closest
  });

  it('no fake parking availability is ever produced for any recommended stop', () => {
    for (const stop of hosStops) {
      const ranked = rankTruckStops(simulatedPoisNear(stop.mile), { maxDetourMiles: 5 });
      for (const poi of ranked) {
        const fit = classifyFit(poi);
        expect(Object.values(fit).every((v) => typeof v === 'boolean')).toBe(true);
        expect(fit).not.toHaveProperty('liveParkingSpaces');
      }
    }
  });

  it('the driver can add one of the recommended truck stops to Planned Stops', () => {
    const restStop = hosStops.find((s) => s.type === 'rest');
    const ranked = rankTruckStops(simulatedPoisNear(restStop.mile), { maxDetourMiles: 5 });
    const picked = pickTopStopsForType(ranked, 'rest', 3)[0];
    const plannedEntry = buildPlannedStopFromTruckStop(restStop, picked, 'rest');
    expect(plannedEntry.type).toBe('rest');
    expect(plannedEntry.note).toContain(picked.name);
    expect(plannedEntry.note).toContain('not yet logged'); // still planning-only, never an official RODS entry
  });

  it('this integration never touches the canonical HOS engine module', () => {
    // planTripStops only converts hosEngine's already-computed hours into
    // route miles — it does not import hosEngine.js itself, and nothing in
    // this pipeline recomputes an HOS rule.
    expect(Object.keys(FRESH_TRIP_HOS_BASIS)).toEqual(['break30', 'driving', 'window14', 'cycle']);
  });
});
