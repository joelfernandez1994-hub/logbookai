import { describe, it, expect } from 'vitest';
import { reconstructDrivingDurations } from './drivingDurationReconstruction';

const H = 3600000;
const MIN = 60000;
const iso = (ms) => new Date(ms).toISOString();
const BASE = new Date('2026-08-24T05:00:00Z').getTime();

function ev({ duty_status, start, end, city = 'Houston', state = 'TX', startP = 'inferred', endP = 'inferred' }) {
  return {
    duty_status,
    start_timestamp: iso(start),
    end_timestamp: end == null ? null : iso(end),
    city, state,
    field_provenance: { start_time: startP, end_time: endP, status: 'explicit', city: 'explicit', state: 'explicit' },
    ambiguous_fields: [],
  };
}

function leg(eventIndex, requiredHours, miles = 300) {
  return {
    eventIndex,
    origin: 'Houston, TX', destination: 'Dallas, TX',
    route: { miles, hours: requiredHours },
    evaluation: { known: true, requiredTruckTime: requiredHours, miles },
  };
}

describe('reconstructDrivingDurations', () => {
  it('replaces an inferred Driving duration with routed truck time', () => {
    // 362 mi @ 55mph => ~6.58h; AI inferred only 4h (the Aug-24 case).
    const events = [ev({ duty_status: 'DRIVING', start: BASE, end: BASE + 4 * H })];
    const legs = [leg(0, 6.58, 362)];
    const { events: out, conflicts } = reconstructDrivingDurations(events, legs);
    expect(out[0].end_timestamp).toBe(iso(BASE + 6.58 * H));
    expect(out[0]._route_derived_duration).toBe(true);
    expect(out[0].ambiguous_fields).toContain('end_timestamp');
    expect(conflicts).toEqual([]);
  });

  it('leaves an explicit Driving end_time untouched', () => {
    const events = [ev({ duty_status: 'DRIVING', start: BASE, end: BASE + 4 * H, endP: 'explicit' })];
    const legs = [leg(0, 6.58, 362)];
    const { events: out } = reconstructDrivingDurations(events, legs);
    expect(out[0].end_timestamp).toBe(iso(BASE + 4 * H));
    expect(out[0]._route_derived_duration).toBeUndefined();
  });

  it('cascade-shifts subsequent inferred events and stops at the first explicit anchor', () => {
    const driveEnd = BASE + 4 * H;
    const onStart = driveEnd;
    const onEnd = onStart + H;
    const explicitStart = BASE + 10 * H;
    const events = [
      ev({ duty_status: 'DRIVING', start: BASE, end: driveEnd }),
      ev({ duty_status: 'ON_DUTY', start: onStart, end: onEnd, city: 'Dallas' }),
      ev({ duty_status: 'ON_DUTY', start: explicitStart, end: explicitStart + H, city: 'Austin', startP: 'explicit', endP: 'explicit' }),
    ];
    const legs = [leg(0, 6.58, 362)];
    const { events: out, conflicts } = reconstructDrivingDurations(events, legs);
    const delta = 2.58 * H;
    expect(out[0].end_timestamp).toBe(iso(BASE + 6.58 * H));
    expect(out[1].start_timestamp).toBe(iso(onStart + delta));
    expect(out[1].end_timestamp).toBe(iso(onEnd + delta));
    expect(out[2].start_timestamp).toBe(iso(explicitStart));
    expect(conflicts.length).toBe(1);
    expect(conflicts[0].type).toBe('route_time_gap');
  });

  it('routing failure leaves the inferred duration unchanged', () => {
    const events = [ev({ duty_status: 'DRIVING', start: BASE, end: BASE + 4 * H })];
    const legs = [{ eventIndex: 0, origin: 'Houston, TX', destination: 'Dallas, TX', route: null, evaluation: { known: false } }];
    const { events: out } = reconstructDrivingDurations(events, legs);
    expect(out[0].end_timestamp).toBe(iso(BASE + 4 * H));
    expect(out[0]._route_derived_duration).toBeUndefined();
  });

  it('does not reduce routed mileage', () => {
    const events = [ev({ duty_status: 'DRIVING', start: BASE, end: BASE + 4 * H })];
    events[0].mileage = 362;
    events[0].mileage_source = 'route';
    const legs = [leg(0, 6.58, 362)];
    const { events: out } = reconstructDrivingDurations(events, legs);
    expect(out[0].mileage).toBe(362);
    expect(out[0].mileage_source).toBe('route');
  });

  it('flags a gap when a route-shortened inferred block ends before an explicit anchor', () => {
    // Route 2h but AI inferred 4h => -2h shift. Explicit anchor fixed => gap.
    const driveEnd = BASE + 4 * H;
    const onStart = driveEnd;
    const onEnd = onStart + H;
    const explicitStart = BASE + 6 * H;
    const events = [
      ev({ duty_status: 'DRIVING', start: BASE, end: driveEnd }),
      ev({ duty_status: 'ON_DUTY', start: onStart, end: onEnd, city: 'Dallas' }),
      ev({ duty_status: 'ON_DUTY', start: explicitStart, end: explicitStart + H, city: 'Austin', startP: 'explicit', endP: 'explicit' }),
    ];
    const legs = [leg(0, 2, 110)];
    const { events: out, conflicts } = reconstructDrivingDurations(events, legs);
    expect(out[0].end_timestamp).toBe(iso(BASE + 2 * H));
    expect(out[1].start_timestamp).toBe(iso(onStart - 2 * H));
    expect(conflicts.length).toBe(1);
    expect(conflicts[0].type).toBe('route_time_gap');
  });

  it('does not shift events without provenance flags (deterministic-parser proposals)', () => {
    const events = [
      { duty_status: 'DRIVING', start_timestamp: iso(BASE), end_timestamp: iso(BASE + 4 * H), city: 'Houston', state: 'TX', ambiguous_fields: [] },
    ];
    const legs = [leg(0, 6.58, 362)];
    const { events: out } = reconstructDrivingDurations(events, legs);
    expect(out[0].end_timestamp).toBe(iso(BASE + 4 * H));
    expect(out[0]._route_derived_duration).toBeUndefined();
  });
});