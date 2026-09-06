// ============================================================================
// LogbookAI — regression tests for the "ongoing Driving with no destination"
// AI logging bug.
//
// Reported scenario: "Log my day off duty in Miami until 6 AM, then go on
// duty for my pre-trip, then go to driving." incorrectly produced:
//   1. a blocking "DESCRIBED DRIVING MISSING" warning, even though the
//      proposal DID include a Driving event (it's just ongoing/open-ended).
//   2. a "route/travel-time conflict" for Miami, FL -> Miami, FL, because the
//      open Driving event's own city was used as both origin AND destination
//      and evaluated against elapsed-to-now driving hours.
//
// Root causes fixed:
//   - narrativeMovements.movementCovered required a "next" event after every
//     Driving event to prove a described destination was reached. A trailing
//     ONGOING Driving event has no next event by definition; if the
//     "described" destination is just that event's own start city, it's not
//     an unfulfilled promise of a further destination.
//   - proposalValidation.getDrivingLegs fell back to the Driving event's own
//     city for BOTH origin and destination when no real neighbor supplied a
//     destination, and inspectProposalRoutes then ran route-time physics on
//     that fabricated same-city "leg" using now() as the elapsed end time.
// ============================================================================
import { describe, it, expect, vi } from 'vitest';
import { getDrivingLegs, inspectProposalRoutes, addRouteWarning, validateProposal } from './proposalValidation';
import { movementCovered, describedMovementCoverage } from './narrativeMovements';
import { detectExplicitFactAlterations } from './aiLayer';

const TZ = 'America/New_York';
const NOW = new Date('2026-09-10T14:41:00.000Z'); // well after the ongoing drive started

// The proposal LogbookAI should produce for:
// "Log my day off duty in Miami until 6 AM, then go on duty for my pre-trip
//  (15-min default), then go to driving."
function buildProposal() {
  return [
    {
      duty_status: 'OFF_DUTY', city: 'Miami', state: 'FL',
      start_timestamp: '2026-09-10T04:00:00.000Z', end_timestamp: '2026-09-10T10:00:00.000Z', // 12A-6A local (UTC-4)
      field_provenance: { start_time: 'inferred', end_time: 'explicit', status: 'explicit', city: 'explicit', state: 'explicit' },
    },
    {
      duty_status: 'ON_DUTY', city: 'Miami', state: 'FL', remark: 'Pre-Trip', activity_type: 'Pre-Trip',
      start_timestamp: '2026-09-10T10:00:00.000Z', end_timestamp: '2026-09-10T10:15:00.000Z', // 15-min default
      field_provenance: { start_time: 'explicit', end_time: 'inferred', status: 'explicit', city: 'explicit', state: 'explicit' },
      ambiguous_fields: ['end_timestamp'],
    },
    {
      duty_status: 'DRIVING', city: 'Miami', state: 'FL',
      start_timestamp: '2026-09-10T10:15:00.000Z', end_timestamp: null, is_ongoing: true,
      field_provenance: { start_time: 'explicit', end_time: 'explicit', status: 'explicit', city: 'explicit', state: 'explicit' },
    },
  ];
}

const NARRATIVE = 'Log my day off duty in Miami until 6 AM, then go on duty for my pre-trip, then go to driving.';

describe('1. "Off duty until 6 AM in Miami, on duty for pre-trip, then driving" — full proposal validation', () => {
  it('produces no blocking warnings for the described-movement gate', () => {
    const proposed = buildProposal();
    const result = validateProposal([], proposed, { cycleType: '70_8', tz: TZ, now: NOW, narrative: NARRATIVE });
    const describedMissing = result.warnings.filter((w) => w.type === 'described_movement_missing');
    expect(describedMissing).toHaveLength(0);
  });
});

describe('2. final Driving event is ongoing with no destination', () => {
  it('the proposed Driving event has end_timestamp null / is_ongoing true', () => {
    const proposed = buildProposal();
    const driving = proposed.find((e) => e.duty_status === 'DRIVING');
    expect(driving.end_timestamp).toBeNull();
    expect(driving.is_ongoing).toBe(true);
  });

  it('getDrivingLegs marks it isOngoing with no known destination, never inventing one', () => {
    const proposed = buildProposal();
    const legs = getDrivingLegs(proposed, NOW);
    expect(legs).toHaveLength(1);
    expect(legs[0].isOngoing).toBe(true);
    expect(legs[0].destinationKnown).toBe(false);
    // city/state on the leg is just the driving event's own starting
    // location — never a fabricated distinct destination.
    expect(legs[0].origin).toEqual({ city: 'Miami', state: 'FL' });
    expect(legs[0].destination).toEqual({ city: 'Miami', state: 'FL' });
  });
});

describe('3. explicit-fact guard sees Driving as present', () => {
  it('detectExplicitFactAlterations does not report DRIVING as dropped when an ongoing Driving event exists', () => {
    const proposed = buildProposal();
    // Mirrors what the backend's extractExplicitFacts() produces from the
    // literal narrative: "driving" is matched as a DRIVING status fact.
    const deterministicFacts = { statuses: [{ raw: 'driving', status: 'DRIVING' }] };
    const guard = detectExplicitFactAlterations(proposed, deterministicFacts);
    expect(guard.blocking).toBe(false);
    expect(guard.droppedExplicitEvents.some((d) => d.type === 'status' && d.value === 'driving')).toBe(false);
  });
});

describe('4. no Miami -> Miami route conflict is generated', () => {
  it('inspectProposalRoutes never calls the routing provider for the ongoing destinationless leg, and reports no conflict', async () => {
    const proposed = buildProposal();
    const routingProvider = vi.fn().mockResolvedValue({ miles: 0, hours: 4.45 });
    const legs = await inspectProposalRoutes(proposed, { routingProvider, now: NOW });
    expect(legs).toHaveLength(1);
    expect(legs[0].evaluation.known).toBe(false);
    expect(legs[0].evaluation.conflict).toBeFalsy();
    expect(routingProvider).not.toHaveBeenCalled();
  });

  it('addRouteWarning returns null (no card at all) for a proposal whose only leg is ongoing/destinationless', async () => {
    const proposed = buildProposal();
    const routingProvider = vi.fn().mockResolvedValue({ miles: 0, hours: 4.45 });
    const warning = await addRouteWarning(proposed, { routingProvider, now: NOW, isFuture: false });
    expect(warning).toBeNull();
  });
});

describe('5. route validation skips an ongoing destinationless Driving event (direct movementCovered check)', () => {
  it('movementCovered treats a described destination matching the ongoing Driving event\'s own city as satisfied', () => {
    const proposed = buildProposal();
    // Simulates the phantom "movement" a location-confirmation echo like
    // "Miami" -> "Miami, FL" could produce — not a genuinely different place.
    const movement = { from: null, to: { city: 'Miami', state: 'FL' }, evidence: 'ai_provenance' };
    expect(movementCovered(proposed, movement)).toBe(true);
  });

  it('a genuinely different described destination the proposal does not reach is still correctly flagged', () => {
    const proposed = buildProposal();
    const movement = { from: null, to: { city: 'Atlanta', state: 'GA' }, evidence: 'ai_provenance' };
    expect(movementCovered(proposed, movement)).toBe(false);
    const warnings = describedMovementCoverage(proposed, '', { location_confirmations: [{ original: 'Miami', interpreted: 'Atlanta, GA' }] });
    expect(warnings.some((w) => w.type === 'described_movement_missing')).toBe(true);
  });

  it('a completed leg that genuinely starts and ends in the same city (real neighbors on both sides) is still flagged as a conflict', async () => {
    // Guards against over-broadening the fix: this is NOT the ongoing/
    // destinationless case — both origin and destination come from real,
    // distinct non-driving events, so route physics must still apply.
    const loop = [
      { duty_status: 'ON_DUTY', city: 'Miami', state: 'FL', start_timestamp: '2026-09-10T10:00:00.000Z', end_timestamp: '2026-09-10T10:15:00.000Z', field_provenance: { start_time: 'explicit', end_time: 'explicit' } },
      { duty_status: 'DRIVING', city: 'Miami', state: 'FL', start_timestamp: '2026-09-10T10:15:00.000Z', end_timestamp: '2026-09-10T14:15:00.000Z', field_provenance: { start_time: 'explicit', end_time: 'explicit' } },
      { duty_status: 'ON_DUTY', city: 'Miami', state: 'FL', start_timestamp: '2026-09-10T14:15:00.000Z', end_timestamp: '2026-09-10T14:30:00.000Z', field_provenance: { start_time: 'explicit', end_time: 'explicit' } },
    ];
    const legs = await inspectProposalRoutes(loop, { routingProvider: vi.fn(), now: NOW });
    const driveLeg = legs.find((l) => l.event.duty_status === 'DRIVING');
    expect(driveLeg.destinationKnown).toBe(true);
    expect(driveLeg.evaluation.known).toBe(true);
    expect(driveLeg.evaluation.conflict).toBe(true);
  });
});
