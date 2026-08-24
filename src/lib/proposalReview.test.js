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