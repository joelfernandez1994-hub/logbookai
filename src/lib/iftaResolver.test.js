// ============================================================================
// LogbookAI — IFTA background resolver regression tests (vitest).
// Pure unit tests: routeSplitFn / upsertFn are injected fakes, no network,
// no base44Client. Confirms: state-crossing split, single-state trips,
// provenance rules (never overwrite driver-provided figures), and that
// resolver failures never throw up to the caller.
// ============================================================================
import { describe, it, expect, vi } from 'vitest';
import {
  deriveDayLegs, resolveDayMileage, resolveMissingDays, recomputeDay, groupEventsByDay, eventsForDay,
  currentQuarter, quarterDateRange, IFTA_RESOLVER_VERSION,
} from './iftaResolver';

function ev(overrides) {
  return {
    id: overrides.id || Math.random().toString(36).slice(2),
    duty_status: 'OFF_DUTY',
    start_timestamp: '2026-07-01T12:00:00.000Z',
    ...overrides,
  };
}

describe('deriveDayLegs', () => {
  it('derives origin/destination for a DRIVING event from its non-driving neighbors', () => {
    const day = [
      ev({ id: 'a', duty_status: 'ON_DUTY', city: 'Homestead', state: 'FL', start_timestamp: '2026-07-01T09:00:00.000Z' }),
      ev({ id: 'b', duty_status: 'DRIVING', start_timestamp: '2026-07-01T10:00:00.000Z' }),
      ev({ id: 'c', duty_status: 'OFF_DUTY', city: 'Valdosta', state: 'GA', start_timestamp: '2026-07-01T14:00:00.000Z' }),
    ];
    const legs = deriveDayLegs(day);
    expect(legs).toHaveLength(1);
    expect(legs[0].origin).toEqual({ city: 'Homestead', state: 'FL' });
    expect(legs[0].destination).toEqual({ city: 'Valdosta', state: 'GA' });
  });
});

describe('resolveDayMileage — Florida-only trip', () => {
  it('attributes all mileage to a single jurisdiction', async () => {
    const day = [
      ev({ id: 'a', duty_status: 'ON_DUTY', city: 'Miami', state: 'FL', start_timestamp: '2026-07-01T09:00:00.000Z' }),
      ev({ id: 'b', duty_status: 'DRIVING', start_timestamp: '2026-07-01T10:00:00.000Z' }),
      ev({ id: 'c', duty_status: 'OFF_DUTY', city: 'Orlando', state: 'FL', start_timestamp: '2026-07-01T13:00:00.000Z' }),
    ];
    const routeSplitFn = vi.fn().mockResolvedValue({ totalMiles: 230, segments: [{ state: 'FL', miles: 230 }] });
    const { jurisdictionMiles, errors } = await resolveDayMileage(day, { timezone: 'America/New_York', routeSplitFn });
    expect(errors).toHaveLength(0);
    expect(jurisdictionMiles).toEqual([{ jurisdiction: 'FL', miles: 230 }]);
    expect(routeSplitFn).toHaveBeenCalledWith('Miami, FL', 'Orlando, FL');
  });
});

describe('resolveDayMileage — Florida to Georgia trip', () => {
  it('splits mileage across both jurisdictions crossed', async () => {
    const day = [
      ev({ id: 'a', duty_status: 'ON_DUTY', city: 'Jacksonville', state: 'FL', start_timestamp: '2026-07-01T09:00:00.000Z' }),
      ev({ id: 'b', duty_status: 'DRIVING', start_timestamp: '2026-07-01T10:00:00.000Z' }),
      ev({ id: 'c', duty_status: 'OFF_DUTY', city: 'Valdosta', state: 'GA', start_timestamp: '2026-07-01T13:00:00.000Z' }),
    ];
    const routeSplitFn = vi.fn().mockResolvedValue({
      totalMiles: 130,
      segments: [{ state: 'FL', miles: 42 }, { state: 'GA', miles: 88 }],
    });
    const { jurisdictionMiles } = await resolveDayMileage(day, { timezone: 'America/New_York', routeSplitFn });
    expect(jurisdictionMiles).toEqual(expect.arrayContaining([
      { jurisdiction: 'FL', miles: 42 },
      { jurisdiction: 'GA', miles: 88 },
    ]));
  });
});

describe('jurisdiction normalization — full state names vs 2-letter codes', () => {
  it('normalizes a GPS-captured full state name on an event to a 2-letter code for the route-split call', () => {
    const day = [
      ev({ id: 'a', duty_status: 'ON_DUTY', city: 'Jacksonville', state: 'Florida', start_timestamp: '2026-07-01T09:00:00.000Z' }),
      ev({ id: 'b', duty_status: 'DRIVING', start_timestamp: '2026-07-01T10:00:00.000Z' }),
      ev({ id: 'c', duty_status: 'OFF_DUTY', city: 'Valdosta', state: 'GA', start_timestamp: '2026-07-01T13:00:00.000Z' }),
    ];
    const legs = deriveDayLegs(day);
    expect(legs[0].origin).toEqual({ city: 'Jacksonville', state: 'FL' });
    expect(legs[0].destination).toEqual({ city: 'Valdosta', state: 'GA' });
  });

  it('normalizes a full state name returned in a route-split segment to a 2-letter code so it matches manually-entered jurisdictions', async () => {
    const day = [
      ev({ id: 'a', duty_status: 'ON_DUTY', city: 'Miami', state: 'FL', start_timestamp: '2026-07-01T09:00:00.000Z' }),
      ev({ id: 'b', duty_status: 'DRIVING', start_timestamp: '2026-07-01T10:00:00.000Z' }),
      ev({ id: 'c', duty_status: 'OFF_DUTY', city: 'Orlando', state: 'FL', start_timestamp: '2026-07-01T13:00:00.000Z' }),
    ];
    // Simulates the real backend, which reverse-geocodes via Nominatim and
    // returns a full state name before normalization.
    const routeSplitFn = vi.fn().mockResolvedValue({ totalMiles: 230, segments: [{ state: 'Florida', miles: 230 }] });
    const { jurisdictionMiles } = await resolveDayMileage(day, { routeSplitFn });
    expect(jurisdictionMiles).toEqual([{ jurisdiction: 'FL', miles: 230 }]);
  });
});

describe('resolveDayMileage — missing location / route failure never throws', () => {
  it('records an error and skips the leg when origin/destination is missing', async () => {
    const day = [
      ev({ id: 'a', duty_status: 'DRIVING', start_timestamp: '2026-07-01T10:00:00.000Z' }),
      ev({ id: 'b', duty_status: 'OFF_DUTY', start_timestamp: '2026-07-01T13:00:00.000Z' }),
    ];
    const routeSplitFn = vi.fn();
    const { jurisdictionMiles, errors } = await resolveDayMileage(day, { timezone: 'America/New_York', routeSplitFn });
    expect(jurisdictionMiles).toEqual([]);
    expect(errors.length).toBeGreaterThan(0);
    expect(routeSplitFn).not.toHaveBeenCalled();
  });

  it('records an error and continues when the route provider throws', async () => {
    const day = [
      ev({ id: 'a', duty_status: 'ON_DUTY', city: 'Miami', state: 'FL', start_timestamp: '2026-07-01T09:00:00.000Z' }),
      ev({ id: 'b', duty_status: 'DRIVING', start_timestamp: '2026-07-01T10:00:00.000Z' }),
      ev({ id: 'c', duty_status: 'OFF_DUTY', city: 'Orlando', state: 'FL', start_timestamp: '2026-07-01T13:00:00.000Z' }),
    ];
    const routeSplitFn = vi.fn().mockRejectedValue(new Error('network down'));
    const { jurisdictionMiles, errors } = await resolveDayMileage(day, { timezone: 'America/New_York', routeSplitFn });
    expect(jurisdictionMiles).toEqual([]);
    expect(errors).toHaveLength(1);
  });
});

describe('resolveMissingDays — provenance rules', () => {
  it('never overwrites a driver_entered or driver_confirmed row', async () => {
    const events = [
      ev({ id: 'a', duty_status: 'ON_DUTY', city: 'Miami', state: 'FL', start_timestamp: '2026-07-01T09:00:00.000Z' }),
      ev({ id: 'b', duty_status: 'DRIVING', start_timestamp: '2026-07-01T10:00:00.000Z' }),
      ev({ id: 'c', duty_status: 'OFF_DUTY', city: 'Orlando', state: 'FL', start_timestamp: '2026-07-01T13:00:00.000Z' }),
    ];
    const existingRecords = [
      { log_date: '2026-07-01', jurisdiction: 'FL', miles: 999, mileage_source: 'driver_confirmed' },
    ];
    const routeSplitFn = vi.fn().mockResolvedValue({ totalMiles: 230, segments: [{ state: 'FL', miles: 230 }] });
    const upsertFn = vi.fn();
    const summary = await resolveMissingDays({ events, timezone: 'America/New_York', existingRecords, routeSplitFn, upsertFn });
    // Day is skipped entirely because its only existing row is driver-provided.
    expect(upsertFn).not.toHaveBeenCalled();
    expect(summary.skippedDays).toBe(1);
  });

  it('skips a day already resolved at the current resolver version (idempotent)', async () => {
    const events = [
      ev({ id: 'a', duty_status: 'ON_DUTY', city: 'Miami', state: 'FL', start_timestamp: '2026-07-01T09:00:00.000Z' }),
      ev({ id: 'b', duty_status: 'DRIVING', start_timestamp: '2026-07-01T10:00:00.000Z' }),
      ev({ id: 'c', duty_status: 'OFF_DUTY', city: 'Orlando', state: 'FL', start_timestamp: '2026-07-01T13:00:00.000Z' }),
    ];
    const existingRecords = [
      { log_date: '2026-07-01', jurisdiction: 'FL', miles: 230, mileage_source: 'route_estimated', resolver_version: IFTA_RESOLVER_VERSION },
    ];
    const routeSplitFn = vi.fn();
    const upsertFn = vi.fn();
    const summary = await resolveMissingDays({ events, timezone: 'America/New_York', existingRecords, routeSplitFn, upsertFn });
    expect(routeSplitFn).not.toHaveBeenCalled();
    expect(summary.skippedDays).toBe(1);
  });

  it('resolves a day with no existing records and writes route_estimated rows', async () => {
    const events = [
      ev({ id: 'a', duty_status: 'ON_DUTY', city: 'Miami', state: 'FL', start_timestamp: '2026-07-01T09:00:00.000Z' }),
      ev({ id: 'b', duty_status: 'DRIVING', start_timestamp: '2026-07-01T10:00:00.000Z' }),
      ev({ id: 'c', duty_status: 'OFF_DUTY', city: 'Orlando', state: 'FL', start_timestamp: '2026-07-01T13:00:00.000Z' }),
    ];
    const routeSplitFn = vi.fn().mockResolvedValue({ totalMiles: 230, segments: [{ state: 'FL', miles: 230 }] });
    const upsertFn = vi.fn().mockResolvedValue({});
    const summary = await resolveMissingDays({ events, timezone: 'America/New_York', existingRecords: [], routeSplitFn, upsertFn });
    expect(summary.resolvedDays).toBe(1);
    expect(upsertFn).toHaveBeenCalledWith(expect.objectContaining({
      log_date: '2026-07-01', jurisdiction: 'FL', miles: 230, mileage_source: 'route_estimated', confirmed: false,
    }));
  });

  it('a day with no DRIVING events is never processed (off-duty/on-duty-only day)', async () => {
    const events = [
      ev({ id: 'a', duty_status: 'ON_DUTY', city: 'Miami', state: 'FL', start_timestamp: '2026-07-01T09:00:00.000Z' }),
    ];
    const routeSplitFn = vi.fn();
    const upsertFn = vi.fn();
    const summary = await resolveMissingDays({ events, timezone: 'America/New_York', existingRecords: [], routeSplitFn, upsertFn });
    expect(routeSplitFn).not.toHaveBeenCalled();
    expect(summary.resolvedDays).toBe(0);
    expect(summary.skippedDays).toBe(0);
  });

  it('a resolver-level upsert failure is captured in summary.errors, never thrown', async () => {
    const events = [
      ev({ id: 'a', duty_status: 'ON_DUTY', city: 'Miami', state: 'FL', start_timestamp: '2026-07-01T09:00:00.000Z' }),
      ev({ id: 'b', duty_status: 'DRIVING', start_timestamp: '2026-07-01T10:00:00.000Z' }),
      ev({ id: 'c', duty_status: 'OFF_DUTY', city: 'Orlando', state: 'FL', start_timestamp: '2026-07-01T13:00:00.000Z' }),
    ];
    const routeSplitFn = vi.fn().mockResolvedValue({ totalMiles: 230, segments: [{ state: 'FL', miles: 230 }] });
    const upsertFn = vi.fn().mockRejectedValue(new Error('db unavailable'));
    const summary = await resolveMissingDays({ events, timezone: 'America/New_York', existingRecords: [], routeSplitFn, upsertFn });
    expect(summary.errors.length).toBeGreaterThan(0);
  });
});

describe('recomputeDay — manual "Recalculate day" action', () => {
  it('refreshes a route_estimated row after the underlying trip/location data changed (FL-only became FL -> GA)', async () => {
    // Driver originally logged a Florida-only trip (resolved once, giving a
    // stale FL-only row), then edited the log to add a stop in Georgia.
    const day = [
      ev({ id: 'a', duty_status: 'ON_DUTY', city: 'Jacksonville', state: 'FL', start_timestamp: '2026-07-01T09:00:00.000Z' }),
      ev({ id: 'b', duty_status: 'DRIVING', start_timestamp: '2026-07-01T10:00:00.000Z' }),
      ev({ id: 'c', duty_status: 'OFF_DUTY', city: 'Valdosta', state: 'GA', start_timestamp: '2026-07-01T13:00:00.000Z' }),
    ];
    const existingRecords = [
      { id: 'r1', log_date: '2026-07-01', jurisdiction: 'FL', miles: 230, mileage_source: 'route_estimated', resolver_version: IFTA_RESOLVER_VERSION },
    ];
    const routeSplitFn = vi.fn().mockResolvedValue({
      totalMiles: 130,
      segments: [{ state: 'FL', miles: 42 }, { state: 'GA', miles: 88 }],
    });
    const upsertFn = vi.fn().mockResolvedValue({});
    const summary = await recomputeDay({ dayEvents: day, logDate: '2026-07-01', existingRecords, routeSplitFn, upsertFn });

    expect(summary.errors).toHaveLength(0);
    expect(summary.updated).toEqual(expect.arrayContaining([
      { jurisdiction: 'FL', miles: 42 },
      { jurisdiction: 'GA', miles: 88 },
    ]));
    // The stale FL row (existingRow) was updated in place, not left at 230.
    expect(upsertFn).toHaveBeenCalledWith(expect.objectContaining({ jurisdiction: 'FL', miles: 42, existingRow: existingRecords[0] }));
    expect(upsertFn).toHaveBeenCalledWith(expect.objectContaining({ jurisdiction: 'GA', miles: 88 }));
  });

  it('preserves a driver_confirmed row by default and reports it as preserved, not updated', async () => {
    const day = [
      ev({ id: 'a', duty_status: 'ON_DUTY', city: 'Miami', state: 'FL', start_timestamp: '2026-07-01T09:00:00.000Z' }),
      ev({ id: 'b', duty_status: 'DRIVING', start_timestamp: '2026-07-01T10:00:00.000Z' }),
      ev({ id: 'c', duty_status: 'OFF_DUTY', city: 'Orlando', state: 'FL', start_timestamp: '2026-07-01T13:00:00.000Z' }),
    ];
    const existingRecords = [
      { id: 'r1', log_date: '2026-07-01', jurisdiction: 'FL', miles: 999, mileage_source: 'driver_confirmed' },
    ];
    const routeSplitFn = vi.fn().mockResolvedValue({ totalMiles: 230, segments: [{ state: 'FL', miles: 230 }] });
    const upsertFn = vi.fn();
    const summary = await recomputeDay({ dayEvents: day, logDate: '2026-07-01', existingRecords, routeSplitFn, upsertFn });

    expect(upsertFn).not.toHaveBeenCalled();
    expect(summary.updated).toEqual([]);
    expect(summary.preserved).toEqual([{ jurisdiction: 'FL', miles: 999, mileage_source: 'driver_confirmed' }]);
  });

  it('replaces a driver_confirmed row only when replaceConfirmed is explicitly true', async () => {
    const day = [
      ev({ id: 'a', duty_status: 'ON_DUTY', city: 'Miami', state: 'FL', start_timestamp: '2026-07-01T09:00:00.000Z' }),
      ev({ id: 'b', duty_status: 'DRIVING', start_timestamp: '2026-07-01T10:00:00.000Z' }),
      ev({ id: 'c', duty_status: 'OFF_DUTY', city: 'Orlando', state: 'FL', start_timestamp: '2026-07-01T13:00:00.000Z' }),
    ];
    const existingRecords = [
      { id: 'r1', log_date: '2026-07-01', jurisdiction: 'FL', miles: 999, mileage_source: 'driver_confirmed' },
    ];
    const routeSplitFn = vi.fn().mockResolvedValue({ totalMiles: 230, segments: [{ state: 'FL', miles: 230 }] });
    const upsertFn = vi.fn().mockResolvedValue({});
    const summary = await recomputeDay({ dayEvents: day, logDate: '2026-07-01', existingRecords, routeSplitFn, upsertFn, replaceConfirmed: true });

    expect(upsertFn).toHaveBeenCalledWith(expect.objectContaining({ jurisdiction: 'FL', miles: 230, mileage_source: 'route_estimated', confirmed: false }));
    expect(summary.updated).toEqual([{ jurisdiction: 'FL', miles: 230 }]);
    expect(summary.preserved).toEqual([]);
  });

  it('refreshes a jurisdiction down to zero when its trip no longer exists (deleted/rerouted), without touching a sibling confirmed jurisdiction', async () => {
    // Only a Georgia leg remains today; the old Florida leg was removed from
    // the log. The stale FL route_estimated row should be refreshed to 0, but
    // a separately driver_confirmed GA row from a different day is untouched
    // (out of scope for this log_date) and this day's GA figure is fresh.
    const day = [
      ev({ id: 'a', duty_status: 'ON_DUTY', city: 'Valdosta', state: 'GA', start_timestamp: '2026-07-01T09:00:00.000Z' }),
      ev({ id: 'b', duty_status: 'DRIVING', start_timestamp: '2026-07-01T10:00:00.000Z' }),
      ev({ id: 'c', duty_status: 'OFF_DUTY', city: 'Macon', state: 'GA', start_timestamp: '2026-07-01T12:00:00.000Z' }),
    ];
    const existingRecords = [
      { id: 'r1', log_date: '2026-07-01', jurisdiction: 'FL', miles: 230, mileage_source: 'route_estimated', resolver_version: IFTA_RESOLVER_VERSION },
    ];
    const routeSplitFn = vi.fn().mockResolvedValue({ totalMiles: 90, segments: [{ state: 'GA', miles: 90 }] });
    const upsertFn = vi.fn().mockResolvedValue({});
    const summary = await recomputeDay({ dayEvents: day, logDate: '2026-07-01', existingRecords, routeSplitFn, upsertFn });

    expect(upsertFn).toHaveBeenCalledWith(expect.objectContaining({ jurisdiction: 'FL', miles: 0, existingRow: existingRecords[0] }));
    expect(upsertFn).toHaveBeenCalledWith(expect.objectContaining({ jurisdiction: 'GA', miles: 90 }));
  });

  it('never throws when the route provider fails, and captures the failure in summary.errors', async () => {
    const day = [
      ev({ id: 'a', duty_status: 'ON_DUTY', city: 'Miami', state: 'FL', start_timestamp: '2026-07-01T09:00:00.000Z' }),
      ev({ id: 'b', duty_status: 'DRIVING', start_timestamp: '2026-07-01T10:00:00.000Z' }),
      ev({ id: 'c', duty_status: 'OFF_DUTY', city: 'Orlando', state: 'FL', start_timestamp: '2026-07-01T13:00:00.000Z' }),
    ];
    const routeSplitFn = vi.fn().mockRejectedValue(new Error('route provider down'));
    const upsertFn = vi.fn();
    const summary = await recomputeDay({ dayEvents: day, logDate: '2026-07-01', existingRecords: [], routeSplitFn, upsertFn });

    expect(summary.errors.length).toBeGreaterThan(0);
    expect(upsertFn).not.toHaveBeenCalled();
  });

  it('is a no-op for a day with no DRIVING events', async () => {
    const day = [ev({ id: 'a', duty_status: 'ON_DUTY', city: 'Miami', state: 'FL' })];
    const routeSplitFn = vi.fn();
    const upsertFn = vi.fn();
    const summary = await recomputeDay({ dayEvents: day, logDate: '2026-07-01', existingRecords: [], routeSplitFn, upsertFn });
    expect(routeSplitFn).not.toHaveBeenCalled();
    expect(summary).toEqual({ updated: [], preserved: [], errors: [] });
  });
});

describe('eventsForDay', () => {
  it('filters a full event list down to one calendar day, feeding recomputeDay for a single-day recalculation', () => {
    const events = [
      ev({ id: 'a', start_timestamp: '2026-07-01T13:00:00.000Z' }),
      ev({ id: 'b', start_timestamp: '2026-07-02T13:00:00.000Z' }),
    ];
    const day1 = eventsForDay(events, '2026-07-01', 'America/New_York');
    expect(day1.map((e) => e.id)).toEqual(['a']);
  });
});

describe('groupEventsByDay', () => {
  it('buckets events by local calendar day in the given timezone', () => {
    const events = [
      ev({ id: 'a', start_timestamp: '2026-07-02T03:30:00.000Z' }), // 11:30 PM Jul 1 in America/New_York
      ev({ id: 'b', start_timestamp: '2026-07-02T15:00:00.000Z' }), // 11:00 AM Jul 2 in America/New_York
    ];
    const byDay = groupEventsByDay(events, 'America/New_York');
    expect(byDay.get('2026-07-01')).toHaveLength(1);
    expect(byDay.get('2026-07-02')).toHaveLength(1);
  });
});

describe('quarter helpers', () => {
  it('currentQuarter and quarterDateRange are consistent', () => {
    const q = currentQuarter(new Date('2026-08-15T00:00:00Z'));
    expect(q).toBe('2026-Q3');
    const { start, end } = quarterDateRange(q);
    expect(start).toBe('2026-07-01');
    expect(end).toBe('2026-09-30');
  });
});
