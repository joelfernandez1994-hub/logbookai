// ============================================================================
// LogbookAI — Trip Planner HOS-stop reliability REGRESSION tests.
// Guards the exact failure this fix addresses: a zero remaining clock used to
// be sent to the complianceStop API as max_drive_miles: 0 (guaranteed HTTP
// 400), and historical "verified through" clocks could drive stop suggestions
// as if they were current driving eligibility.
//
//   1. zero available miles  -> handled locally, no API request
//   2. negative mileage      -> blocked before the request / rejected by the boundary
//   3. expired 14-hour window-> rest required before departure, no mileage claimed
//   4. trailing unrecorded interval -> undetermined, hidden until opt-in
//   5. request validation for missing/zero/negative/positive distances
//   6. multi-stop route      -> chronological, canonical HOS outputs after each rest
//
// The canonical engine (hosEngine.js) is never re-tested or re-implemented here.
// ============================================================================
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

import {
  TRIP_HOS_STATE, PLAN_BASIS,
  resolveTripHosState, resolvePlanBasis, departureRestRequirement,
  resolveStopLookupMiles, buildStopLookupRequest, planTripStopsGuarded,
} from './tripStopPlanning';
import { planTripStops, planningMph, FRESH_TRIP_HOS_BASIS } from './complianceStop';
import { validateMaxDriveMiles } from './stopRequest';
import tripSource from '../pages/Trip.jsx?raw';

// The backend files are read as text only (frontend code cannot import from
// base44/) so the API boundary's own validation stays covered by a test.
const backendEntrySource = readFileSync(new URL('../../base44/functions/complianceStop/entry.ts', import.meta.url), 'utf8');
const backendSharedSource = readFileSync(new URL('../../base44/shared/stopRequest.ts', import.meta.url), 'utf8');

const H = 3600000;

function makeHos({ breakH = 8, driveH = 11, windowH = 14, cycleH = 45 } = {}) {
  return {
    break30: { remainingBeforeBreakMs: breakH * H, drivingAccumulatedMs: (8 - breakH) * H, breakRequired: breakH <= 0 },
    driving: { drivingRemainingMs: driveH * H },
    window14: { remainingMs: windowH * H },
    cycle: { cycleRemainingHours: cycleH },
    availability: { status: 'verified' },
  };
}

describe('1. zero available miles is handled locally — no complianceStop request', () => {
  it('resolveStopLookupMiles refuses a zero remaining clock instead of returning 0 miles', () => {
    const result = resolveStopLookupMiles(makeHos({ driveH: 0 }), '55');
    expect(result.ok).toBe(false);
    expect(result.miles).toBe(0);
    expect(result.error).toBe('no_drive_distance');
  });

  it('buildStopLookupRequest produces no payload for zero miles, so no invoke can happen', () => {
    const request = buildStopLookupRequest({ origin: 'Homestead, FL', destination: 'Houston, TX', miles: 0 });
    expect(request.ok).toBe(false);
    expect(request).not.toHaveProperty('payload');
    expect(request.error).toBe('no_drive_distance');
  });

  it('Trip.jsx never sends a raw max_drive_miles: it invokes only with a validated payload', () => {
    expect(tripSource).not.toContain('max_drive_miles:');
    expect(tripSource).toContain('buildStopLookupRequest');
    expect(tripSource).toContain('if (!request.ok)');
    expect(tripSource).toContain("invoke('complianceStop', request.payload)");
    expect(tripSource).toContain('noDriveDistance');
  });

  it('the backend boundary rejects max_drive_miles: 0 and uses the shared rule', () => {
    expect(validateMaxDriveMiles(0).ok).toBe(false);
    expect(backendEntrySource).toContain("from '../../shared/stopRequest.ts'");
    expect(backendEntrySource).toContain('validateMaxDriveMiles(body.max_drive_miles)');
    expect(backendSharedSource).toContain('miles <= 0');
  });
});

describe('2. negative mileage never reaches the API', () => {
  it('the request builder refuses a negative distance', () => {
    const request = buildStopLookupRequest({ origin: 'Atlanta, GA', destination: 'Dallas, TX', miles: -12 });
    expect(request.ok).toBe(false);
    expect(request.error).toBe('invalid_miles');
    expect(request).not.toHaveProperty('payload');
  });

  it('the boundary rule rejects negatives and non-numbers', () => {
    expect(validateMaxDriveMiles(-1).ok).toBe(false);
    expect(validateMaxDriveMiles(NaN).ok).toBe(false);
  });

  it('a negative limiting clock clamps to zero rather than a negative distance', () => {
    const result = resolveStopLookupMiles(makeHos({ driveH: -3 }), '55');
    expect(result.ok).toBe(false);
    expect(result.miles).toBe(0);
  });
});

describe('3. an expired 14-hour window requires rest before departure', () => {
  it('reports the 14-hour window as the reason and 10 hours of rest as the reset', () => {
    const departure = departureRestRequirement(makeHos({ windowH: 0, driveH: 3 }));
    expect(departure.required).toBe(true);
    expect(departure.reasons).toContain('window14');
    expect(departure.hours).toBe(10);
  });

  it('claims no positive driving mileage before that rest — no stops at all', () => {
    const plan = planTripStopsGuarded({
      hos: makeHos({ windowH: 0, driveH: 3 }), profileId: '55', cycleType: '70_8', totalMiles: 1220,
    });
    expect(plan.stops).toEqual([]);
    expect(plan.departureRest.required).toBe(true);
  });

  it('an exhausted cycle requires the 34-hour restart instead (reset rules, not a flat 10h)', () => {
    const departure = departureRestRequirement(makeHos({ cycleH: 0 }));
    expect(departure.required).toBe(true);
    expect(departure.reasons).toContain('cycle');
    expect(departure.hours).toBe(34);
  });

  it('a fresh, fully-rested day needs no rest before departure', () => {
    expect(departureRestRequirement(FRESH_TRIP_HOS_BASIS).required).toBe(false);
  });
});

describe('4. a trailing unrecorded interval makes availability undetermined', () => {
  const lastVerifiedAt = new Date('2026-11-04T10:00:00Z');
  const undeterminedAvailability = { undetermined: true, unavailable: false, lastVerifiedAt };
  const historicalHos = { ...makeHos({ driveH: 4, windowH: 6 }), availability: { status: 'verified_through', lastVerifiedAt } };

  it('reports verified_through and exposes the verified-through timestamp', () => {
    const state = resolveTripHosState(undeterminedAvailability, historicalHos);
    expect(state.state).toBe(TRIP_HOS_STATE.VERIFIED_THROUGH);
    expect(state.lastVerifiedAt).toEqual(lastVerifiedAt);
  });

  it('shows no reachable recommendations until the driver explicitly opts in', () => {
    const state = resolveTripHosState(undeterminedAvailability, historicalHos).state;
    expect(resolvePlanBasis(state, false)).toBe(PLAN_BASIS.HIDDEN);
  });

  it('any plan produced after opt-in is marked hypothetical, never current eligibility', () => {
    const state = resolveTripHosState(undeterminedAvailability, historicalHos).state;
    expect(resolvePlanBasis(state, true)).toBe(PLAN_BASIS.HYPOTHETICAL);
    // The hypothetical basis is a fresh day, never the historical balances.
    expect(FRESH_TRIP_HOS_BASIS.driving.drivingRemainingMs).toBe(11 * H);
  });

  it('verified-now is the only state that may state current eligibility', () => {
    expect(resolvePlanBasis(TRIP_HOS_STATE.VERIFIED_NOW, false)).toBe(PLAN_BASIS.VERIFIED_NOW);
    expect(resolveTripHosState({ unavailable: false, undetermined: false }, makeHos()).state).toBe(TRIP_HOS_STATE.VERIFIED_NOW);
  });

  it('an invalid timeline is unavailable and likewise hidden without opt-in', () => {
    const state = resolveTripHosState({ unavailable: true }, makeHos()).state;
    expect(state).toBe(TRIP_HOS_STATE.UNAVAILABLE);
    expect(resolvePlanBasis(state, false)).toBe(PLAN_BASIS.HIDDEN);
  });

  it('Trip.jsx gates suggestions on the resolved state and requires the opt-in flag', () => {
    expect(tripSource).toContain('resolveTripHosState');
    expect(tripSource).toContain('resolvePlanBasis');
    expect(tripSource).toContain('hypotheticalOptIn');
    expect(tripSource).toContain('currentVerified && autoAssist');
  });
});

describe('5. complianceStop request validation', () => {
  it('rejects a missing distance', () => {
    expect(validateMaxDriveMiles(undefined).ok).toBe(false);
    expect(validateMaxDriveMiles(null).ok).toBe(false);
    expect(validateMaxDriveMiles('').ok).toBe(false);
  });

  it('rejects zero and negative distances', () => {
    expect(validateMaxDriveMiles(0).ok).toBe(false);
    expect(validateMaxDriveMiles(-5).ok).toBe(false);
    expect(validateMaxDriveMiles('-5').ok).toBe(false);
  });

  it('rejects a non-numeric distance', () => {
    expect(validateMaxDriveMiles('far').ok).toBe(false);
  });

  it('accepts a positive distance unchanged', () => {
    const check = validateMaxDriveMiles(340);
    expect(check.ok).toBe(true);
    expect(check.miles).toBe(340);
    const request = buildStopLookupRequest({ origin: 'Macon, GA', destination: 'Mobile, AL', miles: 340 });
    expect(request.ok).toBe(true);
    expect(request.payload).toEqual({ origin: 'Macon, GA', destination: 'Mobile, AL', max_drive_miles: 340 });
  });

  it('route context stays available when the distance is unusable', () => {
    const request = buildStopLookupRequest({ origin: 'Macon, GA', destination: 'Mobile, AL', miles: 0 });
    expect(request.ok).toBe(false);
    // the caller still has the route it asked about — only the stop is unresolved
    expect(request.error).toBe('no_drive_distance');
  });

  it('a lookup failure never clears the route estimate (route card stays usable)', () => {
    expect(tripSource).not.toContain('setEstimate(null)');
    expect(tripSource).toContain('stopLookupUnavailable');
    expect(tripSource).toContain('retryLocations');
  });
});

describe('6. multi-stop routes stay chronological and use canonical HOS outputs', () => {
  it('matches the canonical planTripStops() output for a verified basis (no re-implementation)', () => {
    const hos = makeHos({ driveH: 6, windowH: 9, cycleH: 45 });
    const guarded = planTripStopsGuarded({ hos, profileId: '55', cycleType: '70_8', totalMiles: 1500 });
    const canonical = planTripStops({ hos, profileId: '55', cycleType: '70_8', totalMiles: 1500 });
    expect(guarded.stops.map((s) => `${s.type}@${Math.round(s.mile)}`))
      .toEqual(canonical.map((s) => `${s.type}@${Math.round(s.mile)}`));
    for (const stop of guarded.stops) expect(stop.mile).toBeGreaterThan(0);
  });

  it('places the first stop at the 11-hour driving limit, then measures the next stop from the reset clocks', () => {
    const mph = planningMph('55');
    const hos = makeHos({ driveH: 6, windowH: 9, cycleH: 45 });
    const { stops } = planTripStopsGuarded({ hos, profileId: '55', cycleType: '70_8', totalMiles: 1500 });

    expect(stops[0].type).toBe('rest');
    expect(stops[0].mile).toBeCloseTo(6 * mph, 1); // exactly the remaining drive clock
    // After that qualifying rest, the break budget is the canonical 8 hours —
    // the following stop distance comes from the post-rest clocks, not a guess.
    expect(stops[1].type).toBe('break');
    expect(stops[1].mile - stops[0].mile).toBeCloseTo(8 * mph, 1);
  });

  it('stops are strictly increasing and all fall before the destination', () => {
    const totalMiles = 1220;
    const { stops } = planTripStopsGuarded({ hos: FRESH_TRIP_HOS_BASIS, profileId: '55', cycleType: '70_8', totalMiles });
    expect(stops.length).toBeGreaterThan(0);
    for (let i = 1; i < stops.length; i++) expect(stops[i].mile).toBeGreaterThan(stops[i - 1].mile);
    for (const stop of stops) expect(stop.mile).toBeLessThan(totalMiles);
  });

  it('every planned stop yields a request the API would accept', () => {
    const { stops } = planTripStopsGuarded({ hos: FRESH_TRIP_HOS_BASIS, profileId: '55', cycleType: '70_8', totalMiles: 1220 });
    for (const stop of stops) {
      const request = buildStopLookupRequest({ origin: 'Homestead, FL', destination: 'Houston, TX', miles: stop.mile });
      expect(request.ok).toBe(true);
      expect(request.payload.max_drive_miles).toBeGreaterThan(0);
    }
  });

  it('this boundary reuses the canonical planner instead of re-deriving HOS rules', () => {
    expect(tripSource).toContain('planTripStopsGuarded');
    expect(tripSource).not.toContain('planTripStops({');
  });
});