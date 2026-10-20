// ============================================================================
// REGRESSION — DESCRIBED DRIVING MISSING false positive (route intent).
// ----------------------------------------------------------------------------
// Reported: "Log me driving to San Antonio, TX" (current location Houston, TX)
// produced a blocking "You described driving to Houston, TX, but no Driving
// event connects to it" warning. Root cause: the AI-provenance movement
// backstop treated the CURRENT-LOCATION confirmation ("current location" →
// "Houston, TX") as a described movement destination, requiring a previous
// drive INTO the trip's own origin. An origin is never a required arrival:
// these tests pin the deterministic origin/current-location classification.
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  extractDescribedMovements,
  extractNarrativeOrigins,
  originCitySet,
  movementCovered,
  describedMovementCoverage,
} from './narrativeMovements';
import { validateProposal, addRouteWarning, hasBlocking } from './proposalValidation';

const DAY = '2026-10-18';
const TZ = 'America/New_York';
const base = new Date(`${DAY}T00:00:00-04:00`);
const H = 3600000;
const iso = (h) => new Date(base.getTime() + h * H).toISOString();
const ev = (status, s, e, city, state = 'TX', extra = {}) => ({
  duty_status: status, start_timestamp: iso(s), end_timestamp: iso(e), city, state, ...extra,
});

// The proposal the screenshot showed: Off Duty in Houston until 06:00, a
// 15-minute pre-trip, then Driving 06:15–09:45 arriving in San Antonio.
const sanAntonioProposal = [
  ev('OFF_DUTY', 0, 6, 'Houston'),
  ev('ON_DUTY', 6, 6.25, 'Houston', 'TX', { activity_type: 'Pre-Trip Inspection' }),
  ev('DRIVING', 6.25, 9.75, 'Houston', 'TX', { destination_city: 'San Antonio', destination_state: 'TX' }),
];
const houstonOriginProvenance = {
  summary: 'This will record you as Off Duty in Houston, TX until 06:00, perform a 15-minute pre-trip inspection, and begin driving at 06:15 for 3.5 hours arriving in San Antonio, TX at 09:45.',
  location_confirmations: [
    { original: 'current location', interpreted: 'Houston, TX' },
    { original: 'San Antonio', interpreted: 'San Antonio, TX' },
  ],
};

describe('REGRESSION — origin is never a required arrival (reported San Antonio false positive)', () => {
  it('"Log me driving to San Antonio, TX" raises no warning for Houston', () => {
    const w = describedMovementCoverage(sanAntonioProposal, 'Log me driving to San Antonio, TX', houstonOriginProvenance);
    expect(w).toEqual([]);
  });

  it('"I\'m in Houston, driving to San Antonio" recognizes Houston as the origin', () => {
    const w = describedMovementCoverage(
      sanAntonioProposal,
      "I'm in Houston, driving to San Antonio",
      houstonOriginProvenance,
    );
    expect(w.some(x => /Houston/i.test(x.movement?.to?.city || ''))).toBe(false);
    expect(w).toEqual([]);
  });

  it('"I\'m off duty in Houston until 6 AM, then driving to San Antonio" requires no incoming drive to Houston', () => {
    const proposed = [
      ev('OFF_DUTY', 0, 6, 'Houston'),
      ev('DRIVING', 6.25, 9.75, 'Houston', 'TX', { destination_city: 'San Antonio', destination_state: 'TX' }),
    ];
    const w = describedMovementCoverage(
      proposed,
      "I'm off duty in Houston until 6 AM, then driving to San Antonio",
      houstonOriginProvenance,
    );
    expect(w).toEqual([]);
  });

  it('origin classification is deterministic from the narrative alone', () => {
    expect(extractNarrativeOrigins("I'm in Houston, driving to San Antonio")).toContain('Houston');
    expect(extractNarrativeOrigins("I'm off duty in Houston until 6 AM, then driving to San Antonio")).toContain('Houston');
    expect(extractNarrativeOrigins('drove from Dallas to Houston')).toEqual([]);
  });

  it('origin classification reads the proposal structure (start city of every leg)', () => {
    const set = originCitySet(sanAntonioProposal, '');
    expect(set.has('houston')).toBe(true);
    expect(set.has('san antonio')).toBe(false);
  });

  it('"drove to X" (explicit travel verb) still requires coverage even when X is also an origin', () => {
    // Driver's own words keep full strictness — the origin gate only filters
    // AI-provenance backstop candidates.
    const moves = extractDescribedMovements("I'm in Dallas, drove to Houston, then drove to San Antonio");
    expect(moves.some(m => m.to.city.toLowerCase() === 'houston' && m.evidence === 'regex')).toBe(true);
    const w = describedMovementCoverage(sanAntonioProposal, "I'm in Dallas, drove to Houston, then drove to San Antonio", {});
    expect(w.some(x => x.type === 'described_movement_missing' && /Houston/i.test(x.movement.to.city))).toBe(true);
  });
});

describe('REGRESSION — both explicitly described legs of a chained trip are represented', () => {
  const narrative = 'I drove from Dallas to Houston, then Houston to San Antonio';
  const chainedProposal = [
    ev('ON_DUTY', 8, 8.25, 'Dallas', 'TX', { activity_type: 'Loading' }),
    ev('DRIVING', 8.25, 11.75, 'Dallas', 'TX', { destination_city: 'Houston', destination_state: 'TX' }),
    ev('ON_DUTY', 11.75, 12, 'Houston'),
    ev('DRIVING', 12, 15.5, 'Houston', 'TX', { destination_city: 'San Antonio', destination_state: 'TX' }),
    ev('ON_DUTY', 15.5, 16, 'San Antonio'),
  ];

  it('complete proposal: no missing-driving warning', () => {
    const w = describedMovementCoverage(chainedProposal, narrative, houstonOriginProvenance);
    expect(w).toEqual([]);
  });

  it('omitted San Antonio leg still triggers the warning (through validateProposal)', () => {
    const withoutLeg2 = chainedProposal.slice(0, 3);
    const res = validateProposal([], withoutLeg2, {
      cycleType: '70_8', tz: TZ, now: new Date(iso(17)),
      narrative,
      provenance: {
        summary: 'This will record driving from Dallas, TX to Houston, TX. Driving to San Antonio, TX is not included.',
        location_confirmations: [{ original: 'San Antonio', interpreted: 'San Antonio, TX' }],
      },
    });
    expect(res.warnings.some(w => w.type === 'described_movement_missing')).toBe(true);
    expect(hasBlocking(res.warnings)).toBe(true);
  });

  it('omitted first leg (destination-only request) still triggers the warning', () => {
    // "Log me driving to San Antonio, TX" with the drive left out entirely:
    // San Antonio must be flagged; Houston (origin) must NOT be.
    const res = validateProposal([], [ev('OFF_DUTY', 0, 6, 'Houston')], {
      cycleType: '70_8', tz: TZ, now: new Date(iso(7)),
      narrative: 'Log me driving to San Antonio, TX',
      provenance: {
        summary: 'This will record Off Duty in Houston, TX until 06:00. Driving to San Antonio, TX is not included.',
        location_confirmations: [{ original: 'current location', interpreted: 'Houston, TX' }],
      },
    });
    const missing = res.warnings.filter(w => w.type === 'described_movement_missing');
    expect(missing.length).toBe(1);
    expect(/San Antonio/i.test(missing[0].movement.to.city)).toBe(true);
    expect(/Houston/i.test(missing[0].movement.to.city)).toBe(false);
  });
});

describe('REGRESSION — route validation presentation and independence', () => {
  const cleanLeg = (over = {}) => ({
    eventIndex: 0,
    event: sanAntonioProposal[2],
    origin: 'Houston, TX',
    destination: 'San Antonio, TX',
    destinationKnown: true,
    isOngoing: false,
    drivingHours: 3.5,
    nextExplicitStartMs: null,
    evaluation: { known: true, conflict: false, miles: 196, note: 'Road route ~196 mi · realistic truck time ~3.6 h. Proposed driving time is plausible.' },
    ...over,
  });

  it('conflict-free route validation is informational (success), never a warning', async () => {
    const w = await addRouteWarning(sanAntonioProposal, { legs: [cleanLeg()], routingProvider: async () => { throw new Error('not called'); } });
    expect(w.severity).toBe('success');
    expect(w.isInformational).toBe(true);
    expect(w.blockingConflicts).toEqual([]);
    expect(w.explicitConflictLegs).toEqual([]);
  });

  it('a conflicting inferred-time leg still blocks; a fully-explicit one still requires acknowledgment', async () => {
    const inferred = cleanLeg({ event: { ...sanAntonioProposal[2], field_provenance: { start_time: 'explicit', end_time: 'inferred' } } });
    inferred.evaluation = { ...inferred.evaluation, conflict: true, note: 'too fast' };
    const wInferred = await addRouteWarning(sanAntonioProposal, { legs: [inferred] });
    expect(wInferred.severity).toBe('blocking');
    expect(wInferred.blockingConflicts.length).toBe(1);

    const explicit = cleanLeg({ event: { ...sanAntonioProposal[2], field_provenance: { start_time: 'explicit', end_time: 'explicit' } } });
    explicit.evaluation = { ...explicit.evaluation, conflict: true, note: 'too fast' };
    const wExplicit = await addRouteWarning(sanAntonioProposal, { legs: [explicit] });
    expect(wExplicit.severity).toBe('review');
    expect(wExplicit.requiresAcknowledgment).toBe(true);
    expect(wExplicit.blockingConflicts).toEqual([]);
  });

  it('coverage warnings never fabricate events, mileage, or history (pure validation output)', () => {
    const before = JSON.stringify(sanAntonioProposal);
    const w = describedMovementCoverage([ev('OFF_DUTY', 0, 6, 'Houston')], 'Log me driving to San Antonio, TX', houstonOriginProvenance);
    expect(w.every(x => !x.event && x.mileage === undefined)).toBe(true);
    expect(JSON.stringify(sanAntonioProposal)).toBe(before);
  });
});