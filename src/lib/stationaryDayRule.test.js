import { describe, it, expect } from 'vitest';
import { parseStationaryDay } from './stationaryDayRule';
import { describedMovementCoverage } from './narrativeMovements';
import { validateProposal, hasBlocking } from './proposalValidation';

// Monday, no DST edge. America/New_York (UTC-04:00 in August).
const NOW = new Date('2026-08-24T10:00:00-04:00');
const TZ = 'America/New_York';
const H = 3600000;

function tzHour(iso) {
  return Number(new Date(iso).toLocaleString('en-US', { hour: '2-digit', hour12: false, timeZone: TZ }).slice(0, 2));
}
function tzDate(iso) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: TZ });
}

describe('parseStationaryDay — full day', () => {
  it('off duty all day in Indianapolis Indiana', () => {
    const r = parseStationaryDay('off duty all day in Indianapolis Indiana', { now: NOW, timezone: TZ });
    expect(r.matched).toBe(true);
    expect(r.intent).toBe('replace_day');
    expect(r.requires_clarification).toBe(false);
    expect(r.proposed_events).toHaveLength(1);
    const ev = r.proposed_events[0];
    expect(ev.duty_status).toBe('OFF_DUTY');
    expect(ev.city).toBe('Indianapolis');
    expect(ev.state).toBe('IN');
    expect(ev.stationary).toBe(true);
    expect(tzHour(ev.start_timestamp)).toBe(0);
    expect(tzDate(ev.end_timestamp)).not.toBe(tzDate(ev.start_timestamp)); // ends next local midnight
    const totalH = (new Date(ev.end_timestamp) - new Date(ev.start_timestamp)) / H;
    expect(totalH).toBeCloseTo(24, 2);
  });

  it('off duty all day in Miami Florida', () => {
    const r = parseStationaryDay('off duty all day in Miami Florida', { now: NOW, timezone: TZ });
    expect(r.matched).toBe(true);
    expect(r.proposed_events[0]).toMatchObject({ duty_status: 'OFF_DUTY', city: 'Miami', state: 'FL', stationary: true });
  });

  it('I was off duty all day in Dallas Texas', () => {
    const r = parseStationaryDay('I was off duty all day in Dallas Texas', { now: NOW, timezone: TZ });
    expect(r.matched).toBe(true);
    expect(r.proposed_events[0]).toMatchObject({ duty_status: 'OFF_DUTY', city: 'Dallas', state: 'TX', stationary: true });
  });

  it('sleeper all day in Atlanta Georgia', () => {
    const r = parseStationaryDay('sleeper all day in Atlanta Georgia', { now: NOW, timezone: TZ });
    expect(r.matched).toBe(true);
    expect(r.proposed_events[0]).toMatchObject({ duty_status: 'SLEEPER_BERTH', city: 'Atlanta', state: 'GA', stationary: true });
    const totalH = (new Date(r.proposed_events[0].end_timestamp) - new Date(r.proposed_events[0].start_timestamp)) / H;
    expect(totalH).toBeCloseTo(24, 2);
  });

  it('accepts "City, ST" two-letter codes', () => {
    const r = parseStationaryDay('off duty all day in Indianapolis, IN', { now: NOW, timezone: TZ });
    expect(r.matched).toBe(true);
    expect(r.proposed_events[0]).toMatchObject({ city: 'Indianapolis', state: 'IN' });
  });

  it('Spanish: fuera de servicio todo el día en Indianapolis, Indiana', () => {
    const r = parseStationaryDay('fuera de servicio todo el día en Indianapolis, Indiana', { now: NOW, timezone: TZ });
    expect(r.matched).toBe(true);
    expect(r.proposed_events[0]).toMatchObject({ duty_status: 'OFF_DUTY', city: 'Indianapolis', state: 'IN' });
  });

  it('Spanish: litera todo el día en Atlanta Georgia', () => {
    const r = parseStationaryDay('litera todo el día en Atlanta Georgia', { now: NOW, timezone: TZ });
    expect(r.matched).toBe(true);
    expect(r.proposed_events[0]).toMatchObject({ duty_status: 'SLEEPER_BERTH', city: 'Atlanta', state: 'GA' });
  });
});

describe('parseStationaryDay — all night', () => {
  it('asks for the times when none are stated (never invents a 24h day)', () => {
    const r = parseStationaryDay('off duty all night in Indianapolis Indiana', { now: NOW, timezone: TZ });
    expect(r.matched).toBe(true);
    expect(r.requires_clarification).toBe(true);
    expect(r.proposed_events).toHaveLength(0);
    expect(r.clarification_question).toMatch(/time/i);
  });

  it('uses the explicit stated range and crosses midnight', () => {
    const r = parseStationaryDay('off duty all night in Indianapolis Indiana from 10 PM to 6 AM', { now: NOW, timezone: TZ });
    expect(r.matched).toBe(true);
    expect(r.requires_clarification).toBe(false);
    expect(r.proposed_events).toHaveLength(1);
    const ev = r.proposed_events[0];
    expect(ev.duty_status).toBe('OFF_DUTY');
    expect(ev.city).toBe('Indianapolis');
    expect(ev.state).toBe('IN');
    expect(ev.stationary).toBe(true);
    expect(tzDate(ev.start_timestamp)).toBe('2026-08-24');
    expect(tzHour(ev.start_timestamp)).toBe(22);
    expect(tzDate(ev.end_timestamp)).toBe('2026-08-25');
    expect(tzHour(ev.end_timestamp)).toBe(6);
    const totalH = (new Date(ev.end_timestamp) - new Date(ev.start_timestamp)) / H;
    expect(totalH).toBeCloseTo(8, 2);
  });
});

describe('parseStationaryDay — negative controls (movement preserved)', () => {
  it('rejects "I drove to Indianapolis and went off duty"', () => {
    expect(parseStationaryDay('I drove to Indianapolis and went off duty', { now: NOW, timezone: TZ }).matched).toBe(false);
  });
  it('rejects "off duty in Indianapolis after driving from Chicago"', () => {
    expect(parseStationaryDay('off duty in Indianapolis after driving from Chicago', { now: NOW, timezone: TZ }).matched).toBe(false);
  });
  it('requires a recognizable state', () => {
    expect(parseStationaryDay('off duty all day in Indianapolis', { now: NOW, timezone: TZ }).matched).toBe(false);
  });
});

describe('movement validation is not weakened', () => {
  it('still blocks a missing Driving leg for a travel narrative', () => {
    // A proposed set with NO Driving event but a narrative that describes one.
    const proposed = [{
      date: '2026-08-24',
      start_timestamp: new Date('2026-08-24T14:00:00-04:00').toISOString(),
      end_timestamp: new Date('2026-08-24T22:00:00-04:00').toISOString(),
      duty_status: 'OFF_DUTY', city: 'Indianapolis', state: 'IN',
    }];
    const res = validateProposal([], proposed, {
      cycleType: '70_8', tz: TZ, now: new Date('2026-08-24T22:30:00-04:00'),
      narrative: 'I drove to Indianapolis and went off duty',
    });
    expect(res.warnings.some(w => w.type === 'described_movement_missing')).toBe(true);
    expect(hasBlocking(res.warnings)).toBe(true);
  });

  it('a stationary proposal is never flagged as a missing movement, even with a movement-laced provenance backstop', () => {
    const r = parseStationaryDay('off duty all day in Indianapolis Indiana', { now: NOW, timezone: TZ });
    const warns = describedMovementCoverage(r.proposed_events, 'off duty all day in Indianapolis Indiana', {
      summary: 'You then drove to Indianapolis, IN.',
      location_confirmations: [{ original: 'Indianapolis Indiana', interpreted: 'Indianapolis, IN' }],
    });
    expect(warns).toHaveLength(0);
  });

  it('validateProposal produces no movement / blocking warning for a full-day stationary proposal', () => {
    const r = parseStationaryDay('off duty all day in Indianapolis Indiana', { now: NOW, timezone: TZ });
    const res = validateProposal([], r.proposed_events, {
      cycleType: '70_8', tz: TZ, now: NOW,
      narrative: 'off duty all day in Indianapolis Indiana',
      provenance: { summary: r.interpretation, location_confirmations: [] },
    });
    expect(res.warnings.some(w => w.type === 'described_movement_missing')).toBe(false);
    expect(hasBlocking(res.warnings)).toBe(false);
  });
});