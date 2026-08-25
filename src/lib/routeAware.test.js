import { describe, it, expect, vi, beforeEach } from 'vitest';
import { requiredTruckTime, routeTimeTolerance, evaluateRouteReasonableness, profileMph } from './proposalValidation';
import { detectTimelineRouteConflicts } from './routeAware';

const H = 3600000;
const DAY = '2026-08-24';
const TZ = 'America/New_York';
const base = new Date(`${DAY}T00:00:00-04:00`);
const iso = (h) => new Date(base.getTime() + h * H).toISOString();
const ev = (status, s, e, city, state = 'NY') => ({ duty_status: status, start_timestamp: iso(s), end_timestamp: e == null ? null : iso(e), city, state });

describe('requiredTruckTime derate = max(provider_hours, miles / planningMph)', () => {
  it('caps effective speed at the profile ceiling across all five profiles', () => {
    const route = { miles: 275, hours: 4 }; // provider thinks ~69 mph
    expect(requiredTruckTime(route, 'conservative')).toBeCloseTo(275 / 55, 4);
    expect(requiredTruckTime(route, '55')).toBeCloseTo(275 / 55, 4);
    expect(requiredTruckTime(route, '60')).toBeCloseTo(275 / 60, 4);
    expect(requiredTruckTime(route, '65')).toBeCloseTo(275 / 65, 4);
    expect(requiredTruckTime(route, 'provider')).toBeCloseTo(275 / 50, 4); // provider ceiling 50
  });

  it('honors a slower provider duration over the profile ceiling', () => {
    const route = { miles: 100, hours: 3 }; // provider ~33 mph (surface streets)
    expect(requiredTruckTime(route, 'conservative')).toBeCloseTo(3, 4);
    expect(requiredTruckTime(route, '65')).toBeCloseTo(3, 4);
  });

  it('profileMph mirrors planningMph (conservative=55, provider=50)', () => {
    expect(profileMph('conservative')).toBe(55);
    expect(profileMph('55')).toBe(55);
    expect(profileMph('60')).toBe(60);
    expect(profileMph('65')).toBe(65);
    expect(profileMph('provider')).toBe(50);
  });
});

describe('routeTimeTolerance (documented: larger of 5 min or 5%)', () => {
  it('uses a 5-minute floor for short legs', () => {
    expect(routeTimeTolerance(0.5)).toBeCloseTo(5 / 60, 4);
    expect(routeTimeTolerance(1)).toBeCloseTo(5 / 60, 4);
  });
  it('uses 5% for longer routes', () => {
    expect(routeTimeTolerance(5)).toBeCloseTo(0.25, 4);
    expect(routeTimeTolerance(10)).toBeCloseTo(0.5, 4);
  });
  it('returns 0 for unknown required time', () => {
    expect(routeTimeTolerance(null)).toBe(0);
  });
});

describe('evaluateRouteReasonableness conflict direction (corrected)', () => {
  // 126 mi, provider 2 h, conservative 55 mph -> required = max(2, 126/55=2.291) = 2.291 h
  const route = { miles: 126, hours: 2 };

  it('flags a conflict when proposed driving is shorter than required minus tolerance', () => {
    // proposed 1.0 h < 2.291 - ~0.115 => impossible speed -> conflict
    const r = evaluateRouteReasonableness(route, 1.0, 'conservative');
    expect(r.conflict).toBe(true);
    expect(r.requiredTruckTime).toBeCloseTo(2.291, 2);
  });

  it('does NOT flag when proposed driving equals the required time', () => {
    expect(evaluateRouteReasonableness(route, 2.3, 'conservative').conflict).toBe(false);
  });

  it('does NOT flag when a driver takes longer than the estimate (traffic/stops)', () => {
    expect(evaluateRouteReasonableness(route, 4.0, 'conservative').conflict).toBe(false);
  });

  it('returns known:false when no route is available', () => {
    expect(evaluateRouteReasonableness(null, 2, 'conservative')).toEqual({ known: false });
  });
});

describe('detectTimelineRouteConflicts (shared with ProposalReview)', () => {
  const provider = vi.fn();
  beforeEach(() => provider.mockClear());

  it('returns a conflict for a too-fast saved driving leg', async () => {
    provider.mockResolvedValue({ miles: 126, hours: 2 });
    const events = [
      ev('ON_DUTY', 0, 0.5, 'Albany'),
      ev('DRIVING', 0.5, 1.5, 'Albany'),   // 1.0 h for a 126 mi route -> too fast
      ev('ON_DUTY', 1.5, 2, 'Syracuse'),
    ];
    const conflicts = await detectTimelineRouteConflicts(events, { dateStr: DAY, tz: TZ, profileId: 'conservative', now: new Date(iso(24)), routingProvider: provider });
    expect(provider).toHaveBeenCalledWith('Albany, NY', 'Syracuse, NY');
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].origin).toBe('Albany, NY');
    expect(conflicts[0].destination).toBe('Syracuse, NY');
    expect(conflicts[0].proposedHours).toBeCloseTo(1.0, 2);
  });

  it('returns no conflict for a plausible saved driving leg', async () => {
    provider.mockResolvedValue({ miles: 55, hours: 1 });
    const events = [
      ev('ON_DUTY', 0, 0.5, 'Albany'),
      ev('DRIVING', 0.5, 2.5, 'Albany'),   // 2.0 h for 55 mi -> fine
      ev('ON_DUTY', 2.5, 3, 'Schenectady'),
    ];
    const conflicts = await detectTimelineRouteConflicts(events, { dateStr: DAY, tz: TZ, profileId: 'conservative', now: new Date(iso(24)), routingProvider: provider });
    expect(conflicts).toHaveLength(0);
  });

  it('returns no conflicts for a day with no driving', async () => {
    const events = [ev('OFF_DUTY', 0, 8, 'Albany'), ev('SLEEPER_BERTH', 8, 24, 'Albany')];
    const conflicts = await detectTimelineRouteConflicts(events, { dateStr: DAY, tz: TZ, profileId: 'conservative', now: new Date(iso(24)) });
    expect(conflicts).toHaveLength(0);
    expect(provider).not.toHaveBeenCalled();
  });
});