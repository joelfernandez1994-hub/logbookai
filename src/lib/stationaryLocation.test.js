// ============================================================================
// REGRESSION — Log with AI LOCATION PRESERVATION (deterministic paths).
// ----------------------------------------------------------------------------
// The driver's stated city/state must survive interpretation, clarification
// replies, proposal review, and saving — never substituted, never dropped.
// Covers the deterministic stationary full-day rule: a trailing "in <City,
// State>" is carried onto the proposed event; a stated city without a state
// asks "which state?" (carrying the city); a purely-location reply is merged
// back into the original request exactly.
// ============================================================================
import { describe, it, expect } from 'vitest';
import { parseStationaryDay, parseLocationReply, mergeLocationReply } from './stationaryDayRule';

const TZ = 'America/Chicago';
const opts = (date = '2026-10-14') => ({ now: new Date('2026-10-19T12:00:00Z'), timezone: TZ, selectedDate: date });

describe('full-day stationary requests preserve the stated location', () => {
  it('"log entire day off duty in Miami, FL" carries Miami/FL onto the event', () => {
    const r = parseStationaryDay('Log the entire day off duty in Miami, FL.', opts());
    expect(r.matched).toBe(true);
    expect(r.proposed_events).toHaveLength(1);
    expect(r.proposed_events[0].city).toBe('Miami');
    expect(r.proposed_events[0].state).toBe('FL');
    expect(r.proposed_events[0].field_provenance.city).toBe('explicit');
  });

  it('"off duty entire day" with no location keeps the location empty', () => {
    const r = parseStationaryDay('off duty entire day', opts());
    expect(r.matched).toBe(true);
    expect(r.proposed_events[0].city).toBe('');
    expect(r.proposed_events[0].state).toBe('');
  });

  it('"off duty all day in Miami, FL" (all-day wording) carries the location too', () => {
    const r = parseStationaryDay('off duty all day in Miami, FL', opts());
    expect(r.matched).toBe(true);
    expect(r.proposed_events[0].city).toBe('Miami');
    expect(r.proposed_events[0].state).toBe('FL');
  });

  it('an ambiguous city without a state asks which state and keeps the city', () => {
    const r = parseStationaryDay('off duty all day in Springfield', opts());
    expect(r.matched).toBe(true);
    expect(r.requires_clarification).toBe(true);
    expect(r.pending_location_city).toBe('Springfield');
    expect(r.proposed_events.length).toBe(0);
  });

  it('Spanish: todo el día fuera de servicio keeps working without a location', () => {
    const r = parseStationaryDay('todo el día fuera de servicio', opts());
    expect(r.matched).toBe(true);
    expect(r.proposed_events[0].city).toBe('');
  });

  it('Spanish: todo el día fuera de servicio en Laredo, TX carries the location', () => {
    const r = parseStationaryDay('todo el día fuera de servicio en Laredo, TX', opts());
    expect(r.matched).toBe(true);
    expect(r.proposed_events[0].city).toBe('Laredo');
    expect(r.proposed_events[0].state).toBe('TX');
  });
});

describe('clarification replies carry the stated location', () => {
  it('a state-only reply ("IL") merges into the original request', () => {
    const reply = parseLocationReply('IL');
    expect(reply).toEqual({ city: null, state: 'IL' });
    const r = parseStationaryDay(mergeLocationReply('off duty all day in Springfield', reply), opts());
    expect(r.matched).toBe(true);
    expect(r.proposed_events[0].city).toBe('Springfield');
    expect(r.proposed_events[0].state).toBe('IL');
  });

  it('a full-state-name reply ("Illinois") resolves to IL', () => {
    const reply = parseLocationReply('Illinois');
    const r = parseStationaryDay(mergeLocationReply('off duty all day in Springfield', reply), opts());
    expect(r.proposed_events[0].state).toBe('IL');
  });

  it('a city+state reply replaces the ambiguous city exactly as stated', () => {
    const reply = parseLocationReply('in Miami, FL');
    expect(reply.city).toBe('Miami');
    const r = parseStationaryDay(mergeLocationReply('off duty all day in Springfield', reply), opts());
    expect(r.proposed_events[0].city).toBe('Miami');
    expect(r.proposed_events[0].state).toBe('FL');
  });

  it('plain-language replies are never treated as location answers', () => {
    expect(parseLocationReply('yes please')).toBeNull();
    expect(parseLocationReply('not sure')).toBeNull();
    expect(parseLocationReply('I also drove 30 miles')).toBeNull();
    expect(parseLocationReply('10 PM to 6 AM')).toBeNull();
  });

  it('the selected log date is preserved through the reply merge', () => {
    const r = parseStationaryDay(mergeLocationReply('log entire day off duty in Miami, FL', parseLocationReply('FL')), opts('2026-10-17'));
    expect(r.target_date).toBe('2026-10-17');
    expect(r.proposed_events[0].date).toBe('2026-10-17');
  });
});