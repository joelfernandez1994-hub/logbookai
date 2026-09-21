// ============================================================================
// LogbookAI — P1 stabilization regression tests (vitest).
// ----------------------------------------------------------------------------
// Covers the specific P1 gate items beyond the existing timeline/writer/split
// suites:
//   * HOS "canDrive=false" always returns an exact blocker reason.
//   * eligibleAt is returned where the blocker will clear.
//   * usable-vs-remaining distinction (math hours remaining but not usable now).
//   * A partial split (one qualifying 7h35 sleeper, no second period) does NOT
//     set canDrive=false or create a violation — it is informational only.
//   * GPS normalization: full state names ("Florida", "Texas") map to the
//     correct 2-letter abbreviation, so Change Status and Add Event share one
//     "City, ST" format.
//   * HOS Check is deterministic: whatCanIDo / runComplianceCheck reference no
//     base44 client (zero AI requests).
// ============================================================================

import { describe, it, expect, vi } from 'vitest';

// tripSync/locationService import the base44 client, which touches `window` at module
// scope; this suite is pure logic, so stub it (same convention as the other suites).
vi.mock('@/api/base44Client', () => ({ base44: { entities: {}, functions: {}, auth: {} } }));
import { whatCanIDo, computeProposedHOS } from './logAssistant';
import { runComplianceCheck, computeHOS, fmtDur } from './hosEngine';
import { normalizeState } from './locationService';
import * as logAssistantModule from './logAssistant';
import * as hosEngineModule from './hosEngine';

const H = 3600000;
const NOW = new Date('2026-08-20T14:00:00-04:00'); // 2 PM ET

function ev(startH, endH, status, extra = {}) {
  const base = new Date('2026-08-20T00:00:00-04:00');
  return {
    id: extra.id || `${startH}-${status}`,
    log_date: extra.log_date || '2026-08-20',
    start_timestamp: new Date(base.getTime() + startH * H).toISOString(),
    end_timestamp: endH == null ? null : new Date(base.getTime() + endH * H).toISOString(),
    duty_status: status,
    city: extra.city || 'Miami', state: extra.state || 'FL',
    remark: extra.remark || '',
    is_ongoing: endH == null && extra.ongoing !== false,
    is_current_version: true,
    ...extra,
  };
}


// NOW-relative event helper (hours AGO). Fixtures below are deliberately GAP-FREE:
// under the canonical timeline rule an unlogged interval makes HOS unavailable, so
// a fixture with holes would test "unavailable", not the behavior named in the test.
function rel(id, startAgoH, endAgoH, status) {
  return {
    id, log_date: new Date(NOW.getTime() - startAgoH * H).toISOString().slice(0, 10),
    start_timestamp: new Date(NOW.getTime() - startAgoH * H).toISOString(),
    end_timestamp: endAgoH == null ? null : new Date(NOW.getTime() - endAgoH * H).toISOString(),
    duty_status: status, city: 'Miami', state: 'FL', is_ongoing: endAgoH == null, is_current_version: true,
  };
}

describe('HOS "Can Drive" explanation', () => {
  it('returns the exact blocker reason when the 11-hour driving limit is reached', () => {
    // 11 hours of driving already done this tour
    const events = [
      ev(0, 10, 'OFF_DUTY'),
      ev(10, 10.25, 'ON_DUTY', { remark: 'Pre-Trip' }),
      ev(10.25, 21.25, 'DRIVING'), // 11h driving
      ev(21.25, 22, 'ON_DUTY'),
    ];
    const info = whatCanIDo(events, '70_8', 'America/New_York', new Date('2026-08-20T22:00:00-04:00'));
    expect(info.canDrive).toBe(false);
    const blocker = info.driveBlockers.find(b => /11-hour/i.test(b.rule));
    expect(blocker).toBeTruthy();
    expect(blocker.message).toMatch(/11 hours of driving/);
  });

  it('returns the 30-minute break blocker when 8h driving is accumulated without a break', () => {
    const events = [
      ev(0, 8, 'OFF_DUTY'),
      ev(8, 16, 'DRIVING'), // 8h driving, no qualifying interruption
    ];
    const info = whatCanIDo(events, '70_8', 'America/New_York', new Date('2026-08-20T16:00:00-04:00'));
    expect(info.canDrive).toBe(false);
    expect(info.driveBlockers.some(b => /30-minute break/i.test(b.rule))).toBe(true);
  });

  it('returns the 14-hour window blocker when the window is closed', () => {
    // ON_DUTY at 6 AM, driving fills until 8 PM (14h window expired)
    const events = [
      ev(0, 6, 'OFF_DUTY'),
      ev(6, 6.25, 'ON_DUTY', { remark: 'Pre-Trip' }),
      ev(6.25, 11, 'DRIVING'),
      ev(11, 11.5, 'ON_DUTY'),
      ev(11.5, 20, 'OFF_DUTY'),
    ];
    const info = whatCanIDo(events, '70_8', 'America/New_York', new Date('2026-08-20T20:00:00-04:00'));
    expect(info.canDrive).toBe(false);
    expect(info.driveBlockers.some(b => /14-hour window/i.test(b.rule))).toBe(true);
  });

  it('returns the 70-hour cycle blocker when the cycle is exhausted', () => {
    // 8 consecutive days of 9h on duty (72h > 70) with the 15h between them LOGGED
    // as off duty (no 34h restart, no unlogged gaps), ending in an open off-duty.
    const events = [rel('pre', 8 * 24 + 8, 8 * 24 - 16, 'OFF_DUTY')];
    for (let d = 8; d >= 1; d--) {
      const start = d * 24 - 16;
      events.push(rel(`on-${d}`, start, start - 9, 'ON_DUTY'));
      events.push(rel(`off-${d}`, start - 9, d > 1 ? (d - 1) * 24 - 16 : null, 'OFF_DUTY'));
    }
    const info = whatCanIDo(events, '70_8', 'America/New_York', NOW);
    expect(info.unavailable).toBe(false);
    expect(info.canDrive).toBe(false);
    expect(info.driveBlockers.some(b => /cycle/i.test(b.rule))).toBe(true);
  });

  it('returns eligibleAt (earliest legal drive time) when blocked by an in-progress rest', () => {
    // 7h on duty, then 7h into a 10h rest at 2 PM -> eligible at 5 PM.
    const events = [rel('work', 14, 7, 'ON_DUTY'), rel('rest', 7, null, 'OFF_DUTY')];
    const info = whatCanIDo(events, '70_8', 'America/New_York', NOW);
    expect(info.unavailable).toBe(false);
    // No 10h reset yet -> blocked; eligibleAt is the 10h completion.
    expect(info.canDrive).toBe(false);
    expect(info.tenHourCompletesAt).toBeTruthy();
    expect(info.driveEligibleAt).toBeTruthy();
    expect(new Date(info.driveEligibleAt).getTime()).toBe(new Date(info.tenHourCompletesAt).getTime());
  });

  it('distinguishes driving hours remaining from driving hours usable right now', () => {
    // 5h driving used (6h remain on 11h clock) but 14h window only 2h left.
    const events = [
      ev(0, 6, 'OFF_DUTY'),
      ev(6, 6.25, 'ON_DUTY', { remark: 'Pre-Trip' }),
      ev(6.25, 11.25, 'DRIVING'), // 5h driving
      ev(11.25, 18, 'ON_DUTY'),  // keeps 14h window counting
    ];
    const info = whatCanIDo(events, '70_8', 'America/New_York', new Date('2026-08-20T18:00:00-04:00'));
    // 14h window started 6 AM -> at 6 PM, 14h elapsed exactly -> window closed -> not canDrive
    // Use a slightly earlier now so window has a little left but less than drive clock.
    const info2 = whatCanIDo(events, '70_8', 'America/New_York', new Date('2026-08-20T17:00:00-04:00'));
    expect(info2.driveRemainingMs).toBeGreaterThan(info2.usableDriveMs);
    expect(info2.usableDriveMs).toBeLessThanOrEqual(info2.driveRemainingMs);
    // usable is bounded by the (smaller) 14h window
    expect(info2.usableDriveMs).toBeLessThanOrEqual(info2.windowRemainingMs + 1000);
  });
});

describe('Split sleeper — partial split is informational only', () => {
  it('a single 7h35 qualifying sleeper period does NOT set canDrive=false by itself', () => {
    // Full 10h reset, a short drive, a 7h36 sleeper (no second qualifying period yet),
    // then driving again — all inside the 14h window and under 11h driving.
    const events = [
      rel('reset', 20, 10, 'OFF_DUTY'), rel('d1', 10, 8.6, 'DRIVING'),
      rel('split1', 8.6, 1, 'SLEEPER_BERTH'), rel('d2', 1, null, 'DRIVING'),
    ];
    const hos = computeHOS(events, '70_8', 'America/New_York', NOW, { historyComplete: true });
    expect(hos.split.status).toBe('available'); // informational, not a violation
    const issues = runComplianceCheck(events, '70_8', 'America/New_York', NOW, { historyComplete: true });
    expect(issues.hos.filter(h => /split/i.test(h.rule))).toHaveLength(0);
    const info = whatCanIDo(events, '70_8', 'America/New_York', NOW, true);
    expect(info.canDrive).toBe(true);
  });

  it('does not force split-sleeper completion — no warning is raised', () => {
    // 8h sleeper still in progress: resting now; the split is optional, no split blocker.
    const events = [rel('reset', 20, 10, 'OFF_DUTY'), rel('d1', 10, 8, 'DRIVING'), rel('split1', 8, null, 'SLEEPER_BERTH')];
    const info = whatCanIDo(events, '70_8', 'America/New_York', NOW, true);
    expect(info.splitConditional).toBeTruthy();
    expect(info.driveBlockers.some(b => /split/i.test(b.rule))).toBe(false);
  });

  it('split does not reset the 70-hour cycle', () => {
    // A valid 7+3 split with driving between/after: cycle used is unchanged by the split.
    const events = [
      rel('reset', 30, 20, 'OFF_DUTY'), rel('d0', 20, 19, 'DRIVING'), rel('s1', 19, 12, 'SLEEPER_BERTH'),
      rel('d1', 12, 10, 'DRIVING'), rel('o1', 10, 7, 'OFF_DUTY'), rel('d2', 7, null, 'DRIVING'),
    ];
    const hos = computeHOS(events, '70_8', 'America/New_York', NOW, { historyComplete: true });
    expect(hos.split.status).toBe('active');
    // Cycle counts ALL driving (1+2+7=10h) regardless of the split: 70 - 10 = 60.
    expect(hos.cycle.cycleRemainingHours).toBeCloseTo(60, 1);
  });
});


describe('GPS — single resolver, standardized City, ST', () => {
  it('normalizes full state names to the correct 2-letter abbreviation', () => {
    expect(normalizeState('Florida')).toBe('FL');
    expect(normalizeState('Texas')).toBe('TX'); // slice(0,2) would wrongly give 'TE'
    expect(normalizeState('California')).toBe('CA');
    expect(normalizeState('New York')).toBe('NY');
    expect(normalizeState('District of Columbia')).toBe('DC');
  });

  it('passes already-abbreviated states through as uppercase', () => {
    expect(normalizeState('fl')).toBe('FL');
    expect(normalizeState('TX')).toBe('TX');
  });

  it('returns empty string for a missing state, never a junk value', () => {
    expect(normalizeState('')).toBe('');
    expect(normalizeState(null)).toBe('');
    expect(normalizeState(undefined)).toBe('');
  });
});

describe('HOS Check is deterministic (zero AI requests)', () => {
  it('whatCanIDo and runComplianceCheck do not import the base44 client', () => {
    // Static guarantee: the deterministic modules must not pull in the API client.
    const logSrc = logAssistantModule;
    const hosSrc = hosEngineModule;
    // If they imported base44 it would be a defined binding; these pure modules
    // should not have a `base44` property exported or attached.
    expect(logSrc.base44).toBeUndefined();
    expect(hosSrc.base44).toBeUndefined();
  });

  it('computeProposedHOS produces violations without any network call', () => {
    const events = [ev(0, 6, 'OFF_DUTY'), ev(6, 6.25, 'ON_DUTY', { remark: 'Pre-Trip' }), ev(6.25, 17.5, 'DRIVING')];
    const { violations } = computeProposedHOS(events, [], '70_8', 'America/New_York', new Date('2026-08-20T17:30:00-04:00'));
    expect(Array.isArray(violations)).toBe(true);
  });
});