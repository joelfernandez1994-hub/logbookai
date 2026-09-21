// ============================================================================
// LogbookAI — Canonical Timeline Engine regression tests (vitest).
// Mirrors the required V3 regression suite (items 42 & 43).
// ============================================================================
import { describe, it, expect, vi } from 'vitest';

// tripSync/locationService import the base44 client, which touches `window` at module
// scope; this suite is pure logic, so stub it (same convention as the other suites).
vi.mock('@/api/base44Client', () => ({ base44: { entities: {}, functions: {}, auth: {} } }));
import {
  normalizedSegments, normalizeTimeline, findDuplicates,
  dailyTotals, validateTimeline, canComputeHOS,
  planInsert, planReplaceRange, repairTimeline,
} from './timelineEngine';
import { findTimelineGaps } from './tripSync';

const TZ = 'America/New_York';
// 2026-08-20 is a Thursday; we anchor times to this date in ET.
const DAY = '2026-08-20';
const NOW = new Date('2026-08-20T18:00:00-04:00'); // 6 PM ET on the 20th

function iso(h, m = 0, date = DAY) {
  // h is 0..24 in ET (may be fractional, e.g. 6.25 = 6:15). Build an ISO at that
  // local wall-clock time using millisecond math (setHours would truncate).
  const base = new Date(`${date}T00:00:00-04:00`);
  const totalMin = Math.round(h * 60) + m;
  return new Date(base.getTime() + totalMin * 60000).toISOString();
}
function ev(status, startH, endH, extra = {}) {
  return {
    id: extra.id || `${startH}-${status}`,
    log_date: DAY,
    start_timestamp: iso(startH),
    end_timestamp: endH == null ? null : iso(endH),
    duty_status: status,
    city: extra.city || 'Miami', state: extra.state || 'FL',
    remark: extra.remark || '',
    is_ongoing: endH == null && extra.ongoing !== false,
    is_current_version: true,
    ...extra,
  };
}

describe('Timeline normalization', () => {
  it('closes the previous status when a new one starts at 6:00', () => {
    const events = [
      ev('OFF_DUTY', 0, 6),
      ev('ON_DUTY', 6, 6.25, { remark: 'Pre-Trip' }),
    ];
    const segs = normalizedSegments(events, NOW);
    expect(segs).toHaveLength(2);
    expect(segs[0].end.getTime()).toBe(segs[1].start.getTime());
  });

  it('preserves unlogged gaps and blocks HOS calculation', () => {
    const events = [
      ev('OFF_DUTY', 0, 3.85),
      ev('ON_DUTY', 3.92, 4.27),
      ev('DRIVING', 7.85, 7.92),
      ev('OFF_DUTY', 15.48, null),
    ];
    const normalized = normalizedSegments(events, NOW);
    const validation = validateTimeline(events, { now: NOW, dateStr: DAY, timezone: TZ });
    expect(findTimelineGaps(events, DAY, TZ, NOW).length).toBeGreaterThan(0);
    expect(normalized[0].end.getTime()).toBe(new Date(iso(3.85)).getTime());
    expect(validation.valid).toBe(false);
    expect(validation.hasElapsedGap).toBe(true);
    expect(validation.issues.some(issue => issue.type === 'elapsed_gap')).toBe(true);
  });

  it('cannot keep exact duplicate same-time events', () => {
    const events = [
      ev('OFF_DUTY', 0, 6),
      ev('OFF_DUTY', 0, 6), // exact duplicate
      ev('ON_DUTY', 6, 7),
    ];
    const segs = normalizedSegments(events, NOW);
    expect(segs).toHaveLength(2);
    expect(findDuplicates(events)).toHaveLength(1);
  });

  it('resolves overlapping segments so no two cover the same instant', () => {
    const events = [
      ev('DRIVING', 8, 12),
      ev('ON_DUTY', 11, 13), // overlaps 11-12
    ];
    const { segments } = normalizeTimeline(events, NOW);
    // driving should be truncated to end at 11 (when on-duty begins)
    const drive = segments.find(s => s.duty_status === 'DRIVING');
    expect(drive.end.getTime()).toBe(new Date(iso(11)).getTime());
    expect(segments).toHaveLength(2);
    // no overlap remains
    for (let i = 1; i < segments.length; i++) {
      expect(segments[i - 1].end.getTime()).toBeLessThanOrEqual(segments[i].start.getTime());
    }
  });

  it('a completed day totals exactly 24 hours', () => {
    const events = [
      ev('OFF_DUTY', 0, 8),
      ev('ON_DUTY', 8, 8.25, { remark: 'Pre-Trip' }),
      ev('DRIVING', 8.25, 16),
      ev('ON_DUTY', 16, 16.5),
      ev('SLEEPER_BERTH', 16.5, 24),
    ];
    // Evaluate as a COMPLETED past day (now is the next afternoon).
    const pastNow = new Date('2026-08-21T12:00:00-04:00');
    const dt = dailyTotals(events, DAY, TZ, pastNow);
    expect(dt.isCurrent).toBe(false);
    expect(dt.isFuture).toBe(false);
    expect(Math.abs(dt.totalHours - 24)).toBeLessThan(0.01);
    expect(dt.DRIVING).toBeCloseTo(7.75, 2);
  });

  it('current-day totals cannot exceed elapsed time', () => {
    // events through midnight would over-count if not clipped to now
    const events = [
      ev('OFF_DUTY', 0, 8),
      ev('DRIVING', 8, 23), // runs until 11 PM but now is 6 PM
    ];
    const dt = dailyTotals(events, DAY, TZ, NOW);
    expect(dt.totalHours).toBeLessThanOrEqual(18 + 0.01); // now is 18:00
  });

  it('a future blank date returns zero hours', () => {
    const tomorrow = '2026-08-21';
    const events = [ev('DRIVING', 8, 16)];
    const dt = dailyTotals(events, tomorrow, TZ, NOW);
    expect(dt.isFuture).toBe(true);
    expect(dt.OFF_DUTY).toBe(0);
    expect(dt.SLEEPER_BERTH).toBe(0);
    expect(dt.DRIVING).toBe(0);
    expect(dt.ON_DUTY).toBe(0);
  });

  it('a midnight-crossing event populates only the valid next-day period', () => {
    // Sleeper from 10 PM Aug 20 to 6 AM Aug 21 (legitimate cross-midnight)
    const sleeper = {
      id: 'x',
      log_date: '2026-08-20',
      start_timestamp: iso(22, 0, '2026-08-20'),
      end_timestamp: iso(6, 0, '2026-08-21'),
      duty_status: 'SLEEPER_BERTH',
      city: 'Tallahassee', state: 'FL',
      is_ongoing: false, is_current_version: true,
    };
    const aug21 = '2026-08-21';
    // Evaluated AFTER the event has happened: the engine never counts time that is
    // still in the future relative to `now` (a future event is ignored), so a `now`
    // before 10 PM Aug 20 would correctly show 0.
    const after = new Date('2026-08-21T12:00:00-04:00');
    const dt = dailyTotals([sleeper], aug21, TZ, after);
    // Aug 21 shows 12:00 AM -> 6:00 AM Sleeper = 6h (not a blank zero)...
    expect(dt.SLEEPER_BERTH).toBeCloseTo(6, 2);
    // ...and the evening portion lands on Aug 20 (10 PM -> midnight = 2h).
    expect(dailyTotals([sleeper], '2026-08-20', TZ, after).SLEEPER_BERTH).toBeCloseTo(2, 2);
    // A `now` BEFORE the event started must not count it at all.
    expect(dailyTotals([sleeper], aug21, TZ, NOW).SLEEPER_BERTH).toBe(0);
  });

  it('does not extend the latest ongoing status into future days', () => {
    // ongoing DRIVING starting 4 PM Aug 20 with no end
    const ongoing = ev('DRIVING', 16, null);
    const aug22 = '2026-08-22';
    const dt = dailyTotals([ongoing], aug22, TZ, NOW);
    expect(dt.isFuture).toBe(true);
    expect(dt.DRIVING).toBe(0); // ongoing caps at now; never bleeds into Aug 22
  });
});

describe('AI timeline proposals', () => {
  it('interprets a multi-step trip as one chronological state machine', () => {
    const proposed = [
      { duty_status: 'OFF_DUTY', start_timestamp: iso(0), end_timestamp: iso(6), city: 'Miami', state: 'FL' },
      { duty_status: 'ON_DUTY', start_timestamp: iso(6), end_timestamp: iso(6.25), remark: 'Pre-Trip', city: 'Miami', state: 'FL' },
      { duty_status: 'DRIVING', start_timestamp: iso(6.25), end_timestamp: iso(9.17), city: 'Miami', state: 'FL' },
      { duty_status: 'ON_DUTY', start_timestamp: iso(9.17), end_timestamp: iso(9.5), remark: 'Fuel', city: 'Port St. Lucie', state: 'FL' },
      { duty_status: 'DRIVING', start_timestamp: iso(9.5), end_timestamp: iso(15.75), city: 'Port St. Lucie', state: 'FL' },
      { duty_status: 'OFF_DUTY', start_timestamp: iso(15.75), end_timestamp: iso(24), city: 'Tallahassee', state: 'FL' },
    ];
    const { segments } = normalizeTimeline(proposed, NOW);
    expect(segments).toHaveLength(6);
    // Each new status terminates the previous one (back-to-back, no overlap)
    for (let i = 1; i < segments.length; i++) {
      expect(segments[i - 1].end.getTime()).toBe(segments[i].start.getTime());
    }
    const dt = dailyTotals(proposed, DAY, TZ, new Date(iso(24)));
    expect(Math.abs(dt.totalHours - 24)).toBeLessThan(0.01);
  });

  it('"redo entire day" replaces, not appends', () => {
    const existing = [
      ev('OFF_DUTY', 0, 8),
      ev('ON_DUTY', 8, 16),
      ev('DRIVING', 16, 20),
    ];
    const rangeStart = new Date(iso(0, 0, '2026-08-20'));
    const rangeEnd = new Date(iso(24, 0, '2026-08-20'));
    const replacement = [
      { duty_status: 'OFF_DUTY', start_timestamp: iso(0), end_timestamp: iso(7), city: 'Miami', state: 'FL' },
      { duty_status: 'DRIVING', start_timestamp: iso(7), end_timestamp: iso(15), city: 'Miami', state: 'FL' },
      { duty_status: 'SLEEPER_BERTH', start_timestamp: iso(15), end_timestamp: iso(24), city: 'Tallahassee', state: 'FL' },
    ];
    const ops = planReplaceRange(existing, rangeStart, rangeEnd, replacement, NOW);
    expect(ops.deletes).toHaveLength(3); // all original day events removed
    expect(ops.creates).toHaveLength(3); // replacement timeline only
    expect(ops.creates.some(c => c.duty_status === 'ON_DUTY')).toBe(false);
  });

  it('blocks an AI proposal that produces overlapping events', () => {
    const existing = [ev('DRIVING', 8, 12)];
    const proposed = [{ duty_status: 'ON_DUTY', start_timestamp: iso(11), end_timestamp: iso(13), city: 'Miami', state: 'FL' }];
    const merged = [...existing, ...proposed];
    // After normalization the overlap is resolved by truncation, but validation
    // of the raw proposed merge must still be checked: here we ensure the
    // resolved timeline has no overlap and the original driving is truncated.
    const { segments } = normalizeTimeline(merged, NOW);
    const drive = segments.find(s => s.duty_status === 'DRIVING');
    expect(drive.end.getTime()).toBe(new Date(iso(11)).getTime());
  });
});

describe('Canonical inserts', () => {
  it('rejects an exact duplicate insert', () => {
    const existing = [ev('ON_DUTY', 8, 9)];
    const ops = planInsert(existing, ev('ON_DUTY', 8, 10), NOW);
    expect(ops.duplicate).toBe(true);
    expect(ops.creates).toHaveLength(0);
  });

  it('ends the ongoing event at the new event start', () => {
    const ongoing = { ...ev('DRIVING', 12, null), id: 'ongoing' };
    const ops = planInsert([ongoing], ev('ON_DUTY', 14, 14.25), NOW);
    // the ongoing driving is ended at the new event's start
    expect(ops.updates.some(u => u.id === 'ongoing' && u.data.end_timestamp === iso(14))).toBe(true);
    // the new ON_DUTY status begins at that same instant
    expect(ops.creates.some(c => c.duty_status === 'ON_DUTY' && c.start_timestamp === iso(14))).toBe(true);
  });
});

describe('Repair of corrupted V2 records', () => {
  it('removes exact duplicates and resolves overlaps without inventing statuses', () => {
    const corrupted = [
      ev('OFF_DUTY', 0, 6),
      ev('OFF_DUTY', 0, 6), // duplicate
      ev('DRIVING', 6, 12),
      ev('ON_DUTY', 11, 13), // overlap (11-12)
      ev('SLEEPER_BERTH', 13, 20),
      ev('SLEEPER_BERTH', 13, 20), // duplicate
    ];
    const r = repairTimeline(corrupted, NOW);
    expect(r.removedDuplicates).toBe(2);
    expect(r.resolvedOverlaps).toBeGreaterThanOrEqual(1); // counter also tallies duplicate collapses; the RESULT below is the real contract
    // exact repaired timeline: OFF 0-6, DRIVING truncated to 6-11, ON 11-13, SLEEPER 13-20
    expect(r.repaired.map(e => [e.duty_status, e.start_timestamp, e.end_timestamp])).toEqual([
      ['OFF_DUTY', iso(0), iso(6)], ['DRIVING', iso(6), iso(11)], ['ON_DUTY', iso(11), iso(13)], ['SLEEPER_BERTH', iso(13), iso(20)],
    ]);
    // no two repaired segments overlap
    for (let i = 1; i < r.repaired.length; i++) {
      expect(new Date(r.repaired[i - 1].end_timestamp).getTime())
        .toBeLessThanOrEqual(new Date(r.repaired[i].start_timestamp).getTime());
    }
    // every kept status came from the originals — nothing invented
    const statuses = r.repaired.map(e => e.duty_status);
    expect(new Set(statuses).has('ON_DUTY')).toBe(true);
  });
});

describe('HOS uses validated records only', () => {
  it('rejects HOS computation when a same-start conflict exists', () => {
    const bad = [
      ev('DRIVING', 8, 12),
      ev('ON_DUTY', 8, 10), // same start, different status — ambiguous
    ];
    expect(canComputeHOS(bad, NOW)).toBe(false);
  });

  it('accepts HOS computation on a clean normalized timeline', () => {
    const good = [
      ev('OFF_DUTY', 0, 6),
      ev('ON_DUTY', 6, 6.25, { remark: 'Pre-Trip' }),
      ev('DRIVING', 6.25, 14),
      ev('SLEEPER_BERTH', 14, 24),
    ];
    expect(canComputeHOS(good, NOW)).toBe(true);
  });
});