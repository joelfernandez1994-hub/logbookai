// Driver-stated mileage vs map route. Route figure used below (Miami -> Orlando,
// 233 mi / 4.37 h) was measured with the app's own routing stack (Nominatim + OSRM).
import { describe, it, expect } from 'vitest';
import {
  extractStatedMileages, compareStatedToRoute, statedMileageWarnings, applyStatedMileage, pairStatedMileageWithLegs,
} from './statedMileage';
import { enrichProposalMileage, inspectProposalRoutes } from './proposalValidation';

const fp = { start_time: 'explicit', end_time: 'explicit', status: 'explicit', city: 'explicit', state: 'explicit' };
const provider = async () => ({ miles: 233, hours: 4.37 });
const NOW = new Date('2026-09-21T20:00:00Z');
const proposal = () => ([
  { duty_status: 'DRIVING', city: 'Miami', state: 'FL', start_timestamp: '2026-09-21T12:00:00.000Z', end_timestamp: '2026-09-21T17:00:00.000Z', field_provenance: fp },
  { duty_status: 'ON_DUTY', city: 'Orlando', state: 'FL', start_timestamp: '2026-09-21T17:00:00.000Z', end_timestamp: '2026-09-21T18:00:00.000Z', field_provenance: fp },
]);

describe('extractStatedMileages', () => {
  it('finds the stated figure', () => {
    expect(extractStatedMileages('I drove 230 miles from Miami to Orlando')).toEqual([{ miles: 230, approximate: false }]);
    expect(extractStatedMileages('I drove like 300 miles')[0]).toEqual({ miles: 300, approximate: true });
    expect(extractStatedMileages('about 150 mi, then 1,020 miles')).toEqual([{ miles: 150, approximate: true }, { miles: 1020, approximate: false }]);
  });
  it('ignores speeds and non-mileage numbers', () => {
    expect(extractStatedMileages('doing 65 miles per hour for 3 hours at 6:15')).toEqual([]);
    expect(extractStatedMileages('loaded at 7, drove to Orlando')).toEqual([]);
  });
});

describe('compareStatedToRoute — small differences allowed, large ones flagged', () => {
  it.each([
    [230, false], // reasonable
    [200, false], // slightly different (-14%)
    [255, false], // odometer/detour a bit over
    [150, true],  // -36%
    [500, true],  // +115%
    [20, true],   // wildly low
  ])('stated %d mi vs 233 mi route -> mismatch=%s', (stated, mismatch) => {
    expect(compareStatedToRoute(stated, 233).mismatch).toBe(mismatch);
  });
  it('short routes use the fixed 25 mi floor (60 mi stated vs 34 mi route is flagged; 50 is not)', () => {
    expect(compareStatedToRoute(60, 34).mismatch).toBe(true);
    expect(compareStatedToRoute(50, 34).mismatch).toBe(false);
  });
});

describe('end to end through the real proposal enrichment (routing provider injected)', () => {
  const run = async (narrative) => {
    const enriched = await enrichProposalMileage(proposal(), { routingProvider: provider, now: NOW, narrative });
    return { enriched, warnings: statedMileageWarnings(enriched.legs, narrative) };
  };

  it.each([
    ['I drove 230 miles from Miami to Orlando', 230, 0],
    ['I drove 200 miles from Miami to Orlando', 200, 0],
    ['I drove 150 miles from Miami to Orlando', 150, 1],
    ['I drove 500 miles from Miami to Orlando', 500, 1],
  ])('%s', async (narrative, kept, warnCount) => {
    const { enriched, warnings } = await run(narrative);
    const drive = enriched.events.find((e) => e.duty_status === 'DRIVING');
    // The driver's figure is kept EXACTLY — never overwritten by the map's 233.
    expect(drive.mileage).toBe(kept);
    expect(drive.mileage_source).toBe('driver_stated');
    expect(drive.route_miles).toBe(233);
    expect(warnings).toHaveLength(warnCount);
    if (warnCount) {
      expect(warnings[0].severity).toBe('review'); // never a hard block
      expect(warnings[0].type).toBe('stated_mileage_mismatch');
    }
  });

  it('with no stated mileage the map figure is used as before', async () => {
    const { enriched, warnings } = await run('I drove from Miami to Orlando');
    const drive = enriched.events.find((e) => e.duty_status === 'DRIVING');
    expect(drive.mileage).toBe(233);
    expect(drive.mileage_source).toBe('route');
    expect(warnings).toHaveLength(0);
  });

  it('does not guess when the count of stated figures and route legs differ', async () => {
    const legs = await inspectProposalRoutes(proposal(), { routingProvider: provider, now: NOW });
    expect(pairStatedMileageWithLegs(legs, 'I drove 100 miles then another 100 miles')).toEqual([]);
    expect(applyStatedMileage(proposal(), legs, 'I drove 100 miles then another 100 miles').every((e) => e.mileage_source == null)).toBe(true);
  });
});
