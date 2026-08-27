// Regression tests for getDrivingLegs route-leg derivation.
// Scope: getDrivingLegs + its interaction with inspectProposalRoutes /
// addRouteWarning / reconstructDrivingDurations. No HOS, timelineWriter,
// provenance schema, prompt, or tolerance changes are exercised here.
import { describe, it, expect, vi } from 'vitest';
import {
  getDrivingLegs,
  inspectProposalRoutes,
  addRouteWarning,
} from './proposalValidation';
import { reconstructDrivingDurations } from './drivingDurationReconstruction';

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