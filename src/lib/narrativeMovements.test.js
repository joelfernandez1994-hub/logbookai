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