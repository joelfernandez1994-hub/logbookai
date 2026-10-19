// ============================================================================
// Regression coverage — SELECTED-DATE LOG CONTEXT.
// ----------------------------------------------------------------------------
// The date selected in Logs is authoritative through Log with AI:
//   - full-day "off duty" targets the SELECTED date, never silently today
//   - a complete past day already covered → "Already logged", no duplicate
//   - conflicting entries → replace_day with the affected entries listed
//   - time ranges land on the selected calendar day (and roll across midnight)
//   - TODAY's full-day request records only through now (never future hours)
//   - log_date is derived in the LOG timezone (never a raw UTC slice)
// ============================================================================
import { describe, it, expect } from 'vitest';
import { parseStationaryDay, analyzeDayCoverage, restCoversRange } from './stationaryDayRule';
import { parseVoiceCommand } from './voiceParser';
import { formatLogDate } from './timezones';

const TZ = 'America/New_York';
// 00:50 local Oct 19 (UTC-4) — an early-morning "now".
const NOW = new Date('2026-10-19T04:50:00Z');
const PAST = '2026-10-14';
const TODAY = '2026-10-19';
const H = 3600000;

function tzDate(iso) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: TZ });
}

describe('formatLogDate', () => {
  it('formats weekday, month, day, year without timezone drift', () => {
    expect(formatLogDate('2026-10-14')).toBe('Wednesday, October 14, 2026');
    expect(formatLogDate('')).toBe('');
  });
});

describe('full-day off duty on a SELECTED past date', () => {
  it('targets the selected date, 12AM→12AM next day, 24h, single event', () => {
    const r = parseStationaryDay('log entire day off duty', {
      now: NOW, timezone: TZ, selectedDate: PAST, existingEvents: [],
    });
    expect(r.matched).toBe(true);
    expect(r.target_date).toBe(PAST);
    expect(r.proposed_events).toHaveLength(1);
    const ev = r.proposed_events[0];
    expect(ev.duty_status).toBe('OFF_DUTY');
    expect(tzDate(ev.start_timestamp)).toBe(PAST);
    expect(tzDate(ev.end_timestamp)).toBe('2026-10-15');
    expect((new Date(ev.end_timestamp) - new Date(ev.start_timestamp)) / H).toBeCloseTo(24, 2);
  });

  it('without a selected date it targets today (unchanged legacy behavior)', () => {
    const r = parseStationaryDay('off duty entire day', { now: NOW, timezone: TZ, existingEvents: [] });
    expect(r.target_date).toBe(TODAY);
  });

  it('already-covered day → Already logged, no proposed events', () => {
    const existing = [{
      log_date: PAST,
      start_timestamp: '2026-10-14T04:00:00Z', // 12:00 AM ET
      end_timestamp: '2026-10-15T04:00:00Z',   // 12:00 AM ET next day
      duty_status: 'OFF_DUTY',
    }];
    const r = parseStationaryDay('log entire day off duty', {
      now: NOW, timezone: TZ, selectedDate: PAST, existingEvents: existing,
    });
    expect(r.already_logged).toBe(true);
    expect(r.proposed_events).toHaveLength(0);
    expect(r.interpretation).toMatch(/Already logged/i);
  });

  it('conflicting entries → replace_day with the affected entries listed', () => {
    const existing = [{
      log_date: PAST,
      start_timestamp: '2026-10-14T12:00:00Z', // 8:00 AM ET
      end_timestamp: '2026-10-14T21:00:00Z',   // 5:00 PM ET
      duty_status: 'ON_DUTY',
      city: 'Dallas',
    }];
    const r = parseStationaryDay('log entire day off duty', {
      now: NOW, timezone: TZ, selectedDate: PAST, existingEvents: existing,
    });
    expect(r.intent).toBe('replace_day');
    expect(r.replaces_existing?.length).toBeGreaterThan(0);
    expect(r.proposed_events).toHaveLength(1);
    expect(r.proposed_events[0].duty_status).toBe('OFF_DUTY');
  });
});

describe('time ranges honor the selected date', () => {
  it('start on the selected day; a midnight-crossing range ends the next day', () => {
    const det = parseVoiceCommand('off duty from 10 pm to 6 am', {
      now: NOW, timezone: TZ, events: [], selectedDate: PAST,
    });
    expect(det.handled).toBe(true);
    expect(det.events).toHaveLength(1);
    expect(tzDate(det.events[0].start_timestamp)).toBe(PAST);
    expect(tzDate(det.events[0].end_timestamp)).toBe('2026-10-15');
  });
});

describe('TODAY cap — future hours are never saved as completed activity', () => {
  it("today's full-day request ends at now and carries a PARTIAL DAY note", () => {
    const r = parseStationaryDay('log entire day off duty', {
      now: NOW, timezone: TZ, selectedDate: TODAY, existingEvents: [],
    });
    expect(r.matched).toBe(true);
    const ev = r.proposed_events[0];
    expect(tzDate(ev.start_timestamp)).toBe(TODAY);
    const endH = new Date(ev.end_timestamp).getUTCHours();
    expect(endH).toBe(4); // 00:50 ET → 04:50 UTC
    expect(ev.review_notes?.[0]?.title).toMatch(/PARTIAL DAY/i);
  });

  it('a future-only range on today asks instead of inventing completed time', () => {
    const r = parseStationaryDay('off duty all night in Dallas Texas', {
      now: NOW, timezone: TZ, selectedDate: TODAY, existingEvents: [],
    });
    // all-night without a range asks for the times — never invents hours.
    expect(r.requires_clarification).toBe(true);
  });
});

describe('day coverage analysis', () => {
  const dayStart = new Date('2026-10-14T04:00:00Z');
  const dayEnd = new Date('2026-10-15T04:00:00Z');

  it('classifies empty / fullyRest / conflict', () => {
    expect(analyzeDayCoverage([], dayStart, dayEnd, NOW).kind).toBe('empty');
    expect(analyzeDayCoverage([{ start_timestamp: dayStart.toISOString(), end_timestamp: dayEnd.toISOString(), duty_status: 'OFF_DUTY' }], dayStart, dayEnd, NOW).kind).toBe('fullyRest');
    expect(analyzeDayCoverage([{ start_timestamp: '2026-10-14T14:00:00Z', end_timestamp: '2026-10-14T20:00:00Z', duty_status: 'DRIVING' }], dayStart, dayEnd, NOW).kind).toBe('conflict');
  });

  it('restCoversRange detects identical existing coverage', () => {
    const existing = [{ start_timestamp: dayStart.toISOString(), end_timestamp: dayEnd.toISOString(), duty_status: 'SLEEPER_BERTH' }];
    expect(restCoversRange(existing, dayStart.getTime(), dayEnd.getTime(), NOW)).toBe(true);
    expect(restCoversRange([], dayStart.getTime(), dayEnd.getTime(), NOW)).toBe(false);
  });
});