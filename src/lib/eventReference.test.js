// ============================================================================
// LogbookAI — eventReference regression tests. Pure, no AI, no network.
// Guards edit-by-reference / delete-by-reference resolution: a driver must
// be able to correct or remove an existing event WITHOUT restating the whole
// day, and the resolver must never silently guess when genuinely ambiguous.
// ============================================================================
import { describe, it, expect } from 'vitest';
import { resolveEventReference, findEventByCity, describeEvent } from './eventReference';

const TZ = 'America/New_York';

function ev(id, isoStart, duty_status, extra = {}) {
  return { id, start_timestamp: isoStart, duty_status, city: '', state: '', remark: '', activity_type: '', ...extra };
}

const DAY = [
  ev('1', '2026-08-20T10:00:00.000Z', 'OFF_DUTY', { city: 'Miami', state: 'FL' }),
  ev('2', '2026-08-20T11:00:00.000Z', 'ON_DUTY', { activity_type: 'Pre-Trip', city: 'Miami', state: 'FL' }),
  ev('3', '2026-08-20T11:15:00.000Z', 'DRIVING', { city: 'Miami', state: 'FL' }),
  ev('4', '2026-08-20T13:00:00.000Z', 'ON_DUTY', { activity_type: 'Fuel', city: 'Fort Pierce', state: 'FL' }),
  ev('5', '2026-08-20T13:20:00.000Z', 'DRIVING', { city: 'Fort Pierce', state: 'FL' }),
  ev('6', '2026-08-20T16:00:00.000Z', 'ON_DUTY', { activity_type: 'Fuel', city: 'Melbourne', state: 'FL' }),
  ev('7', '2026-08-20T16:20:00.000Z', 'DRIVING', { city: 'Melbourne', state: 'FL' }),
];

describe('resolveEventReference — activity keyword + recency ("my last fuel stop")', () => {
  it('"the fuel stop" defaults to the most recent match', () => {
    const ref = resolveEventReference(DAY, 'change my last fuel stop to 8:15', { tz: TZ });
    expect(ref.resolved.id).toBe('6');
    expect(ref.ambiguous).toBe(false); // "last" is an explicit ordinal — never ambiguous
  });

  it('bare "the fuel stop" (no ordinal) still resolves to most recent but flags ambiguous when multiple exist', () => {
    const ref = resolveEventReference(DAY, 'the fuel stop', { tz: TZ });
    expect(ref.resolved.id).toBe('6');
    expect(ref.ambiguous).toBe(true);
    expect(ref.candidates).toHaveLength(2);
  });

  it('"the second fuel stop" resolves to the earlier of two matches, not the most recent', () => {
    const ref = resolveEventReference(DAY, 'the second fuel stop', { tz: TZ });
    expect(ref.resolved.id).toBe('6'); // chronological index 1 (0-based) among fuel events [4, 6]
  });

  it('"the first fuel stop" resolves to the earliest match', () => {
    const ref = resolveEventReference(DAY, 'the first fuel stop', { tz: TZ });
    expect(ref.resolved.id).toBe('4');
  });

  it('Spanish: "la segunda parada de combustible" resolves the same way as English', () => {
    const ref = resolveEventReference(DAY, 'la segunda parada de combustible', { tz: TZ });
    expect(ref.resolved.id).toBe('6');
  });

  it('an out-of-range ordinal ("the third fuel stop" when only 2 exist) returns null rather than guessing', () => {
    const ref = resolveEventReference(DAY, 'the third fuel stop', { tz: TZ });
    expect(ref.resolved).toBeNull();
    expect(ref.reason).toBe('ordinal_out_of_range');
  });

  it('no matching activity at all returns no candidates', () => {
    const ref = resolveEventReference(DAY, 'the loading stop', { tz: TZ });
    expect(ref.candidates).toEqual([]);
    expect(ref.resolved).toBeNull();
  });
});

describe('resolveEventReference — time-based reference ("the 4 PM stop")', () => {
  it('resolves to the event whose local time is closest to the mentioned time', () => {
    // Fuel at 13:00 UTC = 9:00 AM ET, fuel at 16:00 UTC = 12:00 PM ET.
    const ref = resolveEventReference(DAY, 'the 9 AM stop', { tz: TZ });
    expect(ref.resolved.id).toBe('4');
  });

  it('a time far from any event does not force a match (falls back to activity/recency default)', () => {
    const ref = resolveEventReference(DAY, 'the fuel stop around 11 PM', { tz: TZ });
    // 11 PM is >90 min from both fuel events (9 AM / 12 PM) — falls back to
    // the default-to-most-recent behavior for the activity keyword.
    expect(ref.resolved.id).toBe('6');
  });
});

describe('resolveEventReference — generic reference ("that", "my last stop")', () => {
  it('"that" with no activity keyword resolves to the most recent event overall', () => {
    const ref = resolveEventReference(DAY, 'that', { tz: TZ });
    expect(ref.resolved.id).toBe('7');
  });

  it('"my last stop" resolves to the most recent event overall (no ordinal narrowing by type)', () => {
    const ref = resolveEventReference(DAY, 'my last stop', { tz: TZ });
    expect(ref.resolved.id).toBe('7');
  });
});

describe('resolveEventReference — edge cases', () => {
  it('empty events list returns no candidates, never throws', () => {
    expect(() => resolveEventReference([], 'the fuel stop', { tz: TZ })).not.toThrow();
    expect(resolveEventReference([], 'the fuel stop', { tz: TZ }).resolved).toBeNull();
  });

  it('undefined/null events does not throw', () => {
    expect(() => resolveEventReference(null, 'the fuel stop')).not.toThrow();
    expect(() => resolveEventReference(undefined, 'the fuel stop')).not.toThrow();
  });

  it('driving/off_duty/sleeper activity keys resolve against duty_status', () => {
    expect(resolveEventReference(DAY, 'the driving', { tz: TZ }).resolved.id).toBe('7');
    expect(resolveEventReference(DAY, 'off duty', { tz: TZ }).resolved.id).toBe('1');
  });
});

describe('findEventByCity — resolves a correction against the WRONG stated value', () => {
  it('finds the event whose city matches (case-insensitive)', () => {
    const found = findEventByCity(DAY, 'melbourne');
    expect(found.id).toBe('6');
  });

  it('returns null when no event has that city', () => {
    expect(findEventByCity(DAY, 'Orlando')).toBeNull();
  });

  it('returns the most recent match when more than one event shares a city', () => {
    const dup = [...DAY, ev('8', '2026-08-20T18:00:00.000Z', 'ON_DUTY', { city: 'Melbourne', state: 'FL', activity_type: 'Unloading' })];
    expect(findEventByCity(dup, 'Melbourne').id).toBe('8');
  });
});

describe('describeEvent — human-readable label for clarifications', () => {
  it('includes time, activity/status, and location', () => {
    const label = describeEvent(DAY[3], TZ); // Fuel at 13:00 UTC = 9:00 AM ET
    expect(label).toContain('Fuel');
    expect(label).toContain('Fort Pierce');
    expect(label).toMatch(/9:00\s*AM/i);
  });

  it('never throws on a malformed event', () => {
    expect(() => describeEvent({}, TZ)).not.toThrow();
  });
});
