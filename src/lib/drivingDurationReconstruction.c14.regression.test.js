// ============================================================================
// LogbookAI — REGRESSION: route reconstruction must never produce an event that
// ends before it starts (found by replaying the REAL Phase 1 live output for C14).
// ----------------------------------------------------------------------------
// Live prompt: "Started in Dallas at 6 AM, did a 20 minute pretrip, drove to
// Houston, fueled for 15 minutes, then drove to San Antonio and shut down."
// The live model's proposal (times/provenance copied from window.__liveAiResults):
//   ON_DUTY  Dallas       06:00-06:20  (pretrip)
//   DRIVING  Dallas       06:20-10:00  end INFERRED
//   ON_DUTY  Houston      10:00-10:15  START inferred, END marked "explicit" (a 15-min duration)
//   DRIVING  Houston      10:15-13:30  START "explicit", end inferred
//   OFF_DUTY San Antonio  13:30-open   start inferred
// Dallas->Houston needs ~4.3 h of truck time, so reconstruction extended the first
// drive to 10:39 and shifted the fuel stop's inferred START to 10:39 — past its
// unmoved explicit END (10:15). Result: a fuel event ending before it started, the
// events re-ordered so the second Driving sorted BEFORE the fuel stop, and a false
// blocking "DESCRIBED DRIVING MISSING" on the San Antonio leg.
// ============================================================================
import { describe, it, expect, vi } from 'vitest';
vi.mock('@/api/base44Client', () => ({ base44: {} }));
import { validateInterpretResult } from './aiLayer';
import { normalizeCandidateTimeline } from './timelineNormalization';
import { enrichProposalMileage, addRouteWarning, validateProposal } from './proposalValidation';
import { reconstructDrivingDurations } from './drivingDurationReconstruction';

const TZ = 'America/New_York';
const NOW = new Date('2026-09-21T23:30:00Z');
const INPUT = 'Started in Dallas at 6 AM, did a 20 minute pretrip, drove to Houston, fueled for 15 minutes, then drove to San Antonio and shut down.';
const ROUTES = { 'Dallas, TX|Houston, TX': { miles: 238, hours: 3.6 }, 'Houston, TX|San Antonio, TX': { miles: 196, hours: 3.0 } };
const provider = async (o, d) => ROUTES[`${o}|${d}`] || null;

const fp = (start_time, end_time, status = 'explicit', city = 'explicit', state = 'inferred') => ({ start_time, end_time, status, city, state });
const ev = (duty_status, start, end, city, state, prov, ambiguous_fields = []) => ({
  duty_status, start_timestamp: start, end_timestamp: end, city, state, field_provenance: prov, ambiguous_fields, adjustments: [], source: 'typed', edit_target_index: null,
});
// EXACT live C14 proposal (UTC; America/New_York is UTC-4 in September).
const LIVE_C14 = () => [
  ev('ON_DUTY', '2026-09-21T10:00:00.000Z', '2026-09-21T10:20:00.000Z', 'Dallas', 'TX', fp('explicit', 'explicit', 'inferred', 'explicit')),
  ev('DRIVING', '2026-09-21T10:20:00.000Z', '2026-09-21T14:00:00.000Z', 'Dallas', 'TX', fp('explicit', 'inferred'), ['end_time']),
  ev('ON_DUTY', '2026-09-21T14:00:00.000Z', '2026-09-21T14:15:00.000Z', 'Houston', 'TX', fp('inferred', 'explicit', 'inferred', 'inferred')),
  ev('DRIVING', '2026-09-21T14:15:00.000Z', '2026-09-21T17:30:00.000Z', 'Houston', 'TX', fp('explicit', 'inferred', 'explicit', 'inferred'), ['end_time']),
  ev('OFF_DUTY', '2026-09-21T17:30:00.000Z', null, 'San Antonio', 'TX', fp('inferred', 'explicit', 'inferred', 'inferred'), ['start_time']),
];

// The app's proposal-time path (LogAssistant.prepareProposal + ProposalReview).
async function appPipeline(events) {
  const { normalized } = validateInterpretResult({ intent: 'add_events', proposed_events: events, location_confirmations: [], original_input: INPUT, deterministic_explicit_facts: { times: [], locations: [], statuses: [] } });
  const { events: selfN } = normalizeCandidateTimeline(normalized.proposed_events);
  const enriched = await enrichProposalMileage(selfN, { routingProvider: provider, speedProfile: 'conservative', now: NOW, narrative: INPUT });
  const { events: rec, conflicts } = reconstructDrivingDurations(enriched.events, enriched.legs, { now: NOW });
  const routeWarning = await addRouteWarning(rec, { routingProvider: provider, speedProfile: 'conservative', now: NOW, isFuture: false });
  const v = validateProposal([], rec, { tz: TZ, now: NOW, isFuture: false, narrative: INPUT, provenance: normalized, explicitGuard: normalized.explicit_guard, cycleType: '70_8' });
  return { rec, conflicts, routeWarning, warnings: v.warnings };
}

describe('C14 (live shape): inferred-start / explicit-end event is never shifted past its own end', () => {
  it('every event keeps a positive duration and the chronological order the model gave', async () => {
    const { rec } = await appPipeline(LIVE_C14());
    rec.forEach((e) => { if (e.end_timestamp) expect(new Date(e.end_timestamp).getTime()).toBeGreaterThan(new Date(e.start_timestamp).getTime()); });
    expect(rec.map((e) => e.duty_status)).toEqual(['ON_DUTY', 'DRIVING', 'ON_DUTY', 'DRIVING', 'OFF_DUTY']);
    const starts = rec.map((e) => new Date(e.start_timestamp).getTime());
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
  });

  it('explicit times are untouched (fuel end 10:15 ET, second drive start 10:15 ET)', async () => {
    const { rec } = await appPipeline(LIVE_C14());
    expect(rec[2].end_timestamp).toBe('2026-09-21T14:15:00.000Z');
    expect(rec[3].start_timestamp).toBe('2026-09-21T14:15:00.000Z');
  });

  it('no negative_duration and no false "DESCRIBED DRIVING MISSING" on the San Antonio leg', async () => {
    const { warnings } = await appPipeline(LIVE_C14());
    const types = warnings.map((w) => w.type);
    expect(types).not.toContain('negative_duration');
    expect(types).not.toContain('described_movement_missing');
  });

  it('route validation is NOT weakened: Dallas->Houston at 3.7 h (needs ~4.3 h) is still a blocking route conflict', async () => {
    const { routeWarning } = await appPipeline(LIVE_C14());
    expect(routeWarning).not.toBeNull();
    expect(routeWarning.severity).toBe('blocking');
    expect(routeWarning.blockingConflicts.map((l) => l.origin)).toContain('Dallas, TX');
  });

  it('the skipped reconstruction is surfaced as a review conflict, not silently dropped', async () => {
    const { conflicts } = await appPipeline(LIVE_C14());
    expect(conflicts.length).toBeGreaterThan(0);
    expect(conflicts[0].severity).toBe('review');
    expect(conflicts[0].message).toMatch(/Dallas/);
  });
});

describe('reconstruction still works when there is room (positive controls)', () => {
  it('all-inferred cascade: the first drive grows to route time and the later inferred events shift with it', async () => {
    const events = LIVE_C14();
    events[2] = ev('ON_DUTY', '2026-09-21T14:00:00.000Z', '2026-09-21T14:15:00.000Z', 'Houston', 'TX', fp('inferred', 'inferred', 'inferred', 'inferred'));
    events[3] = ev('DRIVING', '2026-09-21T14:15:00.000Z', '2026-09-21T17:30:00.000Z', 'Houston', 'TX', fp('inferred', 'inferred', 'explicit', 'inferred'), ['end_time']);
    const { rec, conflicts } = await appPipeline(events);
    // 238 mi / 55 mph = 4.327 h from 10:20 ET-equivalent start (14:20Z-4h... UTC 10:20)
    const grown = new Date(rec[1].end_timestamp).getTime() - new Date(rec[1].start_timestamp).getTime();
    expect(grown / 3600000).toBeCloseTo(238 / 55, 2);
    expect(new Date(rec[2].start_timestamp).getTime()).toBe(new Date(rec[1].end_timestamp).getTime());
    expect(conflicts).toEqual([]);
    rec.forEach((e) => { if (e.end_timestamp) expect(new Date(e.end_timestamp).getTime()).toBeGreaterThan(new Date(e.start_timestamp).getTime()); });
  });

  it('an explicit end that still leaves room after the shift keeps its explicit end and shrinks only its inferred start', () => {
    const events = [
      ev('DRIVING', '2026-09-21T10:00:00.000Z', '2026-09-21T13:00:00.000Z', 'Dallas', 'TX', fp('explicit', 'inferred'), ['end_time']),
      ev('ON_DUTY', '2026-09-21T13:00:00.000Z', '2026-09-21T16:00:00.000Z', 'Houston', 'TX', fp('inferred', 'explicit')),
    ];
    const legs = [{ eventIndex: 0, evaluation: { requiredTruckTime: 4.33 } }];
    const { events: out, conflicts } = reconstructDrivingDurations(events, legs, { now: NOW });
    expect(out[1].end_timestamp).toBe('2026-09-21T16:00:00.000Z');           // explicit end never moves
    expect(new Date(out[1].start_timestamp).getTime()).toBe(new Date(out[0].end_timestamp).getTime());
    expect(new Date(out[1].start_timestamp).getTime()).toBeLessThan(new Date(out[1].end_timestamp).getTime());
    expect(conflicts).toEqual([]);
  });

  it('a genuine explicit-vs-route contradiction is left as the AI gave it (no reconstruction) and flagged', () => {
    const events = [
      ev('DRIVING', '2026-09-21T10:00:00.000Z', '2026-09-21T13:00:00.000Z', 'Dallas', 'TX', fp('explicit', 'inferred'), ['end_time']),
      ev('ON_DUTY', '2026-09-21T13:00:00.000Z', '2026-09-21T13:15:00.000Z', 'Houston', 'TX', fp('inferred', 'explicit')),
    ];
    const legs = [{ eventIndex: 0, origin: 'Dallas, TX', destination: 'Houston, TX', evaluation: { requiredTruckTime: 4.33 } }];
    const { events: out, conflicts } = reconstructDrivingDurations(events, legs, { now: NOW });
    expect(out[0].end_timestamp).toBe('2026-09-21T13:00:00.000Z');
    expect(out[1].start_timestamp).toBe('2026-09-21T13:00:00.000Z');
    expect(out[1].end_timestamp).toBe('2026-09-21T13:15:00.000Z');
    expect(conflicts).toHaveLength(1);
  });
});
