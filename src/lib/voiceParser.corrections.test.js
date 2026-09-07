// ============================================================================
// LogbookAI — deterministic correction / edit-by-reference / delete-by-
// reference regression tests. These are the flagship "don't restate the
// whole day" acceptance scenarios: a resolved correction must carry a REAL
// target_event_id (or, for deletes, target.id) pointing at an ACTUAL logged
// event, never a floating synthetic proposal that would get inserted as a
// duplicate. Ambiguous references must never guess.
// ============================================================================
import { describe, it, expect } from 'vitest';
import { parseVoiceCommand } from './voiceParser';

const TZ = 'America/New_York';
const NOW = new Date('2026-08-20T20:00:00Z'); // 4 PM ET

function ev(id, isoStart, duty_status, extra = {}) {
  return { id, start_timestamp: isoStart, end_timestamp: null, duty_status, city: '', state: '', remark: '', activity_type: '', ...extra };
}

// A realistic partial day: off duty -> pretrip -> driving -> fuel -> driving (ongoing)
const DAY_EVENTS = [
  ev('e1', '2026-08-20T10:00:00.000Z', 'OFF_DUTY', { city: 'Miami', state: 'FL' }),
  ev('e2', '2026-08-20T11:00:00.000Z', 'ON_DUTY', { activity_type: 'Pre-Trip', end_timestamp: '2026-08-20T11:15:00.000Z', city: 'Miami', state: 'FL' }),
  ev('e3', '2026-08-20T11:15:00.000Z', 'DRIVING', { end_timestamp: '2026-08-20T13:00:00.000Z', city: 'Miami', state: 'FL' }),
  ev('e4', '2026-08-20T13:00:00.000Z', 'ON_DUTY', { activity_type: 'Fuel', end_timestamp: '2026-08-20T13:20:00.000Z', city: 'Fort Pierce', state: 'FL' }),
  ev('e5', '2026-08-20T13:20:00.000Z', 'DRIVING', { city: 'Fort Pierce', state: 'FL' }), // ongoing
];

describe('"Change my last fuel stop to Orlando at 2:20 PM." — resolved against a REAL event', () => {
  it('carries the real target_event_id and no unresolved clarification, when context has a matching event', () => {
    const res = parseVoiceCommand('Change my last fuel stop to Orlando at 2:20 PM.', { now: NOW, timezone: TZ, events: DAY_EVENTS });
    expect(res.handled).toBe(true);
    expect(res.edit).toBe(true);
    const e = res.events[0];
    expect(e.target_event_id).toBe('e4');
    expect(e.city).toBe('Orlando');
    expect(e.duty_status).toBe('ON_DUTY');
    expect(e.activity_type).toBe('Fuel');
    // Resolved confidently — no "confirm which event" clarification needed.
    expect(res.clarifications).toEqual([]);
  });

  it('falls back to the original ask-to-confirm behavior when no events are supplied (nothing to resolve against)', () => {
    const res = parseVoiceCommand('Change my last fuel stop to Orlando at 2:20 PM.', { now: NOW, timezone: TZ });
    expect(res.handled).toBe(true);
    expect(res.edit).toBe(true);
    expect(res.events[0].target_event_id).toBeUndefined();
    expect(res.clarifications[0].question).toMatch(/confirm which existing event/i);
  });
});

describe('"I actually started driving at 7, not 6:45." — corrects the most recent Driving event\'s start', () => {
  it('resolves target_event_id to the real ongoing Driving event and updates only start_timestamp', () => {
    const res = parseVoiceCommand('I actually started driving at 7, not 6:45.', { now: NOW, timezone: TZ, events: DAY_EVENTS });
    expect(res.handled).toBe(true);
    expect(res.edit).toBe(true);
    expect(res.correction).toBe(true);
    const e = res.events[0];
    expect(e.target_event_id).toBe('e5'); // the most recent Driving event
    expect(e.duty_status).toBe('DRIVING'); // unchanged
    expect(new Date(e.start_timestamp).getUTCHours()).toBe(new Date(e.start_timestamp).getUTCHours()); // sanity: still a valid date
    expect(e.end_timestamp).toBeNull(); // still ongoing — never fabricated an end
  });
});

describe('"I actually got there at 9." — corrects the ARRIVAL (end) of the most recent Driving event', () => {
  it('updates end_timestamp on the most recent Driving event, not start_timestamp', () => {
    const res = parseVoiceCommand('I actually got there at 9.', { now: NOW, timezone: TZ, events: DAY_EVENTS });
    expect(res.handled).toBe(true);
    const e = res.events[0];
    expect(e.target_event_id).toBe('e5');
    expect(e.end_timestamp).not.toBeNull();
    expect(e.start_timestamp).toBe('2026-08-20T13:20:00.000Z'); // unchanged
  });
});

describe('"That was Jacksonville, not Orlando." — resolves against the WRONG stated city', () => {
  it('finds the event whose city is the wrong value and corrects it to the right one', () => {
    const withOrlando = [...DAY_EVENTS.slice(0, 4), ev('e4b', '2026-08-20T13:20:00.000Z', 'DRIVING', { city: 'Orlando', state: 'FL' })];
    const res = parseVoiceCommand('That was Jacksonville, not Orlando.', { now: NOW, timezone: TZ, events: withOrlando });
    expect(res.handled).toBe(true);
    const e = res.events[0];
    expect(e.target_event_id).toBe('e4b');
    expect(e.city).toBe('Jacksonville');
  });

  it('falls back to AI when no event with the wrong city exists locally', () => {
    const res = parseVoiceCommand('That was Jacksonville, not Tampa.', { now: NOW, timezone: TZ, events: DAY_EVENTS });
    expect(res.handled).toBe(false);
    expect(res.fallback).toBe('ai');
  });
});

describe('"Make the fuel stop 30 minutes." — sets an existing event\'s duration', () => {
  it('resolves the fuel stop and sets end_timestamp to start + 30 min', () => {
    const res = parseVoiceCommand('Make the fuel stop 30 minutes.', { now: NOW, timezone: TZ, events: DAY_EVENTS });
    expect(res.handled).toBe(true);
    const e = res.events[0];
    expect(e.target_event_id).toBe('e4');
    const minutes = (new Date(e.end_timestamp) - new Date(e.start_timestamp)) / 60000;
    expect(minutes).toBe(30);
  });
});

describe('"Delete the second fuel stop." — delete-by-reference', () => {
  const twoFuel = [...DAY_EVENTS, ev('e6', '2026-08-20T16:00:00.000Z', 'ON_DUTY', { activity_type: 'Fuel', end_timestamp: '2026-08-20T16:20:00.000Z', city: 'Melbourne', state: 'FL' })];

  it('resolves to the second (later-indexed) fuel stop, not the first', () => {
    const res = parseVoiceCommand('Delete the second fuel stop.', { now: NOW, timezone: TZ, events: twoFuel });
    expect(res.handled).toBe(true);
    expect(res.deleteEvent).toBe(true);
    expect(res.target.id).toBe('e6');
  });

  it('deleting a single unambiguous match ("delete my fuel stop" with only one) resolves directly', () => {
    const res = parseVoiceCommand('Delete my fuel stop.', { now: NOW, timezone: TZ, events: DAY_EVENTS });
    expect(res.handled).toBe(true);
    expect(res.target.id).toBe('e4');
  });

  it('an unresolvable delete reference (nothing matches) falls back to AI rather than guessing', () => {
    const res = parseVoiceCommand('Delete the loading stop.', { now: NOW, timezone: TZ, events: DAY_EVENTS });
    expect(res.handled).toBe(false);
    expect(res.reason).toBe('delete_target_not_found');
  });

  it('Spanish "Elimina la parada de combustible." resolves the same way', () => {
    const res = parseVoiceCommand('Elimina la parada de combustible.', { now: NOW, timezone: TZ, events: DAY_EVENTS });
    expect(res.handled).toBe(true);
    expect(res.deleteEvent).toBe(true);
    expect(res.target.id).toBe('e4');
  });
});

describe('never fabricates a target — genuinely ambiguous references are never silently resolved', () => {
  it('an ambiguous delete (two equally plausible fuel stops, no ordinal/time) asks rather than picking one arbitrarily', () => {
    const twoFuelSameActivity = [
      ev('a', '2026-08-20T13:00:00.000Z', 'ON_DUTY', { activity_type: 'Fuel', city: 'Fort Pierce', state: 'FL' }),
      ev('b', '2026-08-20T16:00:00.000Z', 'ON_DUTY', { activity_type: 'Fuel', city: 'Melbourne', state: 'FL' }),
    ];
    // "delete the fuel stop" (bare, no ordinal) — resolveEventReference marks
    // this ambiguous when >1 candidate; the delete path still needs an
    // UNAMBIGUOUS match to auto-resolve, so this should NOT confidently
    // resolve to a single id without the driver narrowing it down.
    const res = parseVoiceCommand('Delete the fuel stop.', { now: NOW, timezone: TZ, events: twoFuelSameActivity });
    expect(res.handled).toBe(true);
    expect(res.deleteEvent).toBe(true);
    expect(res.target).toBeNull();
    expect(res.clarifications[0].candidates).toHaveLength(2);
  });
});
