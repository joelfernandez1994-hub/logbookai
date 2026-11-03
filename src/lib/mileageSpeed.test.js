import { describe, it, expect, vi } from 'vitest';

vi.mock('@/api/base44Client', () => ({ base44: { entities: {}, functions: { invoke: vi.fn() } } }));

import {
  DEFAULT_AVERAGE_MPH,
  MIN_AVERAGE_MPH,
  MAX_AVERAGE_MPH,
  isValidAverageMph,
  resolveAverageMph,
  resolvePreferredMph,
  estimateMilesFromDuration,
  resolveMileage,
  MILEAGE_METHOD,
} from './mileageSpeed';
import { computeDailyMiles } from './tripSync';
import { enrichProposalMileage } from './proposalValidation';

const TZ = 'UTC';
const DAY = '2026-08-20';
const H = 3600000;

// ---------------------------------------------------------------------------
// 1. THE DEFAULT IS 65 MPH
// ---------------------------------------------------------------------------
describe('average driving speed — default 65 MPH', () => {
  it('defaults to 65 when the driver has not chosen a speed', () => {
    expect(DEFAULT_AVERAGE_MPH).toBe(65);
    expect(resolvePreferredMph(null)).toBe(65);
    expect(resolvePreferredMph({})).toBe(65);
    expect(resolvePreferredMph({ legal_name: 'Dana' })).toBe(65);
  });

  it('treats an unset, non-numeric or out-of-range stored value as the 65 default', () => {
    expect(resolveAvg(undefined)).toBe(65);
    expect(resolveAvg(null)).toBe(65);
    expect(resolveAvg('')).toBe(65);
    expect(resolveAvg('abc')).toBe(65);
    expect(resolveAvg(0)).toBe(65);
    expect(resolveAvg(24)).toBe(65);
    expect(resolveAvg(91)).toBe(65);
  });

  it('a 4-hour driving event at the default estimates 260 miles', () => {
    expect(Math.round(estimateMilesFromDuration(4, undefined))).toBe(260);
  });
});

function resolveAvg(v) {
  return resolveAverageMph(v);
}

// ---------------------------------------------------------------------------
// 2. CUSTOM SPEEDS PERSIST AND ARE VALIDATED (25–90 MPH)
// ---------------------------------------------------------------------------
describe('average driving speed — custom value persists', () => {
  it('reads a saved custom speed back from the driver profile', () => {
    expect(resolvePreferredMph({ average_driving_speed_mph: 72 })).toBe(72);
    expect(resolvePreferredMph({ average_driving_speed_mph: '58' })).toBe(58);
  });

  it('accepts the whole 25–90 MPH range and rejects anything outside it', () => {
    expect(MIN_AVERAGE_MPH).toBe(25);
    expect(MAX_AVERAGE_MPH).toBe(90);
    expect(isValidAverageMph(25)).toBe(true);
    expect(isValidAverageMph(90)).toBe(true);
    expect(isValidAverageMph(65)).toBe(true);
    expect(isValidAverageMph(24.9)).toBe(false);
    expect(isValidAverageMph(90.1)).toBe(false);
    expect(isValidAverageMph('')).toBe(false);
    expect(isValidAverageMph('sixty')).toBe(false);
  });

  it('estimate mileage uses the saved custom speed', () => {
    expect(Math.round(estimateMilesFromDuration(4, 70))).toBe(280);
    expect(Math.round(estimateMilesFromDuration(2.5, 50))).toBe(125);
  });
});

// ---------------------------------------------------------------------------
// 3. DURATION-BASED DAILY MILES USE THE PREFERENCE
// ---------------------------------------------------------------------------
describe('daily miles — driving hours x preferred average mph', () => {
  const driveDay = [
    { start_timestamp: `${DAY}T06:00:00.000Z`, end_timestamp: `${DAY}T10:00:00.000Z`, duty_status: 'DRIVING' },
    { start_timestamp: `${DAY}T10:00:00.000Z`, end_timestamp: `${DAY}T12:00:00.000Z`, duty_status: 'ON_DUTY' },
  ];

  it('estimates 260 miles for 4 driving hours at the 65 MPH default', () => {
    expect(Math.round(computeDailyMiles(driveDay, DAY, TZ))).toBe(260);
    expect(Math.round(computeDailyMiles(driveDay, DAY, TZ, undefined))).toBe(260);
  });

  it('estimates with the driver’s preferred speed instead of the default', () => {
    expect(Math.round(computeDailyMiles(driveDay, DAY, TZ, 70))).toBe(280);
  });

  it('ignores non-driving time — only DRIVING hours convert to miles', () => {
    expect(Math.round(computeDailyMiles(driveDay, DAY, TZ, 60))).toBe(240);
  });
});

// ---------------------------------------------------------------------------
// 4. MILEAGE PRIORITY: manual > route > speed estimate
// ---------------------------------------------------------------------------
describe('mileage priority', () => {
  it('keeps driver-entered mileage ahead of route and estimate', () => {
    const r = resolveMileage({ manualMiles: 999, routeMiles: 130, drivingHours: 2, averageMph: 65 });
    expect(r).toMatchObject({ miles: 999, method: MILEAGE_METHOD.MANUAL });
  });

  it('uses a road route when no manual mileage exists', () => {
    const r = resolveMileage({ routeMiles: 130, drivingHours: 2, averageMph: 65 });
    expect(r).toMatchObject({ miles: 130, method: MILEAGE_METHOD.ROUTE });
  });

  it('falls back to duration x preferred speed when there is no route', () => {
    const r = resolveMileage({ drivingHours: 4, averageMph: undefined });
    expect(r).toMatchObject({ miles: 260, method: MILEAGE_METHOD.ESTIMATE });
  });

  it('returns no mileage when nothing is known', () => {
    expect(resolveMileage({}).method).toBe(MILEAGE_METHOD.UNKNOWN);
    expect(resolveMileage({}).miles).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. AI PROPOSAL MILEAGE USES THE SAME PRIORITY AND SPEED
// ---------------------------------------------------------------------------
describe('AI proposal mileage', () => {
  const iso = (h) => new Date(Date.UTC(2026, 7, 20, h)).toISOString();
  const leg = [
    { duty_status: 'DRIVING', start_timestamp: iso(6), end_timestamp: iso(8), city: 'Miami', state: 'FL' },
    { duty_status: 'ON_DUTY', start_timestamp: iso(8), end_timestamp: iso(8.5), city: 'Fort Pierce', state: 'FL' },
  ];
  const failingRoute = vi.fn(async () => null);
  const route = vi.fn(async () => ({ miles: 130, hours: 2 }));

  it('prefers the road route over a speed-based estimate', async () => {
    const result = await enrichProposalMileage(leg, { routingProvider: route, averageMph: 65 });
    expect(result.events[0]).toMatchObject({ mileage: 130, mileage_source: 'route' });
  });

  it('estimates with the preferred speed when the route is unavailable', async () => {
    const at70 = await enrichProposalMileage(leg, { routingProvider: failingRoute, averageMph: 70 });
    expect(at70.events[0]).toMatchObject({ mileage: 140, mileage_source: 'estimate' });
    const byDefault = await enrichProposalMileage(leg, { routingProvider: failingRoute });
    expect(byDefault.events[0]).toMatchObject({ mileage: 130, mileage_source: 'estimate' });
  });

  it('never replaces driver-entered or driver-stated mileage with an automatic estimate', async () => {
    const manual = [{ ...leg[0], mileage: 200, mileage_source: 'manual' }, leg[1]];
    const stated = [{ ...leg[0], mileage: 210, mileage_source: 'driver_stated' }, leg[1]];
    const manualResult = await enrichProposalMileage(manual, { routingProvider: route, averageMph: 65 });
    const statedResult = await enrichProposalMileage(stated, { routingProvider: failingRoute, averageMph: 65 });
    expect(manualResult.events[0]).toMatchObject({ mileage: 200, mileage_source: 'manual' });
    expect(statedResult.events[0]).toMatchObject({ mileage: 210, mileage_source: 'driver_stated' });
  });
});

// ---------------------------------------------------------------------------
// 6. HOS IS INDEPENDENT OF THE SPEED PREFERENCE
// ---------------------------------------------------------------------------
describe('HOS independence', () => {
  it('mileage estimation never changes driving hours', () => {
    const events = [
      { start_timestamp: `${DAY}T06:00:00.000Z`, end_timestamp: `${DAY}T10:00:00.000Z`, duty_status: 'DRIVING' },
    ];
    const before = events.map(e => new Date(e.end_timestamp) - new Date(e.start_timestamp));
    computeDailyMiles(events, DAY, TZ, 25);
    computeDailyMiles(events, DAY, TZ, 90);
    const after = events.map(e => new Date(e.end_timestamp) - new Date(e.start_timestamp));
    expect(after).toEqual(before);
    expect(after[0]).toBe(4 * H);
  });
});