// Regression tests for getDrivingLegs route-leg derivation.
// Scope: getDrivingLegs + its interaction with inspectProposalRoutes /
// addRouteWarning / reconstructDrivingDurations. No HOS, timelineWriter,
// provenance schema, prompt, or tolerance changes are exercised here.
import { describe, it, expect, vi } from 'vitest';
import {
  getDrivingLegs,
  inspectProposalRoutes,
  addRouteWarning,
  validateProposal,
  deriveHosDisplay,
} from './proposalValidation';
import { reconstructDrivingDurations } from './drivingDurationReconstruction';
import { nextLocalMidnightInTz } from './timelineEngine';

const H = 3600000;
const base = new Date('2026-08-27T00:00:00-04:00');
const iso = (h) => new Date(base.getTime() + h * H).toISOString();

// Midwest 9-event fixture reproducing the stored AIProposal convention:
// the AI stores the DESTINATION city/state on each Driving event, and the
// following non-driving event is the arrival at that same destination.
// Driving ends are inferred (short); non-driving anchors are explicit.
const midwest = [
  { duty_status: 'OFF_DUTY', start_timestamp: iso(0), end_timestamp: iso(5.5), city: 'Chicago', state: 'Illinois', field_provenance: { start_time: 'explicit', end_time: 'explicit' } },
  { duty_status: 'ON_DUTY', start_timestamp: iso(5.5), end_timestamp: iso(5.75), city: 'Chicago', state: 'Illinois', activity_type: 'Pre-Trip', field_provenance: { start_time: 'explicit', end_time: 'explicit' } },
  { duty_status: 'DRIVING', start_timestamp: iso(5.75), end_timestamp: iso(6.25), city: 'South Bend', state: 'Indiana', field_provenance: { start_time: 'inferred', end_time: 'inferred' } },
  { duty_status: 'ON_DUTY', start_timestamp: iso(6.5), end_timestamp: iso(7.0), city: 'South Bend', state: 'Indiana', activity_type: 'Fuel', field_provenance: { start_time: 'explicit', end_time: 'explicit' } },
  { duty_status: 'DRIVING', start_timestamp: iso(7.0), end_timestamp: iso(7.5), city: 'Toledo', state: 'Ohio', field_provenance: { start_time: 'inferred', end_time: 'inferred' } },
  { duty_status: 'ON_DUTY', start_timestamp: iso(7.75), end_timestamp: iso(9.5), city: 'Toledo', state: 'Ohio', activity_type: 'Unloading', field_provenance: { start_time: 'explicit', end_time: 'explicit' } },
  { duty_status: 'DRIVING', start_timestamp: iso(9.5), end_timestamp: iso(10.0), city: 'Detroit', state: 'Michigan', field_provenance: { start_time: 'inferred', end_time: 'inferred' } },
  { duty_status: 'ON_DUTY', start_timestamp: iso(10.25), end_timestamp: iso(10.5), city: 'Detroit', state: 'Michigan', activity_type: 'Post-Trip', field_provenance: { start_time: 'explicit', end_time: 'explicit' } },
  { duty_status: 'OFF_DUTY', start_timestamp: iso(10.5), end_timestamp: iso(24), city: 'Detroit', state: 'Michigan', field_provenance: { start_time: 'explicit', end_time: 'explicit' } },
];

const expectedLegs = [
  { origin: { city: 'Chicago', state: 'ILLINOIS' }, destination: { city: 'South Bend', state: 'INDIANA' } },
  { origin: { city: 'South Bend', state: 'INDIANA' }, destination: { city: 'Toledo', state: 'OHIO' } },
  { origin: { city: 'Toledo', state: 'OHIO' }, destination: { city: 'Detroit', state: 'MICHIGAN' } },
];

// Realistic mock routes for the three Midwest legs (miles, provider hours).
const mockRoutes = {
  'Chicago, Illinois|South Bend, Indiana': { miles: 140, hours: 2.4 },
  'South Bend, Indiana|Toledo, Ohio': { miles: 130, hours: 2.2 },
  'Toledo, Ohio|Detroit, Michigan': { miles: 115, hours: 2.0 },
};
const mockProvider = vi.fn(async (origin, destination) => {
  return mockRoutes[`${origin}|${destination}`] || { miles: 100, hours: 1.8 };
});

describe('getDrivingLegs — Midwest destination-on-Driving convention', () => {
  it('derives the three real legs from non-driving neighbors, not same-city', () => {
    const legs = getDrivingLegs(midwest);
    expect(legs).toHaveLength(3);
    legs.forEach((leg, i) => {
      expect(leg.origin).toEqual(expectedLegs[i].origin);
      expect(leg.destination).toEqual(expectedLegs[i].destination);
    });
  });

  it('produces no same-city leg (origin !== destination)', () => {
    const legs = getDrivingLegs(midwest);
    for (const leg of legs) {
      const same =
        leg.origin.city.toLowerCase() === leg.destination.city.toLowerCase();
      expect(same).toBe(false);
    }
  });
});

describe('inspectProposalRoutes — tripEstimate invoked for real legs only', () => {
  it('calls the routing provider exactly 3 times with the three real pairs', async () => {
    mockProvider.mockClear();
    const legs = await inspectProposalRoutes(midwest, { routingProvider: mockProvider, speedProfile: 'conservative', now: base });
    expect(mockProvider).toHaveBeenCalledTimes(3);
    const calls = mockProvider.mock.calls.map((c) => [c[0], c[1]]);
    expect(calls).toContainEqual(['Chicago, Illinois', 'South Bend, Indiana']);
    expect(calls).toContainEqual(['South Bend, Indiana', 'Toledo, Ohio']);
    expect(calls).toContainEqual(['Toledo, Ohio', 'Detroit, Michigan']);
    for (const [o, d] of calls) {
      expect(o).not.toBe(d);
    }
  });

  it('each leg has requiredTruckTime > 0', async () => {
    mockProvider.mockClear();
    const legs = await inspectProposalRoutes(midwest, { routingProvider: mockProvider, speedProfile: 'conservative', now: base });
    for (const leg of legs) {
      expect(leg.evaluation.requiredTruckTime).toBeGreaterThan(0);
    }
  });
});

describe('Fix route timing — reconstruction produces real changes', () => {
  it('reconstructs inferred Driving ends to routed truck time (_route_derived_duration set)', async () => {
    const legs = await inspectProposalRoutes(midwest, { routingProvider: mockProvider, speedProfile: 'conservative', now: base });
    const { events: corrected } = reconstructDrivingDurations(midwest, legs, { now: base });
    const changed = corrected.filter((e) => e._route_derived_duration === true);
    expect(changed.length).toBeGreaterThan(0);
    for (const drive of midwest.filter((e) => e.duty_status === 'DRIVING')) {
      const before = drive.end_timestamp;
      const after = corrected.find((e) => e.start_timestamp === drive.start_timestamp)?.end_timestamp;
      // At least one inferred Driving end moved to the routed time.
      if (after && before && after !== before) expect(after).not.toBe(before);
    }
  });

  it('after reconstruction, no same-city route conflict remains', async () => {
    const legs = await inspectProposalRoutes(midwest, { routingProvider: mockProvider, speedProfile: 'conservative', now: base });
    const { events: corrected } = reconstructDrivingDurations(midwest, legs, { now: base });
    const freshLegs = await inspectProposalRoutes(corrected, { routingProvider: mockProvider, speedProfile: 'conservative', now: base });
    const sameCity = freshLegs.filter((leg) =>
      leg.route && leg.route.miles === 0 && leg.route.hours === 0 &&
      leg.origin && leg.destination && leg.origin === leg.destination
    );
    expect(sameCity).toHaveLength(0);
    const warning = await addRouteWarning(corrected, { legs: freshLegs, now: base, isFuture: false });
    expect(warning).not.toBeNull();
  });

  it('explicit timestamps are byte-identical before and after reconstruction', async () => {
    const legs = await inspectProposalRoutes(midwest, { routingProvider: mockProvider, speedProfile: 'conservative', now: base });
    const { events: corrected } = reconstructDrivingDurations(midwest, legs, { now: base });
    for (let i = 0; i < midwest.length; i++) {
      const before = midwest[i];
      const after = corrected[i];
      const prov = before.field_provenance || {};
      if (prov.start_time === 'explicit') expect(after.start_timestamp).toBe(before.start_timestamp);
      if (prov.end_time === 'explicit' && before.end_timestamp) expect(after.end_timestamp).toBe(before.end_timestamp);
    }
  });
});

describe('getDrivingLegs — conservative fallback edges', () => {
  const drive = (s, e, city, state) => ({
    duty_status: 'DRIVING', start_timestamp: iso(s), end_timestamp: e == null ? null : iso(e), city, state,
    field_provenance: { start_time: 'inferred', end_time: 'inferred' },
  });
  const nonDrive = (status, s, e, city, state) => ({
    duty_status: status, start_timestamp: iso(s), end_timestamp: e == null ? null : iso(e), city, state,
    field_provenance: { start_time: 'explicit', end_time: 'explicit' },
  });

  it('a lone Driving event falls back to its own city for both sides (same-city, degenerate)', () => {
    const legs = getDrivingLegs([drive(1, 2, 'Omaha', 'Nebraska')]);
    expect(legs).toHaveLength(1);
    expect(legs[0].origin).toEqual({ city: 'Omaha', state: 'NEBRASKA' });
    expect(legs[0].destination).toEqual({ city: 'Omaha', state: 'NEBRASKA' });
  });

  it('Driving with only a following non-driving event: own-origin → following-destination', () => {
    const legs = getDrivingLegs([
      drive(1, 2, 'Lincoln', 'Nebraska'),
      nonDrive('ON_DUTY', 2.1, 2.5, 'Omaha', 'Nebraska'),
    ]);
    expect(legs).toHaveLength(1);
    expect(legs[0].origin).toEqual({ city: 'Lincoln', state: 'NEBRASKA' });
    expect(legs[0].destination).toEqual({ city: 'Omaha', state: 'NEBRASKA' });
  });

  it('Driving with only a preceding non-driving event: preceding-origin → own-destination', () => {
    const legs = getDrivingLegs([
      nonDrive('OFF_DUTY', 0, 1, 'Des Moines', 'Iowa'),
      drive(1, 2, 'Cedar Rapids', 'Iowa'),
    ]);
    expect(legs).toHaveLength(1);
    expect(legs[0].origin).toEqual({ city: 'Des Moines', state: 'IOWA' });
    expect(legs[0].destination).toEqual({ city: 'Cedar Rapids', state: 'IOWA' });
  });

  it('consecutive Driving events with no non-driving event between fall back to each own city (no chaining)', () => {
    const legs = getDrivingLegs([
      drive(1, 2, 'Kansas City', 'Missouri'),
      drive(2, 3, 'St Louis', 'Missouri'),
    ]);
    expect(legs).toHaveLength(2);
    // First Driving: no preceding non-driving neighbor → own origin; following
    // neighbor is a Driving event (excluded) → own destination.
    expect(legs[0].origin).toEqual({ city: 'Kansas City', state: 'MISSOURI' });
    expect(legs[0].destination).toEqual({ city: 'Kansas City', state: 'MISSOURI' });
    // Second Driving: preceding neighbor is a Driving event (excluded) → own
    // origin; no following neighbor → own destination. Never chains to Kansas City.
    expect(legs[1].origin).toEqual({ city: 'St Louis', state: 'MISSOURI' });
    expect(legs[1].destination).toEqual({ city: 'St Louis', state: 'MISSOURI' });
  });
});

// ============================================================================
// ProposalReview 14h-window artifact fix — contiguous backward-walk governing
// anchor, DST-correct eval endpoint, most-recent split wins (≥7h sleeper +
// ≥2h second period, combined ≥10h), ≥10h reset fallback, unverified state at
// continuity boundaries, inferred-rest note. Carrier tz = America/Chicago
// (CDT, UTC-5 in August) for the Midwest case.
// ============================================================================

const CHI = 'America/Chicago';
const z = (iso) => new Date(iso).toISOString();
// Chicago CDT (UTC-5): local 05:00 = 10:00Z, 05:30 = 10:30Z, 05:45 = 10:45Z,
// 00:00 = 05:00Z, 11:30 = 16:30Z, 12:00 = 17:00Z, 19:00(prev day) = 00:00Z.
const drive = (s, e, city, st, prov) => ({
  duty_status: 'DRIVING', start_timestamp: z(s), end_timestamp: z(e), city, state: st,
  field_provenance: prov || { start_time: 'explicit', end_time: 'explicit' },
});
const offDuty = (s, e, prov) => ({
  duty_status: 'OFF_DUTY', start_timestamp: z(s), end_timestamp: z(e), city: 'Chicago', state: 'Illinois',
  field_provenance: prov || { start_time: 'explicit', end_time: 'explicit' },
});
const sleeper = (s, e, prov) => ({
  duty_status: 'SLEEPER_BERTH', start_timestamp: z(s), end_timestamp: z(e), city: 'Chicago', state: 'Illinois',
  field_provenance: prov || { start_time: 'explicit', end_time: 'explicit' },
});
const onDuty = (s, e, act, prov) => ({
  duty_status: 'ON_DUTY', start_timestamp: z(s), end_timestamp: z(e), city: 'Chicago', state: 'Illinois',
  activity_type: act, remark: act,
  field_provenance: prov || { start_time: 'explicit', end_time: 'explicit' },
});

const has14hViolation = (v) => v.violations.some((x) => x.rule === '14-Hour Driving Window');
const has11hViolation = (v) => v.violations.some((x) => x.rule === '11-Hour Driving Limit');
const winState = (v) => deriveHosDisplay(v.hos, v.historyComplete).window14.state;
const driveState = (v) => deriveHosDisplay(v.hos, v.historyComplete).driving.state;
const inferredRestNote = (v) => v.warnings.find((w) => w.type === 'inferred_rest_start');

describe('ProposalReview 14h-window artifact — contiguous backward walk', () => {
  it('T1: multi-day gap before proposal → unverified, no 50h+ 14h violation (contiguity stop)', () => {
    // Stale ≥10h rest only at 08-25 03:59Z (days back). Proposal on 08-27 with
    // an inferred overnight off-duty (5.5h) immediately before driving. The
    // walk reaches the overnight (not a 10h reset, no valid split), then hits
    // the timeline gap to 08-25 → stops → unverified. The 08-25 rest is NOT
    // reached, so no cross-day overage is manufactured.
    const existing = [
      offDuty('2026-08-24T17:59:00Z', '2026-08-25T03:59:00Z'), // ≥10h rest, days back
      onDuty('2026-08-25T03:59:00Z', '2026-08-25T04:59:00Z', 'Loading'),
    ];
    const proposed = [
      offDuty('2026-08-27T05:00:00Z', '2026-08-27T10:30:00Z', { start_time: 'inferred', end_time: 'explicit' }), // overnight 00:00→05:30 local
      onDuty('2026-08-27T10:30:00Z', '2026-08-27T10:45:00Z', 'Pre-Trip'),
      drive('2026-08-27T10:45:00Z', '2026-08-27T16:45:00Z', 'Toledo', 'Ohio'), // 05:45→11:45 local
    ];
    const v = validateProposal(existing, proposed, { cycleType: '70_8', tz: CHI, now: new Date('2026-08-27T16:45:00Z'), enteredPriorHistory: true });
    expect(has14hViolation(v)).toBe(false);
    expect(winState(v)).toBe('unverified');
    expect(v.contiguousGov.unverified).toBe(true);
  });

  it('T2: contiguous ≥10h anchor → real within-day window, never cross-day', () => {
    // ≥10h rest ending 08-27 05:00 local (10:00Z), contiguous with overnight
    // 05:00→05:30 local up to firstDrive at 05:30. No valid split → walk finds
    // the merged ≥10h reset → governing reset; window14 elapsed is within-day.
    const existing = [
      offDuty('2026-08-27T00:00:00Z', '2026-08-27T10:00:00Z'), // 19:00→05:00 local = 10h
    ];
    const proposed = [
      offDuty('2026-08-27T10:00:00Z', '2026-08-27T10:30:00Z'), // 05:00→05:30 local = 0.5h
      drive('2026-08-27T10:30:00Z', '2026-08-27T16:30:00Z', 'Toledo', 'Ohio'), // 05:30→11:30 = 6h
    ];
    const v = validateProposal(existing, proposed, { cycleType: '70_8', tz: CHI, now: new Date('2026-08-27T16:30:00Z'), enteredPriorHistory: true });
    expect(has14hViolation(v)).toBe(false);
    expect(winState(v)).toBe('real');
    expect(v.contiguousGov.unverified).toBe(false);
    // Window measured from the contiguous reset end, never from days back.
    const rem = v.hos.window14.remainingMs;
    expect(rem).toBeGreaterThan(0);
  });

  it('T4: inferred overnight <10h with older contiguous ≥10h anchor → uses anchor + inferred-rest note', () => {
    // Explicit ≥10h rest 08-26 14:00→08-27 00:00 local (08-26T19:00Z→08-27T05:00Z
    // = 10h), contiguous with an overnight off-duty 00:00→05:30 local
    // (08-27T05:00Z→10:30Z, 5.5h, INFERRED start), then drive at 05:30. The
    // merged rest is ≥10h so a governing anchor exists contiguously → NOT
    // unverified. The overnight start was inferred → the review note flags it.
    const existing = [
      offDuty('2026-08-26T19:00:00Z', '2026-08-27T05:00:00Z'), // 14:00→00:00 local = 10h explicit
    ];
    const proposed = [
      offDuty('2026-08-27T05:00:00Z', '2026-08-27T10:30:00Z', { start_time: 'inferred', end_time: 'explicit' }), // 5.5h inferred start
      drive('2026-08-27T10:30:00Z', '2026-08-27T16:30:00Z', 'Toledo', 'Ohio'), // 6h
    ];
    const v = validateProposal(existing, proposed, { cycleType: '70_8', tz: CHI, now: new Date('2026-08-27T16:30:00Z'), enteredPriorHistory: true });
    expect(v.contiguousGov.unverified).toBe(false);
    expect(winState(v)).not.toBe('unverified');
    expect(has14hViolation(v)).toBe(false);
    const note = inferredRestNote(v);
    expect(note).toBeTruthy();
    expect(note.message).toBe('Rest period start was inferred — verify.');
  });

  it('T5: past proposal day → evalNow capped at next local midnight, never device now', () => {
    // Proposal log date 08-25; device now is 08-27 (after the day). evalNow must
    // equal the next local midnight after 08-25 (08-26 00:00 local = 05:00Z),
    // NOT the device clock, so the ongoing final event runs to end-of-log-day.
    const proposed = [
      drive('2026-08-25T09:00:00Z', '2026-08-25T15:00:00Z', 'Toledo', 'Ohio'),
    ];
    const existing = [
      offDuty('2026-08-24T17:59:00Z', '2026-08-25T03:59:00Z'),
    ];
    const v = validateProposal(existing, proposed, { cycleType: '70_8', tz: CHI, now: new Date('2026-08-27T17:00:00Z'), enteredPriorHistory: true });
    const dayEnd = nextLocalMidnightInTz('2026-08-25', CHI); // 08-26 05:00Z
    expect(v.evalNow.getTime()).toBe(dayEnd.getTime());
    expect(v.evalNow.getTime()).toBeLessThan(new Date('2026-08-27T17:00:00Z').getTime());
  });

  it('most-recent valid split-sleeper pair (7/3) wins over a single ≥10h reset further back', () => {
    // A ≥7h sleeper + a 3h off-duty (combined 10h) form a valid split pair
    // that is more recent than a ≥10h reset further back. The split governs —
    // the 14h window is recalculated from the end of the FIRST qualifying
    // period (the sleeper), with the second period excluded.
    const existing = [
      offDuty('2026-08-26T05:00:00Z', '2026-08-26T15:00:00Z'), // ≥10h reset far back
      onDuty('2026-08-26T15:00:00Z', '2026-08-26T16:00:00Z', 'Fuel'),
      drive('2026-08-26T16:00:00Z', '2026-08-26T21:00:00Z', 'Toledo', 'Ohio'), // 5h drive
      sleeper('2026-08-26T21:00:00Z', '2026-08-27T04:00:00Z'), // 7h sleeper (first qualifying)
      drive('2026-08-27T04:00:00Z', '2026-08-27T07:00:00Z', 'Detroit', 'Michigan'), // 3h drive
      offDuty('2026-08-27T07:00:00Z', '2026-08-27T10:00:00Z'), // 3h off-duty (second qualifying, combined 10h)
      drive('2026-08-27T10:00:00Z', '2026-08-27T13:00:00Z', 'Cleveland', 'Ohio'), // first proposed drive
    ];
    const proposed = [
      drive('2026-08-27T10:00:00Z', '2026-08-27T13:00:00Z', 'Cleveland', 'Ohio'),
    ];
    const v = validateProposal(existing, proposed, { cycleType: '70_8', tz: CHI, now: new Date('2026-08-27T14:00:00Z'), enteredPriorHistory: true });
    expect(v.contiguousGov.unverified).toBe(false);
    expect(v.contiguousGov.type).toBe('split');
    // Reference point = end of the first qualifying period (the 7h sleeper).
    expect(v.contiguousGov.referenceTime.getTime()).toBe(new Date('2026-08-27T04:00:00Z').getTime());
    expect(has14hViolation(v)).toBe(false);
  });

  it('split-ambiguity: inferred-boundary rest cannot confirm a split → unverified, not a guessed split', () => {
    // A 7h sleeper and a 3h off-duty WOULD form a split, but the 3h off-duty's
    // end is inferred — the ≥2h/combined-10h membership cannot be confirmed.
    // Skip it; no other qualifying anchor contiguously → unverified (do not
    // guess the split).
    const existing = [
      sleeper('2026-08-27T00:00:00Z', '2026-08-27T07:00:00Z'), // 7h sleeper
      drive('2026-08-27T07:00:00Z', '2026-08-27T08:00:00Z', 'Detroit', 'Michigan'),
      offDuty('2026-08-27T08:00:00Z', '2026-08-27T11:00:00Z', { start_time: 'inferred', end_time: 'inferred' }), // 3h, inferred boundaries
    ];
    const proposed = [
      drive('2026-08-27T11:00:00Z', '2026-08-27T13:00:00Z', 'Cleveland', 'Ohio'),
    ];
    const v = validateProposal(existing, proposed, { cycleType: '70_8', tz: CHI, now: new Date('2026-08-27T14:00:00Z'), enteredPriorHistory: true });
    // The inferred-boundary 3h block is not confirmable for a split; no ≥10h
    // reset exists → contiguous walk yields unverified, never a guessed split.
    expect(v.contiguousGov.unverified).toBe(true);
    expect(v.contiguousGov.type).toBe('unverified');
    expect(has14hViolation(v)).toBe(false);
  });

  it('T3: same-start conflict → no 14h violation reaches across to an older reset', () => {
    // An unresolved same-start conflict makes the timeline invalid. The
    // contiguous walk stops at the conflict boundary, and the 14h/11h checks
    // are suppressed (unverified), so no fabricated cross-day overage is
    // computed from the older ≥10h reset.
    const existing = [
      offDuty('2026-08-24T17:59:00Z', '2026-08-25T03:59:00Z'),
    ];
    const proposed = [
      offDuty('2026-08-27T05:00:00Z', '2026-08-27T10:30:00Z'),
      // Same-start conflict: two statuses at the same instant.
      { duty_status: 'ON_DUTY', start_timestamp: z('2026-08-27T10:30:00Z'), end_timestamp: z('2026-08-27T10:45:00Z'), city: 'Chicago', state: 'Illinois', activity_type: 'Pre-Trip', remark: 'Pre-Trip', field_provenance: { start_time: 'explicit', end_time: 'explicit' } },
      { duty_status: 'DRIVING', start_timestamp: z('2026-08-27T10:30:00Z'), end_timestamp: z('2026-08-27T16:45:00Z'), city: 'Toledo', state: 'Ohio', field_provenance: { start_time: 'explicit', end_time: 'explicit' } },
    ];
    const v = validateProposal(existing, proposed, { cycleType: '70_8', tz: CHI, now: new Date('2026-08-27T17:00:00Z'), enteredPriorHistory: true });
    expect(has14hViolation(v)).toBe(false);
    expect(has11hViolation(v)).toBe(false);
  });
});

describe('nextLocalMidnightInTz — DST-correct next local midnight', () => {
  it('returns the next local midnight instant (CDT)', () => {
    // 08-27 local (Chicago) → next midnight = 08-28 00:00 CDT = 05:00Z.
    expect(nextLocalMidnightInTz('2026-08-27', CHI).toISOString()).toBe('2026-08-28T05:00:00.000Z');
  });

  it('is DST-correct across a spring-forward boundary (America/New_York)', () => {
    // DST 2026 begins 03-08 02:00 (spring forward). 03-07 midnight is still EST
    // (UTC-5); 03-08 midnight is still EST; 03-09 midnight is EDT (UTC-4).
    expect(nextLocalMidnightInTz('2026-03-07', 'America/New_York').toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(nextLocalMidnightInTz('2026-03-08', 'America/New_York').toISOString()).toBe('2026-03-09T04:00:00.000Z');
  });

  it('rolls month/year at end of month', () => {
    // Next midnight after 12-31 is 01-01 00:00 local; Chicago Jan = CST (UTC-6).
    expect(nextLocalMidnightInTz('2026-12-31', CHI).toISOString()).toBe('2027-01-01T06:00:00.000Z');
  });
});