// TEMP AUDIT PROBE — not a permanent regression file.
import { describe, it, expect } from 'vitest';
import { validateTimeline, normalizeTimeline, canComputeHOS } from './timelineEngine';
import { computeHOS, computeGoverningReset } from './hosEngine';

const TZ = 'America/New_York';
const CYCLE = '70_8';
const DAY0 = Date.UTC(2026, 8, 21, 4, 0, 0); // 2026-09-21T00:00:00 ET
// atMin(m): m MINUTES after DAY0 midnight ET, as an ISO string. No fractional
// Date.UTC hour args anywhere (Date.UTC truncates a fractional hour arg).
const atMin = (m) => new Date(DAY0 + m * 60000).toISOString();
const ev = (status, s, e, extra = {}) => ({ duty_status: status, start_timestamp: s, end_timestamp: e, city: 'Miami', state: 'FL', ...extra });
const segs = (events, now) => normalizeTimeline(events, now).segments;

describe('1/2. GAPS — must never be silently inferred as any duty status; HOS unavailable until fixed', () => {
  it.each([['1 minute', 1], ['15 minutes', 15], ['1 hour', 60], ['several hours', 240], ['overnight (8h)', 480]])(
    '%s gap mid-day: segment array preserves the hole, elapsed_gap is flagged, HOS is unavailable',
    (_label, gapMin) => {
      const events = [ev('OFF_DUTY', atMin(0), atMin(360)), ev('ON_DUTY', atMin(360 + gapMin), atMin(600))];
      const now = new Date(atMin(600));
      const s = segs(events, now);
      expect(s.find(x => x.duty_status === 'OFF_DUTY').end.getTime()).toBe(new Date(atMin(360)).getTime());
      expect(s.find(x => x.duty_status === 'ON_DUTY').start.getTime()).toBe(new Date(atMin(360 + gapMin)).getTime());
      const v = validateTimeline(events, { now, dateStr: '2026-09-21', timezone: TZ });
      expect(v.hasElapsedGap).toBe(true);
      expect(v.valid).toBe(false);
      const hos = computeHOS(events, CYCLE, TZ, now, { historyComplete: true });
      expect(hos.calculable).toBe(false);
    }
  );

  it('a gap that straddles midnight is still reported on whichever day it falls in', () => {
    const events = [ev('DRIVING', atMin(1200), atMin(1380)), ev('ON_DUTY', atMin(1680), atMin(1800))]; // 20:00-23:00, then 04:00-06:00 next day (7h gap)
    const now = new Date(atMin(1800));
    const v1 = validateTimeline(events, { now, dateStr: '2026-09-22', timezone: TZ });
    expect(v1.hasElapsedGap).toBe(true);
  });

  it('fixing the gap immediately restores calculability (no stale block)', () => {
    const now = new Date(atMin(600));
    const withGap = [ev('OFF_DUTY', atMin(0), atMin(360)), ev('ON_DUTY', atMin(480), atMin(600))];
    expect(canComputeHOS(withGap, now)).toBe(false);
    const fixed = [ev('OFF_DUTY', atMin(0), atMin(360)), ev('ON_DUTY', atMin(360), atMin(600))];
    expect(canComputeHOS(fixed, now)).toBe(true);
  });
});

describe('2. Malformed / adversarial event shapes never crash and never silently corrupt', () => {
  it('event ending before it starts -> negative_duration, blocking', () => {
    const v = validateTimeline([ev('DRIVING', atMin(600), atMin(480))], {});
    expect(v.issues.some(i => i.type === 'negative_duration' && i.severity === 'blocking')).toBe(true);
  });
  it('two events with identical start (different status) -> same_start_conflict, blocking', () => {
    const v = validateTimeline([ev('DRIVING', atMin(480), atMin(540)), ev('ON_DUTY', atMin(480), atMin(600))], {});
    expect(v.issues.some(i => i.type === 'same_start_conflict')).toBe(true);
  });
  it('exact duplicate events (same start+status) -> flagged, not silently deduped into wrong totals', () => {
    const v = validateTimeline([ev('DRIVING', atMin(480), atMin(540)), ev('DRIVING', atMin(480), atMin(540))], {});
    expect(v.duplicates.length).toBeGreaterThan(0);
    expect(v.valid).toBe(false);
  });
  it('overlapping events (later one starts mid-earlier-one) -> resolved by truncating the earlier at the later start, and flagged if it left a hole', () => {
    const events = [ev('DRIVING', atMin(480), atMin(600)), ev('ON_DUTY', atMin(540), atMin(660))];
    const now = new Date(atMin(660));
    const s = segs(events, now);
    expect(s.find(x => x.duty_status === 'DRIVING').end.getTime()).toBe(new Date(atMin(540)).getTime());
    const v = validateTimeline(events, { now, dateStr: '2026-09-21', timezone: TZ });
    expect(v.hasOverlap).toBe(false); // truncated cleanly, no remaining conflict
    expect(v.hasElapsedGap).toBe(false);
  });
  it('events entered out of chronological order still normalize to a correctly sorted timeline', () => {
    const outOfOrder = [ev('ON_DUTY', atMin(540), atMin(600)), ev('OFF_DUTY', atMin(0), atMin(360)), ev('DRIVING', atMin(360), atMin(540))];
    const s = segs(outOfOrder, new Date(atMin(600)));
    const starts = s.map(x => x.start.getTime());
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
  });
  it('same-status consecutive events (two OFF_DUTY back-to-back) create no phantom gap', () => {
    const events = [ev('OFF_DUTY', atMin(0), atMin(180)), ev('OFF_DUTY', atMin(180), atMin(360)), ev('ON_DUTY', atMin(360), atMin(600))];
    const v = validateTimeline(events, { now: new Date(atMin(600)), dateStr: '2026-09-21', timezone: TZ });
    expect(v.hasElapsedGap).toBe(false);
    expect(v.valid).toBe(true);
  });
  it('an open-ended event continues forward to the next status change (canonical rule)', () => {
    const events = [ev('DRIVING', atMin(480), null), ev('ON_DUTY', atMin(660), atMin(720))];
    const s = segs(events, new Date(atMin(720)));
    const driving = s.find(x => x.duty_status === 'DRIVING');
    expect(driving).toBeTruthy();
    expect(driving.end.getTime()).toBe(new Date(atMin(660)).getTime());
  });
});

describe('4. Boundary conditions', () => {
  const reset = ev('OFF_DUTY', atMin(-600), atMin(0)); // 10h qualifying reset ending at t=0
  it.each([[479, false], [480, true], [481, true]])(
    '30-min break required at exactly 8 cumulative driving hours: %i min -> required=%s',
    (mins, expected) => {
      const events = [reset, ev('DRIVING', atMin(0), atMin(mins))];
      const hos = computeHOS(events, CYCLE, TZ, new Date(atMin(mins)), { historyComplete: true });
      expect(!!hos.break?.required).toBe(expected);
    }
  );
  it.each([[659, false], [660, false], [661, true]])(
    '11-hour driving limit exhausted only after 11h01m: %i min -> exhausted=%s',
    (mins, expected) => {
      const events = [reset, ev('DRIVING', atMin(0), atMin(mins))];
      const hos = computeHOS(events, CYCLE, TZ, new Date(atMin(mins)), { historyComplete: true });
      expect(hos.driving?.drivingRemainingMs === 0).toBe(expected);
    }
  );
  it.each([[839, false], [840, false], [841, true]])(
    '14-hour window exhausted only after 14h01m: %i min -> exhausted=%s',
    (mins, expected) => {
      const events = [reset, ev('ON_DUTY', atMin(0), atMin(6)), ev('DRIVING', atMin(6), atMin(mins))];
      const hos = computeHOS(events, CYCLE, TZ, new Date(atMin(mins)), { historyComplete: true });
      expect(hos.window14?.remainingMs === 0).toBe(expected);
    }
  );
  it.each([[2039, 'none'], [2040, 'full'], [2041, 'full']])(
    '34-hour restart only qualifies at/after exactly 34h of continuous off-duty: %i min -> %s',
    (mins, expectType) => {
      const events = [ev('OFF_DUTY', atMin(-mins), atMin(0))];
      const g = computeGoverningReset(segs(events, new Date(atMin(0))), new Date(atMin(0)));
      if (expectType === 'full') expect(g.type).toBe('full');
      else expect(g.type).not.toBe('full');
    }
  );
});

describe('5. Future-date protection', () => {
  it('a future day with no events shows zero totals, not carried-forward current status', () => {
    const events = [ev('DRIVING', atMin(480), atMin(600))]; // today only, still ongoing-ish window
    const now = new Date(atMin(600));
    const tomorrow = '2026-09-22';
    const v = validateTimeline(events, { now, dateStr: tomorrow, timezone: TZ });
    // tomorrow is fully in the future relative to `now`: no segment should be attributed to it
    expect(v.segments.every(s => s.start.getTime() < new Date(atMin(1440)).getTime())).toBe(true);
  });
});
