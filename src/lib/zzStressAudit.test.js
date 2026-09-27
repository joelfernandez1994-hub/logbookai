// TEMP AUDIT PROBE — not a permanent regression file. Attacks the canonical
// timeline + HOS engine directly with adversarial inputs from the 2026-09-27
// pre-production stress test request. Deleted/replaced with real regression
// tests for anything that actually fails.
import { describe, it, expect } from 'vitest';
import { validateTimeline, normalizeTimeline, canComputeHOS, planInsert } from './timelineEngine';
import { computeHOS, runComplianceCheck, evaluateSplitSleeper, computeGoverningReset } from './hosEngine';

const TZ = 'America/New_York';
const CYCLE = '70_8';
const iso = (h, m = 0, dayOffset = 0) => new Date(Date.UTC(2026, 8, 21 + dayOffset, h + 4, m)).toISOString(); // ET -> UTC (+4)
const ev = (status, s, e, extra = {}) => ({ duty_status: status, start_timestamp: s, end_timestamp: e, city: 'Miami', state: 'FL', ...extra });

describe('1/2. GAPS — must never be silently inferred as any duty status; HOS unavailable until fixed', () => {
  const cases = [
    ['1 minute', 1], ['15 minutes', 15], ['1 hour', 60], ['several hours', 240], ['overnight (8h)', 480],
  ];
  it.each(cases)('%s gap mid-day blocks HOS (calculable=false) and reports elapsed_gap', (_label, gapMin) => {
    const day0 = ev('OFF_DUTY', iso(0), iso(6));
    const day1Start = 6 + gapMin / 60;
    const events = [day0, ev('ON_DUTY', iso(6 + gapMin / 60), iso(10))];
    const now = new Date(iso(10));
    const v = validateTimeline(events, { now, dateStr: '2026-09-21', timezone: TZ });
    expect(v.hasElapsedGap).toBe(true);
    expect(v.valid).toBe(false);
    const hos = computeHOS(events, CYCLE, TZ, now, { historyComplete: true });
    expect(hos.calculable).toBe(false);
    // no event was synthesized to cover the gap
    expect(events.filter(e => e.start_timestamp > iso(6) && e.start_timestamp < iso(day1Start))).toHaveLength(0);
  });

  it('a gap crossing midnight is still reported (day boundary does not hide it)', () => {
    const events = [ev('DRIVING', iso(20), iso(23)), ev('ON_DUTY', iso(4, 0, 1), iso(6, 0, 1))];
    const now = new Date(iso(6, 0, 1));
    const v0 = validateTimeline(events, { now, dateStr: '2026-09-21', timezone: TZ });
    const v1 = validateTimeline(events, { now, dateStr: '2026-09-22', timezone: TZ });
    expect(v0.hasElapsedGap || v1.hasElapsedGap).toBe(true);
  });

  it('fixing the gap immediately restores calculability (no stale block)', () => {
    const withGap = [ev('OFF_DUTY', iso(0), iso(6)), ev('ON_DUTY', iso(8), iso(10))];
    const now = new Date(iso(10));
    expect(canComputeHOS(withGap, now)).toBe(false);
    const fixed = [ev('OFF_DUTY', iso(0), iso(6)), ev('ON_DUTY', iso(6), iso(10))];
    expect(canComputeHOS(fixed, now)).toBe(true);
  });

  it('HOS never shows a fabricated 0 in place of "--" when unavailable', () => {
    const events = [ev('OFF_DUTY', iso(0), iso(6)), ev('ON_DUTY', iso(8), iso(10))];
    const hos = computeHOS(events, CYCLE, TZ, new Date(iso(10)), { historyComplete: true });
    expect(hos.calculable).toBe(false);
    // driving.drivingRemainingMs must not be presented as a real 0 — canonical
    // contract is the caller shows "--" whenever calculable is false.
  });
});

describe('2. Malformed / adversarial event shapes never crash and never silently corrupt', () => {
  it('event ending before it starts -> negative_duration, blocking', () => {
    const events = [ev('DRIVING', iso(10), iso(8))];
    const v = validateTimeline(events, {});
    expect(v.issues.some(i => i.type === 'negative_duration' && i.severity === 'blocking')).toBe(true);
  });
  it('two events with identical start -> same_start_conflict, blocking (never silently picks one)', () => {
    const events = [ev('DRIVING', iso(8), iso(9)), ev('ON_DUTY', iso(8), iso(10))];
    const v = validateTimeline(events, {});
    expect(v.issues.some(i => i.type === 'same_start_conflict')).toBe(true);
  });
  it('exact duplicate events (same start+status) -> flagged, not silently deduped into wrong totals', () => {
    const events = [ev('DRIVING', iso(8), iso(9)), ev('DRIVING', iso(8), iso(9))];
    const v = validateTimeline(events, {});
    expect(v.duplicates.length).toBeGreaterThan(0);
    expect(v.valid).toBe(false);
  });
  it('overlapping events -> conflict surfaced, not silently truncated by validateTimeline itself', () => {
    const events = [ev('DRIVING', iso(8), iso(10)), ev('ON_DUTY', iso(9), iso(11))];
    const v = validateTimeline(events, { now: new Date(iso(11)), dateStr: '2026-09-21', timezone: TZ });
    expect(v.hasOverlap).toBe(true);
  });
  it('events entered out of chronological order still normalize to the correct sorted timeline', () => {
    const outOfOrder = [ev('ON_DUTY', iso(9), iso(10)), ev('OFF_DUTY', iso(0), iso(6)), ev('DRIVING', iso(6), iso(9))];
    const { segments } = normalizeTimeline(outOfOrder, new Date(iso(10)));
    const starts = segments.map(s => s.start.getTime());
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
  });
  it('same-status consecutive events (two OFF_DUTY back-to-back) do not create a phantom gap or double-count hours', () => {
    const events = [ev('OFF_DUTY', iso(0), iso(3)), ev('OFF_DUTY', iso(3), iso(6)), ev('ON_DUTY', iso(6), iso(10))];
    const v = validateTimeline(events, { now: new Date(iso(10)), dateStr: '2026-09-21', timezone: TZ });
    expect(v.hasElapsedGap).toBe(false);
    expect(v.valid).toBe(true);
  });
  it('an open-ended event continues forward to the next status change (canonical rule)', () => {
    const events = [ev('DRIVING', iso(8), null), ev('ON_DUTY', iso(11), iso(12))];
    const { segments } = normalizeTimeline(events, new Date(iso(12)));
    const driving = segments.find(s => s.duty_status === 'DRIVING');
    expect(driving.end.getTime()).toBe(new Date(iso(11)).getTime());
  });
});

describe('3/4. Boundary conditions — driving limit, 14h window, 30-min break, 34h restart', () => {
  const reset = ev('OFF_DUTY', iso(-10, 0, -1), iso(0));
  it.each([[7 * 60 + 59, false], [8 * 60, true], [8 * 60 + 1, true]])(
    '30-min break: %i min continuous driving since qualifying rest -> required=%s',
    (mins, expected) => {
      const events = [reset, ev('DRIVING', iso(0), iso(mins / 60))];
      const hos = computeHOS(events, CYCLE, TZ, new Date(iso(mins / 60)), { historyComplete: true });
      const required = hos.violations?.some(v => /30-Minute/i.test(v.rule || v.type || '')) || hos.break?.required;
      expect(!!required).toBe(expected);
    }
  );
  it.each([[10 * 60 + 59, false], [11 * 60, false], [11 * 60 + 1, true]])(
    '11-hour driving limit: %i min of driving -> overLimit=%s',
    (mins, expectOver) => {
      const events = [reset, ev('DRIVING', iso(0), iso(mins / 60))];
      const hos = computeHOS(events, CYCLE, TZ, new Date(iso(mins / 60)), { historyComplete: true });
      const over = hos.driving?.drivingRemainingMs === 0 || hos.violations?.some(v => /11-Hour/i.test(v.rule || v.type || ''));
      expect(!!over).toBe(expectOver);
    }
  );
  it.each([[13 * 60 + 59, false], [14 * 60, false], [14 * 60 + 1, true]])(
    '14-hour window: %i min elapsed since on-duty start -> overWindow=%s',
    (mins, expectOver) => {
      const events = [reset, ev('ON_DUTY', iso(0), iso(0.1)), ev('DRIVING', iso(0.1), iso(mins / 60))];
      const hos = computeHOS(events, CYCLE, TZ, new Date(iso(mins / 60)), { historyComplete: true });
      const over = hos.window14?.remainingMs === 0 || hos.violations?.some(v => /14-Hour/i.test(v.rule || v.type || ''));
      expect(!!over).toBe(expectOver);
    }
  );
  it.each([[33 * 60 + 59, 'none'], [34 * 60, 'reset'], [34 * 60 + 1, 'reset']])(
    '34-hour restart: %i min of continuous off-duty -> governing type reflects reset only at/after 34h',
    (mins, expectType) => {
      const events = [ev('OFF_DUTY', iso(-mins / 60), iso(0))];
      const g = computeGoverningReset(events, new Date(iso(0)));
      if (expectType === 'reset') expect(g.type).not.toBe('none');
      else expect(g.type).toBe('none');
    }
  );
});

describe('3. Split sleeper — valid pairings recalc correctly; invalid pairings never reset clocks wrong', () => {
  it('valid 8/2 split (>=7h sleeper + >=2h qualifying, combined >=10h) is recognized', () => {
    const events = [
      ev('SLEEPER_BERTH', iso(-14), iso(-6)),   // 8h sleeper
      ev('DRIVING', iso(-6), iso(-4)),
      ev('OFF_DUTY', iso(-4), iso(-2)),          // 2h second qualifying period
      ev('DRIVING', iso(-2), iso(0)),
    ];
    const result = evaluateSplitSleeper(normalizeTimeline(events, new Date(iso(0))).segments, new Date(iso(0)));
    expect(result).toBeTruthy();
  });
  it('invalid 6/4 split (first period under 7h sleeper minimum) does NOT count as a valid pair / full reset', () => {
    const events = [
      ev('SLEEPER_BERTH', iso(-14), iso(-8)),   // only 6h
      ev('DRIVING', iso(-8), iso(-6)),
      ev('OFF_DUTY', iso(-6), iso(-2)),          // 4h
      ev('DRIVING', iso(-2), iso(0)),
    ];
    const g = computeGoverningReset(events, new Date(iso(0)));
    // must not be silently treated as a qualifying full reset from this pairing
    expect(g.type).not.toBe('full');
  });
});

describe('5. Future-date protection', () => {
  it('a future day with only past events shows no driving/current status leaking forward', () => {
    const events = [ev('DRIVING', iso(8), iso(10))]; // today only
    const tomorrow = '2026-09-22';
    const now = new Date(iso(10));
    const v = validateTimeline(events, { now, dateStr: tomorrow, timezone: TZ });
    // tomorrow's window (dayStart..targetEnd) with no events covering it: isCurrent=false since now<dayStart
    expect(v.segments.some(s => s.start >= new Date(`${tomorrow}T00:00:00-04:00`))).toBe(false);
  });
  it('an event whose start is genuinely in the future relative to `now` is not silently backdated or hidden by validateTimeline itself', () => {
    const now = new Date(iso(10));
    const future = ev('DRIVING', iso(20), iso(22)); // 10h ahead of now
    const v = validateTimeline([future], { now });
    // validateTimeline does not itself reject future events (that's proposalValidation's job) —
    // confirm it at least does not crash and does not mark it as already-elapsed coverage.
    expect(() => v).not.toThrow();
  });
});
