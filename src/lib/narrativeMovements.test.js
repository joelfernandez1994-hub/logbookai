import { describe, it, expect } from 'vitest';
import {
  extractDescribedMovements,
  movementCovered,
  describedMovementCoverage,
} from './narrativeMovements';
import { validateProposal, hasBlocking } from './proposalValidation';

const DAY = '2026-08-24';
const TZ = 'America/New_York';
const base = new Date(`${DAY}T00:00:00-04:00`);
const H = 3600000;
const iso = (h) => new Date(base.getTime() + h * H).toISOString();
const ev = (status, s, e, city, state = 'FL') => ({
  duty_status: status, start_timestamp: iso(s), end_timestamp: iso(e), city, state,
});

describe('extractDescribedMovements', () => {
  it('captures "drove to X" from the narrative', () => {
    const m = extractDescribedMovements('unloaded in Ocala then drove to Gainesville and did my post-trip');
    expect(m.length).toBeGreaterThanOrEqual(1);
    expect(m[0].to.city.toLowerCase()).toBe('gainesville');
    expect(m[0].evidence).toBe('regex');
  });

  it('captures origin+destination from "drove from A to B"', () => {
    const m = extractDescribedMovements('I drove from Ocala, FL to Gainesville, FL');
    expect(m[0].from.city.toLowerCase()).toBe('ocala');
    expect(m[0].to.city.toLowerCase()).toBe('gainesville');
  });

  it('does not invent a movement when cities differ but no driving was described', () => {
    const m = extractDescribedMovements('unloaded in Ocala, post-trip in Gainesville');
    expect(m.length).toBe(0);
  });

  it('AI backstop catches a transition the regex missed', () => {
    const m = extractDescribedMovements('finished up', { summary: 'You then drove to Gainesville for your post-trip.' });
    expect(m.length).toBeGreaterThanOrEqual(1);
    expect(m[0].evidence).toBe('ai_provenance');
    expect(m[0].to.city.toLowerCase()).toBe('gainesville');
  });
});

describe('movementCovered', () => {
  const withDrive = [
    ev('ON_DUTY', 12, 12.83, 'Ocala'),
    ev('DRIVING', 12.83, 13.25, 'Ocala'),
    ev('ON_DUTY', 13.25, 13.5, 'Gainesville'),
  ];
  const withoutDrive = [
    ev('ON_DUTY', 12, 12.83, 'Ocala'),
    ev('ON_DUTY', 12.83, 13.5, 'Gainesville'),
  ];

  it('covered when a DRIVING precedes an event at the destination', () => {
    expect(movementCovered(withDrive, { from: { city: 'Ocala' }, to: { city: 'Gainesville' } })).toBe(true);
  });

  it('not covered when the DRIVING leg is missing', () => {
    expect(movementCovered(withoutDrive, { from: { city: 'Ocala' }, to: { city: 'Gainesville' } })).toBe(false);
  });

  it('destination-only movement covered by any drive ending at B', () => {
    expect(movementCovered(withDrive, { from: null, to: { city: 'Gainesville' } })).toBe(true);
  });
});

describe('validateProposal described-movement gate', () => {
  it('blocks when described driving has no matching Driving event', () => {
    const proposed = [ev('ON_DUTY', 12, 12.83, 'Ocala'), ev('ON_DUTY', 12.83, 13.5, 'Gainesville')];
    const res = validateProposal([], proposed, {
      cycleType: '70_8', tz: TZ, now: new Date(iso(14)),
      narrative: 'unloaded in Ocala then drove to Gainesville and did my post-trip',
    });
    expect(hasBlocking(res.warnings)).toBe(true);
    expect(res.warnings.some(w => w.type === 'described_movement_missing')).toBe(true);
  });

  it('does not block when the Driving leg is present', () => {
    const proposed = [ev('ON_DUTY', 12, 12.83, 'Ocala'), ev('DRIVING', 12.83, 13.25, 'Ocala'), ev('ON_DUTY', 13.25, 13.5, 'Gainesville')];
    const res = validateProposal([], proposed, {
      cycleType: '70_8', tz: TZ, now: new Date(iso(14)),
      narrative: 'unloaded in Ocala then drove to Gainesville and did my post-trip',
    });
    expect(res.warnings.some(w => w.type === 'described_movement_missing')).toBe(false);
  });

  it('does not invent a block from a bare city difference with no described driving', () => {
    const proposed = [ev('ON_DUTY', 12, 12.83, 'Ocala'), ev('ON_DUTY', 12.83, 13.5, 'Gainesville')];
    const res = validateProposal([], proposed, {
      cycleType: '70_8', tz: TZ, now: new Date(iso(14)),
      narrative: 'unloaded in Ocala, post-trip in Gainesville',
    });
    expect(res.warnings.some(w => w.type === 'described_movement_missing')).toBe(false);
  });
});

// ============================================================================
// REGRESSION — "log me off duty all day in <city>" falsely blocked with
// DESCRIBED DRIVING MISSING.
// ----------------------------------------------------------------------------
// Reported: a purely stationary request ("log me off duty all day in
// Houston, TX") was blocked on Confirm & Apply because the AI backend's
// provenance (location_confirmations, or its own paraphrase) named the city,
// and the movement-guard backstop treated ANY named location as a described
// destination — even though the driver's own words never mentioned driving
// anywhere. stationaryDayRule.js already prevents this on its own
// deterministic fast-path (via the `stationary` flag), but the AI path is
// still reachable whenever the driver's exact phrasing doesn't match that
// rule's stricter pattern; the AI-provenance backstop needed the same
// "driver's words must actually describe travel" gate.
// ============================================================================
describe('REGRESSION — stationary narrative is never reinterpreted as a described movement', () => {
  it('extractDescribedMovements finds nothing when the narrative has no travel verb, even if location_confirmations names a different city', () => {
    const m = extractDescribedMovements('log me off duty all day in Houston, TX', {
      location_confirmations: [{ original: 'wherever I was', interpreted: 'Houston, TX' }],
    });
    expect(m).toEqual([]);
  });

  it('extractDescribedMovements finds nothing when the AI\'s own paraphrase names the city but the narrative itself never described driving', () => {
    const m = extractDescribedMovements('log me off duty all day in Houston, TX', {
      summary: 'This will record an OFF_DUTY event for the entire day on 2026-09-15 in Houston, TX.',
    });
    expect(m).toEqual([]);
  });

  it('validateProposal produces zero "described driving missing" warnings for a stationary, non-deterministic-path (AI) proposal', () => {
    // Simulates the AI backend's output for a purely stationary day request
    // that did NOT go through stationaryDayRule's deterministic parser (so
    // the events are NOT flagged `stationary: true`) — the backstop gate is
    // the only thing standing between this and a false block.
    const proposed = [{
      duty_status: 'OFF_DUTY', city: 'Houston', state: 'TX',
      start_timestamp: iso(0), end_timestamp: iso(24),
    }];
    const res = validateProposal([], proposed, {
      cycleType: '70_8', tz: TZ, now: new Date(iso(25)),
      narrative: 'log me off duty all day in Houston, TX',
      provenance: { location_confirmations: [{ original: 'my current city', interpreted: 'Houston, TX' }] },
    });
    expect(res.warnings.some(w => w.type === 'described_movement_missing')).toBe(false);
  });

  it('the backstop still fires for an EMPTY narrative (existing behavior preserved — some callers rely on location_confirmations alone)', () => {
    const m = extractDescribedMovements('', {
      location_confirmations: [{ original: 'Miami', interpreted: 'Atlanta, GA' }],
    });
    expect(m.length).toBeGreaterThanOrEqual(1);
    expect(m[0].to.city.toLowerCase()).toBe('atlanta');
  });

  it('a genuine travel narrative still triggers the backstop when the regex misses the exact verb form', () => {
    const m = extractDescribedMovements('arrived in Dallas, TX after a long day', {
      summary: 'The driver arrived in Dallas, TX.',
      location_confirmations: [{ original: 'Fort Worth', interpreted: 'Dallas, TX' }],
    });
    expect(m.length).toBeGreaterThanOrEqual(1);
  });
});