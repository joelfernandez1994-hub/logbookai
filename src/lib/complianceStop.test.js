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
import { planTripStops, planningMph } from './complianceStop';

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
