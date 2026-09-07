// ============================================================================
// LogbookAI — REGRESSION: an actively open duty status must never be flagged
// as a "time gap" between now and the last render tick.
// ----------------------------------------------------------------------------
// Live bug: Today showed OFF_DUTY 00:00-06:00, ON_DUTY 06:00-06:15 (Pre-Trip),
// DRIVING 6:15->ongoing (Live Tracking on, driver actively Driving) — yet the
// app surfaced a blocking "Timeline correction required" banner AND a "Time
// gap between duty records: 10:05 AM -> 10:07 AM (2 min)" notice, with HOS
// numbers hidden ("Unavailable until timeline is valid").
//
// Root cause: BOTH validateTimeline() (timelineEngine.js) and
// findTimelineGaps() (tripSync.js) independently capped the elapsed-coverage
// check at `now`, then flagged a trailing "gap" whenever the last covered
// segment's end fell even slightly short of the (state-driven, ~30s-ticking)
// `now` used for the check -- without ever asking whether the LAST logged
// segment was still genuinely open. A currently open-ended duty status IS
// continuous with "now" by construction (nothing has changed since the driver
// last set it) -- there is no missing time slot for the driver to add a
// record for. Any tiny drift between the moment `events` were fetched/
// normalized and the moment the check ran (a slow re-render, a backgrounded
// tab, or simply two independent `now` snapshots a normal polling interval
// apart) manufactured a phantom "gap" and blocked HOS entirely on an
// otherwise perfectly valid, continuous log.
//
// Fix: both functions now track whether the last segment reaching `now`
// (dropped through an intermediate `.map()` before) is `is_ongoing`, and
// skip the TRAILING gap/hasElapsedGap check when it is -- mid-timeline gaps
// (a real hole between two closed records) are completely unaffected and
// still block exactly as before.
// ============================================================================
import { describe, it, expect, vi } from 'vitest';
vi.mock('@/api/base44Client', () => ({ base44: { entities: {} } }));
import { validateTimeline } from './timelineEngine';
import { findTimelineGaps } from './tripSync';

const TZ = 'America/New_York';
const DAY = '2026-09-07';

describe('REGRESSION — an ongoing duty status is never a false trailing "time gap"', () => {
  // Exact live scenario: OFF_DUTY 00:00-06:00, ON_DUTY 06:00-06:15 (Pre-Trip),
  // DRIVING 6:15->ongoing, Live Tracking active. `now` ticks a couple minutes
  // past the last render that produced `events` -- a normal, harmless drift.
  const events = [
    { duty_status: 'OFF_DUTY', start_timestamp: `${DAY}T04:00:00.000Z`, end_timestamp: `${DAY}T10:00:00.000Z` },
    { duty_status: 'ON_DUTY', start_timestamp: `${DAY}T10:00:00.000Z`, end_timestamp: `${DAY}T10:15:00.000Z` },
    { duty_status: 'DRIVING', start_timestamp: `${DAY}T10:15:00.000Z`, end_timestamp: null, is_ongoing: true },
  ];
  const now = new Date(`${DAY}T14:09:00.000Z`); // ~10:09 AM ET

  it('validateTimeline: no elapsed-gap issue, timeline stays valid', () => {
    const v = validateTimeline(events, { now, dateStr: DAY, timezone: TZ });
    expect(v.hasElapsedGap).toBe(false);
    expect(v.valid).toBe(true);
    expect(v.issues.some((i) => i.type === 'elapsed_gap')).toBe(false);
  });

  it('findTimelineGaps: reports zero gaps', () => {
    expect(findTimelineGaps(events, DAY, TZ, now)).toEqual([]);
  });
});

describe('control — a genuinely CLOSED last record still reports a real trailing gap', () => {
  // Same shape, but the driver's status was closed (e.g. at a fuel stop) and
  // nothing has picked up since -- this is a REAL gap the driver must fix,
  // and must still block exactly as before.
  const events = [
    { duty_status: 'OFF_DUTY', start_timestamp: `${DAY}T04:00:00.000Z`, end_timestamp: `${DAY}T10:00:00.000Z` },
    { duty_status: 'ON_DUTY', start_timestamp: `${DAY}T10:00:00.000Z`, end_timestamp: `${DAY}T10:15:00.000Z` },
    { duty_status: 'DRIVING', start_timestamp: `${DAY}T10:15:00.000Z`, end_timestamp: `${DAY}T10:15:30.000Z`, is_ongoing: false },
  ];
  const now = new Date(`${DAY}T14:09:00.000Z`); // ~9h54m after the last record closed

  it('validateTimeline: still flags the elapsed gap and stays invalid', () => {
    const v = validateTimeline(events, { now, dateStr: DAY, timezone: TZ });
    expect(v.hasElapsedGap).toBe(true);
    expect(v.valid).toBe(false);
  });

  it('findTimelineGaps: still reports the real trailing gap', () => {
    const gaps = findTimelineGaps(events, DAY, TZ, now);
    expect(gaps.length).toBeGreaterThan(0);
    expect(gaps[gaps.length - 1].end.getTime()).toBe(now.getTime());
  });
});

describe('control — a genuine MID-TIMELINE gap (not the trailing edge) is unaffected', () => {
  // The ongoing tail is fine, but there's a real unaccounted stretch earlier
  // in the day -- this must still be caught regardless of the trailing fix.
  const events = [
    { duty_status: 'OFF_DUTY', start_timestamp: `${DAY}T04:00:00.000Z`, end_timestamp: `${DAY}T09:00:00.000Z` },
    // 04:00-09:00Z covered; nothing logged 09:00-10:00Z (a real hole)
    { duty_status: 'ON_DUTY', start_timestamp: `${DAY}T10:00:00.000Z`, end_timestamp: `${DAY}T10:15:00.000Z` },
    { duty_status: 'DRIVING', start_timestamp: `${DAY}T10:15:00.000Z`, end_timestamp: null, is_ongoing: true },
  ];
  const now = new Date(`${DAY}T14:09:00.000Z`);

  it('still reports the real mid-day gap even though the tail is genuinely ongoing', () => {
    const gaps = findTimelineGaps(events, DAY, TZ, now);
    expect(gaps.length).toBe(1);
    expect(gaps[0].start.toISOString()).toBe(`${DAY}T09:00:00.000Z`);
    expect(gaps[0].end.toISOString()).toBe(`${DAY}T10:00:00.000Z`);
    const v = validateTimeline(events, { now, dateStr: DAY, timezone: TZ });
    expect(v.hasElapsedGap).toBe(true);
    expect(v.valid).toBe(false);
  });
});
