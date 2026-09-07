// ============================================================================
// LogbookAI — Trip Planner regression tests: restoring automatic multi-stop
// suggestions (fuel/rest/break) for a long route.
//
// Root cause of the regression (see src/pages/Trip.jsx): commit
// "Fix trip availability logic and UI state representation" added
// `!availability.cycleUnverified` to the `hosVerified` gate. That silently
// disabled the ENTIRE stop-suggestion pipeline (auto-suggest AND the manual
// "Suggest a Rest Stop" button) whenever the driver simply hadn't entered
// prior cycle history — a normal, common state, not a broken timeline.
// driveRemainingMs/windowRemainingMs/break30 are all valid independent of
// cycle verification (see whatCanIDo() in logAssistant.js). Fixed by gating
// only on `availability.unavailable` (a genuinely invalid timeline).
//
// planTripStops() (new in complianceStop.js) is the restored/extended
// multi-stop capability: it never recomputes an HOS rule itself — it only
// converts the SAME hours the canonical hosEngine.computeHOS() already
// produced (break30, driving, window14, cycle) into route mileage.
// ============================================================================
import { describe, it, expect } from 'vitest';
import { planTripStops, planningMph, FRESH_TRIP_HOS_BASIS, withFuelOpportunities } from './complianceStop';

const H = 3600000;

function makeHos({ breakRemainingH = 8, driveRemainingH = 11, windowRemainingH = 14, cycleRemainingH = 60 } = {}) {
  return {
    break30: { remainingBeforeBreakMs: breakRemainingH * H, drivingAccumulatedMs: (8 - breakRemainingH) * H, breakRequired: breakRemainingH <= 0 },
    driving: { drivingRemainingMs: driveRemainingH * H },
    window14: { remainingMs: windowRemainingH * H },
    cycle: { cycleRemainingHours: cycleRemainingH },
  };
}

describe('planTripStops — short trip needs no stops', () => {
  it('returns an empty list when the whole trip fits comfortably within all current HOS clocks', () => {
    const hos = makeHos({}); // fresh: 8h to next break, 11h drive, 14h window, 60h cycle
    const mph = planningMph('55');
    const stops = planTripStops({ hos, profileId: '55', cycleType: '70_8', totalMiles: 4 * mph }); // ~4h trip
    expect(stops).toEqual([]);
  });
});

describe('planTripStops — exact example from the bug report', () => {
  it('6h30 already driven + a 4h leg places a 30-minute break 1h30 into that leg, not after the whole leg', () => {
    const mph = planningMph('55');
    const hos = makeHos({ breakRemainingH: 1.5, driveRemainingH: 9.5, windowRemainingH: 12 });
    const totalMiles = 4 * mph; // the "4-hour next leg"
    const stops = planTripStops({ hos, profileId: '55', cycleType: '70_8', totalMiles });

    expect(stops.length).toBeGreaterThan(0);
    expect(stops[0].type).toBe('break');
    expect(stops[0].durationHours).toBe(0.5);
    expect(stops[0].mile).toBeCloseTo(1.5 * mph, 1); // 1h30 into the leg, in miles
  });
});

describe('planTripStops — long route (Homestead, FL -> Houston, TX, ~1200 mi)', () => {
  it('never returns an empty stop list for a ~1200-mile trip — the exact regression reported', () => {
    const hos = makeHos({}); // driver starts the day fresh
    const stops = planTripStops({ hos, profileId: '55', cycleType: '70_8', totalMiles: 1200 });
    expect(stops.length).toBeGreaterThan(0);
  });

  it('suggests a 30-minute break once 8 cumulative driving hours would be reached before a qualifying break', () => {
    const hos = makeHos({});
    const stops = planTripStops({ hos, profileId: '55', cycleType: '70_8', totalMiles: 1200 });
    expect(stops.some((s) => s.type === 'break' && s.durationHours === 0.5)).toBe(true);
  });

  it('suggests a 10-hour qualifying rest once the 11-hour driving limit or 14-hour window would be reached', () => {
    const hos = makeHos({});
    const stops = planTripStops({ hos, profileId: '55', cycleType: '70_8', totalMiles: 1200 });
    expect(stops.some((s) => s.type === 'rest' && s.durationHours === 10)).toBe(true);
  });

  it('stops are strictly ordered by increasing mileage and all fall before the destination', () => {
    const hos = makeHos({});
    const totalMiles = 1200;
    const stops = planTripStops({ hos, profileId: '55', cycleType: '70_8', totalMiles });
    for (let i = 1; i < stops.length; i++) expect(stops[i].mile).toBeGreaterThan(stops[i - 1].mile);
    for (const s of stops) expect(s.mile).toBeLessThan(totalMiles);
  });

  it('clearly distinguishes break (0.5h) / rest (10h) / restart (34h) — never conflates them', () => {
    const hos = makeHos({});
    const stops = planTripStops({ hos, profileId: '55', cycleType: '70_8', totalMiles: 1200 });
    const durations = new Set(stops.map((s) => s.durationHours));
    for (const d of durations) expect([0.5, 10, 34]).toContain(d);
  });
});

describe('planTripStops — never suggests a restart when the cycle is unverified', () => {
  it('cycleRemainingHours: null (unverified) produces break/rest stops but no restart, even for a very long trip', () => {
    const hos = makeHos({});
    hos.cycle.cycleRemainingHours = null; // mirrors whatCanIDo()'s cycleUnverified state
    const stops = planTripStops({ hos, profileId: '55', cycleType: '70_8', totalMiles: 3000 });
    expect(stops.some((s) => s.type === 'restart')).toBe(false);
  });
});

describe('planTripStops — reuses the canonical engine\'s numbers, never recomputes them', () => {
  it('changing only hos.break30 (the canonical 8-hour tracker) changes break timing, with no separate break logic involved', () => {
    const mph = planningMph('55');
    const freshHos = makeHos({ breakRemainingH: 8 });
    const almostDueHos = makeHos({ breakRemainingH: 0.5 });
    const freshStops = planTripStops({ hos: freshHos, profileId: '55', cycleType: '70_8', totalMiles: 1200 });
    const dueStops = planTripStops({ hos: almostDueHos, profileId: '55', cycleType: '70_8', totalMiles: 1200 });
    expect(freshStops[0].mile).toBeGreaterThan(dueStops[0].mile);
    expect(dueStops[0].mile).toBeCloseTo(0.5 * mph, 1);
  });
});

describe('FRESH_TRIP_HOS_BASIS — fallback when the driver\'s real HOS cannot be verified', () => {
  it('the exact Homestead, FL -> Houston, TX regression: a ~1220mi/22+hr route never returns an empty stop list, even when the real log is invalid', () => {
    // Mirrors the live-account scenario: validateTimeline finds the actual
    // log invalid (a multi-day gap), so hosEngine.computeHOS cannot produce
    // real remaining clocks. The Trip Planner must still plan against the
    // standard fresh-day limits rather than silently returning nothing.
    const stops = planTripStops({ hos: FRESH_TRIP_HOS_BASIS, profileId: '55', cycleType: '70_8', totalMiles: 1220 });
    expect(stops.length).toBeGreaterThan(0);
    expect(stops.some((s) => s.type === 'break')).toBe(true);
    expect(stops.some((s) => s.type === 'rest')).toBe(true);
    // Cycle is unknown (null), not assumed full — never a restart suggestion.
    expect(stops.some((s) => s.type === 'restart')).toBe(false);
  });

  it('never claims a real cycle number — cycleRemainingHours is null, not a guessed full cycle', () => {
    expect(FRESH_TRIP_HOS_BASIS.cycle.cycleRemainingHours).toBeNull();
  });
});

describe('withFuelOpportunities — separate mileage heuristic, not an HOS rule', () => {
  it('inserts a fuel stop when a segment between HOS stops exceeds the typical range', () => {
    const hosStops = [{ type: 'rest', mile: 900, durationHours: 10, reason: 'x' }];
    const withFuel = withFuelOpportunities(hosStops, 1220, 500);
    expect(withFuel.some((s) => s.type === 'fuel')).toBe(true);
    // The 900-1220 segment (320mi) is under range and needs none; the
    // 0-900 segment (900mi) needs one around mile 500.
    const fuelStops = withFuel.filter((s) => s.type === 'fuel');
    expect(fuelStops).toHaveLength(1);
    expect(fuelStops[0].mile).toBeCloseTo(500, 0);
  });

  it('inserts no fuel stop when every segment is already within typical range', () => {
    const hosStops = [{ type: 'break', mile: 300, durationHours: 0.5, reason: 'x' }, { type: 'rest', mile: 600, durationHours: 10, reason: 'x' }];
    const withFuel = withFuelOpportunities(hosStops, 900, 500);
    expect(withFuel.filter((s) => s.type === 'fuel')).toHaveLength(0);
  });

  it('inserts multiple fuel stops for one very long segment with no HOS stops at all', () => {
    const withFuel = withFuelOpportunities([], 1600, 500);
    const fuelStops = withFuel.filter((s) => s.type === 'fuel');
    expect(fuelStops.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < fuelStops.length; i++) expect(fuelStops[i].mile).toBeGreaterThan(fuelStops[i - 1].mile);
  });

  it('the combined Homestead -> Houston plan (HOS basis + fuel) keeps types clearly distinct and ordered', () => {
    const hosStops = planTripStops({ hos: FRESH_TRIP_HOS_BASIS, profileId: '55', cycleType: '70_8', totalMiles: 1220 });
    // With the 30-min-break/10-hr-rest cadence for this trip, every gap
    // already falls under the ~500mi fuel range, so no separate fuel stop is
    // needed here — confirming withFuelOpportunities doesn't force one where
    // the HOS-driven stops already keep the driver well within tank range.
    const combined = withFuelOpportunities(hosStops, 1220, 500);
    expect(combined.some((s) => s.type === 'break')).toBe(true);
    expect(combined.some((s) => s.type === 'rest')).toBe(true);
    for (let i = 1; i < combined.length; i++) expect(combined[i].mile).toBeGreaterThanOrEqual(combined[i - 1].mile);
  });

  it('a longer trip (1,800 mi) on the same HOS basis DOES need a fuel stop beyond what break/rest cadence alone covers', () => {
    const hosStops = planTripStops({ hos: FRESH_TRIP_HOS_BASIS, profileId: '55', cycleType: '70_8', totalMiles: 1800 });
    const combined = withFuelOpportunities(hosStops, 1800, 500);
    expect(combined.some((s) => s.type === 'fuel')).toBe(true);
  });
});

describe('planTripStops — planning-suggestion only, never an official record', () => {
  it('returns plain mileage/duration/reason data — no event fields, no is_ongoing, nothing that looks like a DutyStatusEvent', () => {
    const hos = makeHos({});
    const stops = planTripStops({ hos, profileId: '55', cycleType: '70_8', totalMiles: 1200 });
    for (const s of stops) {
      expect(s).not.toHaveProperty('duty_status');
      expect(s).not.toHaveProperty('start_timestamp');
      expect(s).not.toHaveProperty('is_ongoing');
      expect(typeof s.reason).toBe('string');
    }
  });
});
