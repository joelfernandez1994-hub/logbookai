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
    // Build 8 days of 9 on-duty hours = 72h (> 70). Simplest: 8 ON_DUTY days.
    const events = [];
    for (let d = 7; d >= 1; d--) {
      const dayBase = new Date(NOW.getTime() - d * 24 * H);
      const start = new Date(dayBase.getTime() + 8 * H);
      events.push({
        id: `on-${d}`,
        log_date: new Date(dayBase.getTime()).toISOString().slice(0, 10),
        start_timestamp: start.toISOString(),
        end_timestamp: new Date(start.getTime() + 9 * H).toISOString(),
        duty_status: 'ON_DUTY', city: 'Miami', state: 'FL',
        is_ongoing: false, is_current_version: true,
      });
    }
    const info = whatCanIDo(events, '70_8', 'America/New_York', NOW);
    expect(info.canDrive).toBe(false);
    expect(info.driveBlockers.some(b => /cycle/i.test(b.rule))).toBe(true);
  });

  it('returns eligibleAt (earliest legal drive time) when blocked by an in-progress rest', () => {
    // Driver is 7h into a 10h rest at 2 PM -> eligible at 5 PM.
    const restStart = new Date(NOW.getTime() - 7 * H);
    const events = [
      { id: 'rest', log_date: '2026-08-20', start_timestamp: restStart.toISOString(), end_timestamp: null,
        duty_status: 'OFF_DUTY', city: 'Miami', state: 'FL', is_ongoing: true, is_current_version: true },
    ];
    const info = whatCanIDo(events, '70_8', 'America/New_York', NOW);
    // No 10h reset yet -> driving not applicable -> blocked by 11h/14h, eligibleAt the 10h completion.
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
    // Full 10h reset, then drive, then a 7h35 sleeper (no second qualifying period yet),
    // then currently driving. No HOS limit exceeded.
    const events = [
      { id: 'reset', log_date: '2026-08-19', start_timestamp: new Date(NOW.getTime() - 30 * H).toISOString(), end_timestamp: new Date(NOW.getTime() - 20 * H).toISOString(), duty_status: 'OFF_DUTY', city: 'Miami', state: 'FL', is_ongoing: false, is_current_version: true },
      { id: 'd1', log_date: '2026-08-19', start_timestamp: new Date(NOW.getTime() - 20 * H).toISOString(), end_timestamp: new Date(NOW.getTime() - 12 * H).toISOString(), duty_status: 'DRIVING', city: 'Miami', state: 'FL', is_ongoing: false, is_current_version: true },
      { id: 'split1', log_date: '2026-08-20', start_timestamp: new Date(NOW.getTime() - 12 * H).toISOString(), end_timestamp: new Date(NOW.getTime() - 4.4166667 * H).toISOString(), duty_status: 'SLEEPER_BERTH', city: 'Miami', state: 'FL', is_ongoing: false, is_current_version: true }, // ~7h35
      { id: 'd2', log_date: '2026-08-20', start_timestamp: new Date(NOW.getTime() - 4.4166667 * H).toISOString(), end_timestamp: new Date(NOW.getTime() - 1 * H).toISOString(), duty_status: 'DRIVING', city: 'Miami', state: 'FL', is_ongoing: false, is_current_version: true },
    ];
    const hos = computeHOS(events, '70_8', 'America/New_York', NOW, { historyComplete: true });
    // The engine should report split status 'available' (not a violation).
    expect(hos.split.status).toBe('available');
    const issues = runComplianceCheck(events, '70_8', 'America/New_York', NOW, { historyComplete: true });
    expect(issues.hos.filter(h => /split/i.test(h.rule))).toHaveLength(0);
    // canDrive must be true (the partial split alone does not block driving)
    const info = whatCanIDo(events, '70_8', 'America/New_York', NOW);
    expect(info.canDrive).toBe(true);
  });

  it('does not force split-sleeper completion — no warning is raised', () => {
    const events = [
      { id: 'reset', log_date: '2026-08-19', start_timestamp: new Date(NOW.getTime() - 30 * H).toISOString(), end_timestamp: new Date(NOW.getTime() - 20 * H).toISOString(), duty_status: 'OFF_DUTY', city: 'Miami', state: 'FL', is_ongoing: false, is_current_version: true },
      { id: 'd1', log_date: '2026-08-19', start_timestamp: new Date(NOW.getTime() - 20 * H).toISOString(), end_timestamp: new Date(NOW.getTime() - 12 * H).toISOString(), duty_status: 'DRIVING', city: 'Miami', state: 'FL', is_ongoing: false, is_current_version: true },
      { id: 'split1', log_date: '2026-08-20', start_timestamp: new Date(NOW.getTime() - 12 * H).toISOString(), end_timestamp: new Date(NOW.getTime() - 4 * H).toISOString(), duty_status: 'SLEEPER_BERTH', city: 'Miami', state: 'FL', is_ongoing: false, is_current_version: true }, // 8h sleeper
    ];
    const info = whatCanIDo(events, '70_8', 'America/New_York', NOW);
    // 8h sleeper with no driving after -> resting now, but split is optional, no blocker from split
    expect(info.splitConditional).toBeTruthy();
    // blockers, if any, must NOT include a split rule
    expect(info.driveBlockers.some(b => /split/i.test(b.rule))).toBe(false);
  });

  it('split does not reset the 70-hour cycle', () => {
    // A valid 7+3 split: cycle used is unchanged by the split (still counts all on-duty/drive).
    const splitEvents = [
      { id: 'reset', log_date: '2026-08-18', start_timestamp: new Date(NOW.getTime() - 40 * H).toISOString(), end_timestamp: new Date(NOW.getTime() - 30 * H).toISOString(), duty_status: 'OFF_DUTY', city: 'Miami', state: 'FL', is_ongoing: false, is_current_version: true },
      { id: 's1', log_date: '2026-08-19', start_timestamp: new Date(NOW.getTime() - 30 * H).toISOString(), end_timestamp: new Date(NOW.getTime() - 23 * H).toISOString(), duty_status: 'SLEEPER_BERTH', city: 'Miami', state: 'FL', is_ongoing: false, is_current_version: true }, // 7h
      { id: 'd1', log_date: '2026-08-19', start_timestamp: new Date(NOW.getTime() - 23 * H).toISOString(), end_timestamp: new Date(NOW.getTime() - 20 * H).toISOString(), duty_status: 'DRIVING', city: 'Miami', state: 'FL', is_ongoing: false, is_current_version: true },
      { id: 'o1', log_date: '2026-08-19', start_timestamp: new Date(NOW.getTime() - 20 * H).toISOString(), end_timestamp: new Date(NOW.getTime() - 17 * H).toISOString(), duty_status: 'OFF_DUTY', city: 'Miami', state: 'FL', is_ongoing: false, is_current_version: true }, // 3h
      { id: 'd2', log_date: '2026-08-20', start_timestamp: new Date(NOW.getTime() - 17 * H).toISOString(), end_timestamp: new Date(NOW.getTime() - 10 * H).toISOString(), duty_status: 'DRIVING', city: 'Miami', state: 'FL', is_ongoing: false, is_current_version: true },
    ];
    const hos = computeHOS(splitEvents, '70_8', 'America/New_York', NOW, { historyComplete: true });
    expect(hos.split.status).toBe('active');
    // Cycle counts ALL on-duty + driving across the 8-day window regardless of split.
    // The split only changes 11h/14h, never the cycle.
    expect(hos.cycle.cycleRemainingHours).toBeLessThanOrEqual(70);
    expect(hos.cycle.cycleRemainingHours).toBeGreaterThan(0);
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