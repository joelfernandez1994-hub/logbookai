// ============================================================================
// Split-Sleeper HOS Engine — Vitest spec
// ----------------------------------------------------------------------------
// Run with:  npx vitest run src/lib/hosEngine.split.test.js
//
// Asserts exact HOS values for the 9 required split-sleeper scenarios. Each
// scenario reports: authoritative pairing selected, driving accumulated since
// the applicable reference point, 11-hour driving remaining, 14-hour window
// remaining, cycle remaining, split status, and whether any HOS violation
// exists.
// ============================================================================

import { describe, it, expect } from 'vitest';
import { computeHOS } from './hosEngine';
import { SCENARIOS, runScenario, formatPairingLabel } from './hosScenarios';

const round = (n) => Math.round(n * 100) / 100;
const TOL = 0.05; // hours (~3 min tolerance)

describe('Split-Sleeper HOS Engine', () => {
  it('runs all 9 scenarios', () => {
    expect(SCENARIOS.length).toBe(9);
  });

  for (const scenario of SCENARIOS) {
    it(`Scenario ${scenario.id}: ${scenario.name}`, () => {
      const r = runScenario(scenario);
      const e = scenario.expected;

      // Authoritative pairing selected
      expect(r.pairingLabel).toBe(e.pairing);

      // Driving accumulated since the applicable reference point
      expect(Math.abs(r.driveAccumH - e.driveAccumH)).toBeLessThanOrEqual(TOL);

      // 11-hour driving remaining
      expect(Math.abs(r.driveRemH - e.driveRemH)).toBeLessThanOrEqual(TOL);

      // 14-hour window remaining
      expect(Math.abs(r.windowRemH - e.windowRemH)).toBeLessThanOrEqual(TOL);

      // Cycle remaining
      expect(Math.abs(r.cycleRemH - e.cycleRemH)).toBeLessThanOrEqual(TOL);

      // Split status
      expect(r.splitStatus).toBe(e.splitStatus);

      // Whether any HOS violation exists
      expect(r.violation).toBe(e.violation);

      // Scenario 9: the recalculated 14h window must differ from the unsplit calc
      if (e.unsplitWindowRemH != null) {
        expect(r.unsplitWindowRemH).not.toBeNull();
        expect(Math.abs(r.unsplitWindowRemH - e.unsplitWindowRemH)).toBeLessThanOrEqual(TOL);
        expect(r.windowRemH).not.toBeCloseTo(r.unsplitWindowRemH, 1);
      }
    });
  }

  it('computeHOS exposes split-adjusted 11h and 14h clocks', () => {
    const s = SCENARIOS.find((x) => x.id === 1);
    const hos = computeHOS(s.events, '70_8', 'UTC', new Date('2026-08-19T12:00:00Z'), { historyComplete: true });
    expect(hos.driving.referenceType).toBe('split');
    expect(hos.window14.referenceType).toBe('split');
    expect(hos.split.status).toBe('active');
    expect(hos.split.firstPeriod.status).toBe('SLEEPER_BERTH');
    expect(hos.split.secondPeriod.status).toBe('OFF_DUTY');
  });
});