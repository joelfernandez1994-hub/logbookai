import { describe, it, expect, vi, beforeEach } from 'vitest';
import { computeProposalTotals, addRouteWarning, enrichProposalMileage, sameLocation } from './proposalValidation';
import { dailyTotals } from './timelineEngine';
import { computeHOS } from './hosEngine';

const DAY = '2026-08-20';
const TZ = 'America/New_York';
const H = 3600000;
const base = new Date(`${DAY}T00:00:00-04:00`);
const iso = (hours) => new Date(base.getTime() + hours * H).toISOString();
const event = (status, start, end, city, state = 'FL') => ({ duty_status: status, start_timestamp: iso(start), end_timestamp: iso(end), city, state });
const proposal = [
  event('OFF_DUTY', 0, .5, 'Miami'),
  event('SLEEPER_BERTH', .5, 8, 'Miami'),
  event('ON_DUTY', 8, 8.25, 'Miami'),
  event('DRIVING', 8.25, 10.25, 'Miami'),
  event('ON_DUTY', 10.25, 10.5, 'Fort Pierce'),
  event('DRIVING', 10.5, 13, 'Fort Pierce'),
  event('ON_DUTY', 13, 13.25, 'Orlando'),
  event('DRIVING', 13.25, 16.25, 'Orlando'),
  event('ON_DUTY', 16.25, 16.5, 'Ocala'),
  event('DRIVING', 16.5, 19, 'Ocala'),
  event('ON_DUTY', 19, 19.25, 'Gainesville'),
  event('SLEEPER_BERTH', 19.25, 24, 'Gainesville'),
];

describe('proposal-only totals', () => {
  it('totals a complete proposed day without clipping to wall-clock time', () => {
    const totals = computeProposalTotals(proposal, DAY, TZ);
    expect(totals).toMatchObject({ OFF_DUTY: .5, SLEEPER_BERTH: 12.25, DRIVING: 10, ON_DUTY: 1.25, totalHours: 24 });
  });

  it('keeps live current-day clipping unchanged', () => {
    const now = new Date(`${DAY}T12:00:00-04:00`);
    expect(dailyTotals(proposal, DAY, TZ, now).totalHours).toBeCloseTo(12, 4);
    expect(computeProposalTotals(proposal, DAY, TZ).totalHours).toBe(24);
  });

  it('clips an open rest-of-day event for totals without persisting an artificial end', () => {
    const open = [...proposal.slice(0, -1), { ...proposal.at(-1), end_timestamp: null, activity_type: 'Rest of day', remark: 'Off duty rest of day', is_ongoing: true }];
    const totals = computeProposalTotals(open, DAY, TZ, new Date(`${DAY}T20:00:00-04:00`));
    expect(open.at(-1).end_timestamp).toBeNull();
    expect(totals.SLEEPER_BERTH).toBe(12.25);
    expect(totals.totalHours).toBe(24);
  });

  it('clips a generic open event to the evaluation boundary', () => {
    const open = [event('OFF_DUTY', 0, 8, 'Miami'), { ...event('DRIVING', 8, 9, 'Miami'), end_timestamp: null, is_ongoing: true }];
    const totals = computeProposalTotals(open, DAY, TZ, new Date(`${DAY}T12:00:00-04:00`));
    expect(totals.DRIVING).toBe(4);
    expect(totals.totalHours).toBe(12);
  });
});

describe('proposal routes and mileage', () => {
  const routes = {
    'Miami, FL|Fort Pierce, FL': 130,
    'Fort Pierce, FL|Orlando, FL': 125,
    'Orlando, FL|Ocala, FL': 80,
    'Ocala, FL|Gainesville, FL': 40,
  };
  const provider = vi.fn(async (origin, destination) => ({ miles: routes[`${origin}|${destination}`], hours: 2 }));

  beforeEach(() => provider.mockClear());

  it('uses each drive origin and the next event destination', async () => {
    const result = await enrichProposalMileage(proposal, { routingProvider: provider });
    expect(provider.mock.calls).toEqual([
      ['Miami, FL', 'Fort Pierce, FL'], ['Fort Pierce, FL', 'Orlando, FL'],
      ['Orlando, FL', 'Ocala, FL'], ['Ocala, FL', 'Gainesville, FL'],
    ]);
    expect(result.events.filter(e => e.duty_status === 'DRIVING').map(e => e.mileage)).toEqual([130, 125, 80, 40]);
    expect(result.totalMiles).toBe(375);
  });

  it('normalizes whitespace for same-location checks', () => {
    expect(sameLocation(' Miami ', ' FL ', 'Miami', 'FL')).toBe(true);
  });

  it('flags a multi-hour approximately zero-mile route', async () => {
    const events = [event('DRIVING', 8, 11, 'Miami', ' FL '), event('ON_DUTY', 11, 12, 'Fort Pierce')];
    const warning = await addRouteWarning(events, { routingProvider: async () => ({ miles: 0, hours: 0 }), isFuture: true });
    expect(warning.severity).toBe('blocking');
    expect(warning.message).toMatch(/approximately 0 mi/i);
  });

  it('does not change deterministic HOS output while enriching proposal metadata', async () => {
    const now = new Date(iso(24));
    const before = computeHOS(proposal, '70_8', TZ, now, { historyComplete: true });
    const enriched = await enrichProposalMileage(proposal, { routingProvider: provider });
    const after = computeHOS(enriched.events, '70_8', TZ, now, { historyComplete: true });
    expect(after.driving.drivingRemainingMs).toBe(before.driving.drivingRemainingMs);
    expect(after.window14.remainingMs).toBe(before.window14.remainingMs);
    expect(after.cycle.cycleRemainingHours).toBe(before.cycle.cycleRemainingHours);
  });
});

// ============================================================================
// REGRESSION: an ongoing/destinationless Driving event must never generate
// fabricated mileage (neither a road route lookup nor an elapsed-time x
// assumed-mph estimate). Live bug: "12:00–6:00 OFF DUTY — Miami / 6:00–6:15
// ON DUTY — Pre-Trip / 6:15→ongoing DRIVING — Miami" (driver never gave a
// destination) produced "911.3 mi (estimated fallback)" — elapsed Driving
// hours (~16.57h) x the conservative 55 mph fallback speed
// (proposalValidation.fallbackMph), computed unconditionally in
// enrichProposalMileage regardless of whether a real destination existed.
// Fixed via canEstimateMileage(leg): the elapsed-time x speed ESTIMATE is
// only ever used when destinationKnown && !isOngoing — a real, completed
// leg whose road-route lookup itself failed. Otherwise mileage stays
// mileage:null / mileage_source:'unknown', never a fabricated number.
// ============================================================================
describe('mileage rule — ongoing/destinationless Driving never gets fabricated mileage', () => {
  const neverCalled = vi.fn(async () => { throw new Error('routing provider should never be called for an ongoing/destinationless leg'); });

  it('1. ongoing Driving with no destination -> no route mileage (routing provider never even invoked for that leg)', async () => {
    const events = [
      event('OFF_DUTY', 0, 6, 'Miami'),
      event('ON_DUTY', 6, 6.25, 'Miami'),
      { ...event('DRIVING', 6.25, null, 'Miami'), end_timestamp: null, is_ongoing: true },
    ];
    const result = await enrichProposalMileage(events, { routingProvider: neverCalled, now: new Date(iso(22.75)) }); // ~16.5h elapsed
    expect(neverCalled).not.toHaveBeenCalled();
    const driving = result.events.find((e) => e.duty_status === 'DRIVING');
    expect(driving.mileage).toBeNull();
    expect(driving.mileage_source).toBe('unknown');
  });

  it('2. destinationless Driving (even if NOT ongoing — no genuine following non-driving event) -> no speed x time fallback mileage', async () => {
    // The Driving event has an end_timestamp (not ongoing), but nothing
    // after it supplies a real destination city — getDrivingLegs falls back
    // to the Driving event's OWN city (destinationKnown: false), which must
    // never be treated as "we know where this trip ended".
    const events = [
      event('OFF_DUTY', 0, 6, 'Miami'),
      event('DRIVING', 6, 9, 'Miami'), // 3h driving, ends with nothing after it
    ];
    const result = await enrichProposalMileage(events, { routingProvider: neverCalled });
    expect(neverCalled).not.toHaveBeenCalled();
    const driving = result.events.find((e) => e.duty_status === 'DRIVING');
    expect(driving.mileage).toBeNull();
    expect(driving.mileage_source).toBe('unknown');
  });

  it('3. proposed daily mileage (totalMiles) excludes unknown mileage entirely — never coerces null to a counted 0-that-looks-real or a fabricated number', async () => {
    const events = [
      event('OFF_DUTY', 0, 6, 'Miami'),
      event('ON_DUTY', 6, 6.25, 'Miami'),
      event('DRIVING', 6.25, 8.25, 'Miami'), // known route leg
      event('ON_DUTY', 8.25, 8.5, 'Fort Pierce'),
      { ...event('DRIVING', 8.5, null, 'Fort Pierce'), end_timestamp: null, is_ongoing: true }, // ongoing, no destination
    ];
    const knownRouteProvider = vi.fn(async (origin, destination) =>
      (origin === 'Miami, FL' && destination === 'Fort Pierce, FL') ? { miles: 130, hours: 2 } : null);
    const result = await enrichProposalMileage(events, { routingProvider: knownRouteProvider, now: new Date(iso(10)) });
    expect(result.totalMiles).toBe(130); // only the completed, known-destination leg counts
  });

  it('4. Driving remains ongoing — the mileage fix never touches end_timestamp/is_ongoing', async () => {
    const events = [{ ...event('DRIVING', 6.25, null, 'Miami'), end_timestamp: null, is_ongoing: true }];
    const result = await enrichProposalMileage(events, { routingProvider: neverCalled });
    const driving = result.events[0];
    expect(driving.end_timestamp).toBeNull();
    expect(driving.is_ongoing).toBe(true);
  });

  it('5. HOS still evaluates elapsed Driving time normally for an ongoing, mileage-unknown event', async () => {
    // A qualifying 10h+ reset (rather than the 6h used elsewhere in this
    // file, which is fine when a test doesn't depend on exact clock values)
    // makes the tour-start boundary unambiguous, so the expected remaining
    // drive time below is exact and not dependent on hosEngine's own
    // contiguous-governing-reset heuristics.
    const events = [
      event('OFF_DUTY', 0, 10, 'Miami'),
      event('ON_DUTY', 10, 10.25, 'Miami'),
      { ...event('DRIVING', 10.25, null, 'Miami'), end_timestamp: null, is_ongoing: true },
    ];
    const now = new Date(iso(14)); // 3h45m of elapsed driving
    const enriched = await enrichProposalMileage(events, { routingProvider: neverCalled, now });
    const hos = computeHOS(enriched.events, '70_8', TZ, now, { historyComplete: true });
    expect(hos.calculable).toBe(true);
    // 11h limit minus 3.75h driven so far — HOS math is entirely independent
    // of the (now-null) mileage field.
    expect(hos.driving.drivingRemainingMs).toBeCloseTo((11 - 3.75) * H, -3);
  });

  it('6. origin + destination Driving can still use route-estimated mileage (completed leg, real destination)', async () => {
    const events = [event('DRIVING', 6.25, 8.25, 'Miami'), event('ON_DUTY', 8.25, 8.5, 'Fort Pierce')];
    const routeProvider = vi.fn(async () => ({ miles: 130, hours: 2 }));
    const result = await enrichProposalMileage(events, { routingProvider: routeProvider });
    expect(routeProvider).toHaveBeenCalled();
    expect(result.events[0].mileage).toBe(130);
    expect(result.events[0].mileage_source).toBe('route');
  });

  it('6b. a completed, known-destination leg whose route lookup FAILS still falls back to a labeled speed x time ESTIMATE (never "unknown" for a leg that genuinely happened with a known endpoint)', async () => {
    const events = [event('DRIVING', 6.25, 8.25, 'Miami'), event('ON_DUTY', 8.25, 8.5, 'Fort Pierce')];
    const failingProvider = vi.fn(async () => null); // routing service unavailable
    const result = await enrichProposalMileage(events, { routingProvider: failingProvider });
    const driving = result.events[0];
    expect(driving.mileage_source).toBe('estimate');
    expect(driving.mileage).toBeGreaterThan(0); // 2h x fallback mph — a real, completed, known-destination trip
  });
});