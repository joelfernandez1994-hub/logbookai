// ============================================================================
// LogbookAI — Split-Sleeper HOS Regression (vitest)
// ----------------------------------------------------------------------------
// Deterministic behavioral assertions for FMCSA §395.1(g) split-sleeper as an
// OPTIONAL optimization (never a warning / never a driving blocker on its own).
// Pairs with hosEngine.split.test.js, which asserts exact numeric values for
// the 9 canonical scenarios. Run: npx vitest run src/lib/hosEngine.split.regression.test.js
//
// Authoritative source: FMCSA 49 CFR §395 HOS rules and §395.1(g) split-sleeper.
// ============================================================================
import { describe, it, expect } from 'vitest';
import { computeHOS } from './hosEngine';
import { whatCanIDo } from './logAssistant';

const NOW = new Date('2026-08-19T12:00:00Z');
const H = 3600000;
const round = (n) => Math.round(n * 100) / 100;

// startAgoH/endAgoH are hours BEFORE NOW.
function ev(startAgoH, endAgoH, status, extra = {}) {
  return {
    log_date: new Date(NOW - startAgoH * H).toISOString().slice(0, 10),
    start_timestamp: new Date(NOW - startAgoH * H).toISOString(),
    end_timestamp: new Date(NOW - endAgoH * H).toISOString(),
    duty_status: status,
    ...extra,
  };
}

describe('Split-sleeper is optional (FMCSA §395.1(g))', () => {
  it('7 Sleeper + 3 Off is a valid active split (no violation)', () => {
    const events = [
      ev(20, 13, 'SLEEPER_BERTH'), // 7h
      ev(13, 10, 'DRIVING'),
      ev(10, 7, 'OFF_DUTY'),      // 3h
      ev(7, 0, 'DRIVING'),
    ];
    const hos = computeHOS(events, '70_8', 'UTC', NOW, { historyComplete: true });
    expect(hos.split.status).toBe('active');
    expect(hos.split.firstPeriod.status).toBe('SLEEPER_BERTH');
    expect(hos.split.secondPeriod.status).toBe('OFF_DUTY');
    const viols = hos.split.clocks?.violations || [];
    expect(viols.filter(v => v.rule === '11-Hour Driving Limit')).toHaveLength(0);
    expect(viols.filter(v => v.rule === '14-Hour Driving Window')).toHaveLength(0);
  });

  it('8 Sleeper + 2 Off is a valid active split', () => {
    const events = [
      ev(19, 11, 'SLEEPER_BERTH'), // 8h
      ev(11, 6, 'DRIVING'),
      ev(6, 4, 'OFF_DUTY'),        // 2h
      ev(4, 0, 'DRIVING'),
    ];
    const hos = computeHOS(events, '70_8', 'UTC', NOW, { historyComplete: true });
    expect(hos.split.status).toBe('active');
    expect(round(hos.split.firstPeriod.duration / H)).toBe(8);
    expect(round(hos.split.secondPeriod.duration / H)).toBe(2);
  });

  it('7 Sleeper + 3 Sleeper is a valid active split', () => {
    const events = [
      ev(18, 11, 'SLEEPER_BERTH'), // 7h
      ev(11, 7, 'DRIVING'),
      ev(7, 4, 'SLEEPER_BERTH'),  // 3h
      ev(4, 0, 'DRIVING'),
    ];
    const hos = computeHOS(events, '70_8', 'UTC', NOW, { historyComplete: true });
    expect(hos.split.status).toBe('active');
    expect(hos.split.firstPeriod.status).toBe('SLEEPER_BERTH');
    expect(hos.split.secondPeriod.status).toBe('SLEEPER_BERTH');
  });

  it('7h35m qualifying period ALONE is NOT a violation (informational only)', () => {
    const events = [
      ev(20, 10, 'OFF_DUTY'),                 // 10h full reset
      ev(10, 9, 'DRIVING'),                  // 1h
      ev(9, 1 + 25 / 60, 'SLEEPER_BERTH'),   // 7h35m qualifying first period
      ev(1 + 25 / 60, 0, 'DRIVING'),         // 1h25m
    ];
    const hos = computeHOS(events, '70_8', 'UTC', NOW, { historyComplete: true });
    expect(hos.split.status).toBe('available');
    expect(hos.driving.applicable).toBe(true);
    expect(hos.driving.drivingRemainingMs).toBeGreaterThan(0);
    expect(hos.window14.applicable).toBe(true);
    expect(hos.window14.remainingMs).toBeGreaterThan(0);
  });

  it('7h35m + 2h25m qualifying rest is a valid pair (active)', () => {
    const events = [
      ev(20, 12 + 25 / 60, 'SLEEPER_BERTH'),   // 7h35m
      ev(12 + 25 / 60, 3 + 25 / 60, 'DRIVING'),// 9h
      ev(3 + 25 / 60, 1, 'OFF_DUTY'),          // 2h25m
      ev(1, 0, 'DRIVING'),                     // 1h
    ];
    const hos = computeHOS(events, '70_8', 'UTC', NOW, { historyComplete: true });
    expect(hos.split.status).toBe('active');
    expect(round(hos.split.firstPeriod.duration / H)).toBeCloseTo(7 + 35 / 60, 2);
    expect(round(hos.split.secondPeriod.duration / H)).toBeCloseTo(2 + 25 / 60, 2);
  });

  it('A qualifying first period does NOT force the driver to complete a split', () => {
    const events = [
      ev(20, 10, 'OFF_DUTY'),
      ev(10, 9, 'DRIVING'),
      ev(9, 1 + 25 / 60, 'SLEEPER_BERTH'),
      ev(1 + 25 / 60, 0, 'DRIVING'),
    ];
    const w = whatCanIDo(events, '70_8', 'UTC', NOW);
    expect(w.canDrive).toBe(true);
    // The incomplete split is informational, never a blocker:
    expect(w.driveBlockers.find(b => /split/i.test(b.rule))).toBeUndefined();
  });

  it('Split recalculates the 11-hour driving limit from the first qualifying period', () => {
    const events = [
      ev(20, 13, 'SLEEPER_BERTH'), // 7h  (first period)
      ev(13, 10, 'DRIVING'),       // 3h
      ev(10, 7, 'OFF_DUTY'),       // 3h  (second period)
      ev(7, 0, 'DRIVING'),         // 7h  -> drive since ref = 10h
    ];
    const hos = computeHOS(events, '70_8', 'UTC', NOW, { historyComplete: true });
    expect(hos.split.status).toBe('active');
    expect(hos.driving.referenceType).toBe('split');
    expect(round(hos.driving.drivingRemainingMs / H)).toBeCloseTo(1, 1);
  });

  it('Qualifying split periods are excluded from the 14-hour calculation', () => {
    const events = [
      ev(20, 13, 'SLEEPER_BERTH'), // 7h  (first)
      ev(13, 10, 'DRIVING'),       // 3h
      ev(10, 7, 'OFF_DUTY'),       // 3h  (second)
      ev(7, 0, 'DRIVING'),         // 7h
    ];
    const hos = computeHOS(events, '70_8', 'UTC', NOW, { historyComplete: true });
    expect(hos.window14.referenceType).toBe('split');
    // ref = end of first = 13h ago. wallElapsed = 13h. secondDur = 3h.
    // windowCountable = 13 - 3 = 10h -> remaining = 4h.
    expect(round(hos.window14.remainingMs / H)).toBeCloseTo(4, 1);
  });

  it('Split sleeper does NOT reset the 70-hour / 8-day cycle', () => {
    // 10h of driving total; split active. Cycle used = 10h -> remaining = 60h
    // (a reset would have returned 70h — assert it does NOT).
    const events = [
      ev(20, 13, 'SLEEPER_BERTH'),
      ev(13, 7, 'DRIVING'),   // 6h
      ev(7, 4, 'OFF_DUTY'),   // 3h second period
      ev(4, 0, 'DRIVING'),    // 4h
    ];
    const hos = computeHOS(events, '70_8', 'UTC', NOW, { historyComplete: true });
    expect(hos.split.status).toBe('active');
    expect(hos.cycle.cycleRemainingHours).toBeLessThan(70);
    expect(hos.cycle.cycleRemainingHours).toBeGreaterThan(0);
    expect(round(hos.cycle.cycleRemainingHours)).toBe(60);
  });

  it('Engine chooses the most-advantageous valid legal interpretation', () => {
    // Full reset, then a 7+3 split. Unsplit, the 14h window would be closed
    // (0h remaining); with the split it reopens to 8h. The engine must select
    // the split (compliant + more available time).
    const events = [
      ev(27, 17, 'OFF_DUTY'),      // 10h full reset
      ev(17, 16, 'DRIVING'),
      ev(16, 9, 'SLEEPER_BERTH'),  // 7h
      ev(9, 4, 'DRIVING'),
      ev(4, 1, 'OFF_DUTY'),        // 3h
      ev(1, 0, 'DRIVING'),
    ];
    const hos = computeHOS(events, '70_8', 'UTC', NOW, { historyComplete: true });
    expect(hos.split.status).toBe('active');
    expect(hos.window14.referenceType).toBe('split');
    expect(round(hos.window14.remainingMs / H)).toBeCloseTo(8, 1);
  });

  it('Split-sleeper informational state never makes canDrive false by itself', () => {
    const events = [
      ev(20, 10, 'OFF_DUTY'),                 // 10h reset
      ev(10, 9, 'DRIVING'),
      ev(9, 1 + 25 / 60, 'SLEEPER_BERTH'),   // 7h35m qualifying, unpaired
      ev(1 + 25 / 60, 0, 'DRIVING'),
    ];
    const w = whatCanIDo(events, '70_8', 'UTC', NOW);
    expect(w.canDrive).toBe(true);
    expect(w.splitConditional).not.toBeNull();
    expect(w.driveBlockers).toHaveLength(0);
  });
});