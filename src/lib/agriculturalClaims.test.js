// Regression tests for the agricultural claim clock-availability layer.
// Pure deterministic logic over isolated fixture data — never touches real logs.
// Covers: no-claim regression, affected vs unaffected clocks, end-of-claim
// retention, restoration only upon independent determinability, and the
// "Availability undetermined" contract.
import { describe, it, expect } from 'vitest';
import {
  claimIntervals, evaluateAgriculturalClocks, applyAgriculturalAvailability,
  availabilityUndeterminedSummary, claimsOnDate, basisLabel, agriculturalSupportEnabled,
  AGRICULTURAL_DISABLED_NOTICE,
} from './agriculturalClaims';
import { computeHOS, normalizeEvents } from './hosEngine';

const TZ = 'America/Chicago';
const H = 3600000;
const D = (iso) => new Date(iso);

// Segments built directly (already-normalized shape) so tests are self-contained.
function segs(list) {
  return list.map(([status, start, end]) => ({
    duty_status: status,
    start: D(start),
    end: D(end),
    city: 'Dallas', state: 'TX',
  }));
}

// A quiet, fully-reset baseline day: 10h off-duty reset 03:00–13:00Z (08:00–18:00
// local is NOT needed — engine works on absolute times), then work.
// Timeline is COMPLETE through `now` (trailing rest): an unresolved trailing
// gap would make the day structurally invalid (engine safeguard), so the
// fixture records 16:00–18:00Z as Off Duty rather than leaving it unrecorded.
const BASE_SEGMENTS = segs([
  ['OFF_DUTY', '2026-10-19T02:00:00Z', '2026-10-19T12:00:00Z'], // 10h reset
  ['ON_DUTY', '2026-10-19T12:00:00Z', '2026-10-19T13:00:00Z'],
  ['DRIVING', '2026-10-19T13:00:00Z', '2026-10-19T16:00:00Z'],
  ['OFF_DUTY', '2026-10-19T16:00:00Z', '2026-10-19T18:00:00Z'], // through now
]);

const NOW = D('2026-10-19T18:00:00Z');

function hosFor(segments, now = NOW) {
  // Wrap raw segments into fake "events" whose normalized form is identity.
  const events = segments.map((s, i) => ({
    id: `seg-${i}`,
    log_date: '2026-10-19',
    start_timestamp: s.start.toISOString(),
    end_timestamp: s.end.toISOString(),
    duty_status: s.duty_status,
    city: s.city, state: s.state,
  }));
  return computeHOS(events, '70_8', TZ, now, { historyComplete: true });
}

const CLAIM_A = {
  id: 'claim-a',
  basis: 'agricultural_commodity_395_1_k_1',
  start_timestamp: '2026-10-19T13:00:00Z',
  end_timestamp: '2026-10-19T15:00:00Z', // covers part of the driving span
  status: 'active',
};

const CLAIM_PAST_DAY = {
  id: 'claim-past',
  basis: 'livestock_final_destination_395_1_k_4',
  start_timestamp: '2026-10-18T12:00:00Z',
  end_timestamp: '2026-10-18T20:00:00Z', // ended well before the reset
  status: 'ended',
  ended_at: '2026-10-18T20:00:00Z',
};

const CLAIM_REST_ONLY = {
  id: 'claim-rest',
  basis: 'agricultural_commodity_395_1_k_1',
  start_timestamp: '2026-10-19T02:00:00Z',
  end_timestamp: '2026-10-19T10:00:00Z', // covers only the 10h reset (OFF_DUTY)
  status: 'active',
};

describe('agriculturalSupportEnabled', () => {
  it('is opt-in only', () => {
    expect(agriculturalSupportEnabled({})).toBe(false);
    expect(agriculturalSupportEnabled({ agricultural_support_enabled: true })).toBe(true);
  });
});

describe('claimIntervals', () => {
  it('open claims run to now; ended claims keep their boundary', () => {
    const now = D('2026-10-19T18:00:00Z');
    const ivs = claimIntervals([
      { id: 'open', start_timestamp: '2026-10-19T12:00:00Z', end_timestamp: null, status: 'active' },
      { id: 'ended', start_timestamp: '2026-10-19T10:00:00Z', end_timestamp: null, ended_at: '2026-10-19T11:00:00Z', status: 'ended' },
    ], now);
    expect(ivs).toHaveLength(2);
    expect(ivs[0].end.toISOString()).toBe(now.toISOString());
    expect(ivs[1].end.toISOString()).toBe(D('2026-10-19T11:00:00Z').toISOString());
  });
});

describe('evaluateAgriculturalClocks', () => {
  it('reports no effect with zero claims (standard behavior preserved)', () => {
    const hos = hosFor(BASE_SEGMENTS);
    const ev = evaluateAgriculturalClocks({ claims: [], events: [], hos, cycleType: '70_8', tz: TZ, now: NOW });
    expect(ev.agAffected).toBe(false);
    expect(ev.anyUnavailable).toBe(false);
  });

  it('marks 11h and 14h unavailable when a work claim overlaps the clock history', () => {
    const hos = hosFor(BASE_SEGMENTS);
    const ev = evaluateAgriculturalClocks({ claims: [CLAIM_A], events: [], hos, cycleType: '70_8', tz: TZ, now: NOW });
    expect(ev.clocks.driving.unavailable).toBe(true);
    expect(ev.clocks.window14.unavailable).toBe(true);
    expect(ev.anyUnavailable).toBe(true);
    expect(ev.clocks.driving.claimIds).toContain('claim-a');
  });

  it('keeps clocks numeric for a rest-only claim', () => {
    const hos = hosFor(BASE_SEGMENTS);
    const ev = evaluateAgriculturalClocks({ claims: [CLAIM_REST_ONLY], events: [], hos, cycleType: '70_8', tz: TZ, now: NOW });
    expect(ev.clocks.driving.unavailable).toBe(false);
    expect(ev.clocks.window14.unavailable).toBe(false);
    expect(ev.anyUnavailable).toBe(false);
  });

  it('an ENDED claim is retained: no premature restore until an independent reset', () => {
    const segments = segs([
      ['OFF_DUTY', '2026-10-18T02:00:00Z', '2026-10-18T12:00:00Z'],
      ['ON_DUTY', '2026-10-18T12:00:00Z', '2026-10-18T13:00:00Z'],
      ['DRIVING', '2026-10-18T13:00:00Z', '2026-10-18T15:00:00Z'], // claimed work
      ['OFF_DUTY', '2026-10-18T20:00:00Z', '2026-10-19T06:00:00Z'], // 10h reset AFTER claim end
      ['DRIVING', '2026-10-19T06:00:00Z', '2026-10-19T08:00:00Z'],
    ]);
    const now = D('2026-10-19T18:00:00Z');
    const hos = hosFor(segments, now);
    const claim = {
      id: 'claim-old', basis: 'agricultural_commodity_395_1_k_1',
      start_timestamp: '2026-10-18T13:00:00Z', end_timestamp: '2026-10-18T15:00:00Z', status: 'ended',
      ended_at: '2026-10-18T15:00:00Z',
    };
    // Span from governing reference (06:00Z reset end) to now excludes the claim:
    // independently determinable → numeric.
    const ev1 = evaluateAgriculturalClocks({ claims: [claim], events: [], hos, cycleType: '70_8', tz: TZ, now });
    expect(ev1.clocks.driving.unavailable).toBe(false);

    // Same ended claim, but viewed BEFORE the later reset exists: still unavailable.
    const nowEarly = D('2026-10-18T19:00:00Z');
    const segmentsEarly = segs([
      ['OFF_DUTY', '2026-10-18T02:00:00Z', '2026-10-18T12:00:00Z'],
      ['ON_DUTY', '2026-10-18T12:00:00Z', '2026-10-18T13:00:00Z'],
      ['DRIVING', '2026-10-18T13:00:00Z', '2026-10-18T15:00:00Z'],
      ['OFF_DUTY', '2026-10-18T15:00:00Z', '2026-10-18T19:00:00Z'],
    ]);
    const hosEarly = hosFor(segmentsEarly, nowEarly);
    const ev2 = evaluateAgriculturalClocks({ claims: [claim], events: [], hos: hosEarly, cycleType: '70_8', tz: TZ, now: nowEarly });
    expect(ev2.clocks.driving.unavailable).toBe(true);
    expect(ev2.anyUnavailable).toBe(true);
  });

  it('marks the cycle unavailable when claimed work falls in the lookback window', () => {
    const hos = hosFor(BASE_SEGMENTS);
    const ev = evaluateAgriculturalClocks({ claims: [CLAIM_A], events: [], hos, cycleType: '70_8', tz: TZ, now: NOW });
    expect(ev.clocks.cycle.unavailable).toBe(true);
  });

  it('past-day claim outside the current clock history leaves clocks numeric', () => {
    const hos = hosFor(BASE_SEGMENTS);
    const ev = evaluateAgriculturalClocks({ claims: [CLAIM_PAST_DAY], events: [], hos, cycleType: '70_8', tz: TZ, now: NOW });
    expect(ev.anyUnavailable).toBe(false);
  });

  it('suppresses split projections when a claim overlaps split rest history', () => {
    const segments = segs([
      ['OFF_DUTY', '2026-10-18T02:00:00Z', '2026-10-18T12:00:00Z'],
      ['ON_DUTY', '2026-10-18T12:00:00Z', '2026-10-18T13:00:00Z'],
      ['DRIVING', '2026-10-18T13:00:00Z', '2026-10-18T15:00:00Z'],
      ['SLEEPER_BERTH', '2026-10-18T15:00:00Z', '2026-10-18T23:00:00Z'], // 8h split member
      ['DRIVING', '2026-10-18T23:00:00Z', '2026-10-19T02:00:00Z'],
    ]);
    const now = D('2026-10-19T04:00:00Z');
    const hos = hosFor(segments, now);
    const claim = {
      id: 'claim-split', basis: 'agricultural_commodity_395_1_k_1',
      start_timestamp: '2026-10-18T15:00:00Z', end_timestamp: '2026-10-18T18:00:00Z', status: 'active',
    };
    const ev = evaluateAgriculturalClocks({ claims: [claim], events: [], hos, cycleType: '70_8', tz: TZ, now });
    expect(ev.clocks.split.unavailable).toBe(true);
  });
});

describe('applyAgriculturalAvailability', () => {
  it('gates affected clocks without recomputing any engine math', () => {
    const hos = hosFor(BASE_SEGMENTS);
    const ev = evaluateAgriculturalClocks({ claims: [CLAIM_A], events: [], hos, cycleType: '70_8', tz: TZ, now: NOW });
    const eff = applyAgriculturalAvailability(hos, ev);
    expect(eff.driving.applicable).toBe(false);
    expect(eff.driving.agriculturalUnavailable).toBe(true);
    expect(eff.window14.applicable).toBe(false);
    expect(eff.cycle.cycleRemainingHours).toBeNull();
    // Unaffected restart stays untouched.
    expect(eff.restart).toEqual(hos.restart);
    // Engine result itself is never mutated.
    expect(hos.driving.applicable).toBe(true);
  });

  it('is a no-op without claims', () => {
    const hos = hosFor(BASE_SEGMENTS);
    expect(applyAgriculturalAvailability(hos, { anyUnavailable: false, clocks: null })).toBe(hos);
  });
});

describe('availabilityUndeterminedSummary', () => {
  it('never yields a numeric drive clearance', () => {
    const hos = hosFor(BASE_SEGMENTS);
    const ev = evaluateAgriculturalClocks({ claims: [CLAIM_A], events: [], hos, cycleType: '70_8', tz: TZ, now: NOW });
    const s = availabilityUndeterminedSummary(ev);
    expect(s).toContain('Availability undetermined');
    expect(s).toContain(AGRICULTURAL_DISABLED_NOTICE);
    expect(/11-hour/.test(s)).toBe(true);
  });
});

describe('claimsOnDate', () => {
  it('matches claims overlapping the local log date', () => {
    const day = claimsOnDate([CLAIM_A], '2026-10-19', TZ);
    expect(day.map(c => c.id)).toContain('claim-a');
    const none = claimsOnDate([CLAIM_PAST_DAY], '2026-10-19', TZ);
    expect(none).toHaveLength(0);
  });
});

describe('basisLabel', () => {
  it('uses the exact 395.1(k)(4) destination wording', () => {
    expect(basisLabel('livestock_final_destination_395_1_k_4')).toMatch(/final destination/i);
    expect(basisLabel('agricultural_commodity_395_1_k_1')).toMatch(/395\.1\(k\)\(1\)/);
  });
});

describe('no-claim regression', () => {
  it('applyAgriculturalAvailability leaves standard HOS byte-identical', () => {
    const hos = hosFor(BASE_SEGMENTS);
    const eff = applyAgriculturalAvailability(hos, evaluateAgriculturalClocks({ claims: [], events: [], hos, cycleType: '70_8', tz: TZ, now: NOW }));
    expect(eff).toBe(hos);
  });
});