// ============================================================================
// LogbookAI — REGRESSION SUITE from the FIRST LIVE-MODEL run (Phase 1, 71 prompts,
// real manualLogAssistant, 2026-09-21, carrier tz America/New_York).
// ----------------------------------------------------------------------------
// Fixtures below are the model's ACTUAL structured proposals (times/provenance/
// cities copied from window.__liveAiResults), fed through the real client
// pipeline: validateInterpretResult -> normalizeCandidateTimeline ->
// enrichProposalMileage -> addRouteWarning -> validateProposal. Only the road
// router is stubbed (fixed miles/hours) so the suite is offline and stable.
//
// What the live run proved:
//   1. 22 travel prompts came back with ONE Driving event carrying only the
//      ORIGIN; the arrival city survived only in location_confirmations. With no
//      later event, getDrivingLegs had no destination, so the route/mileage/
//      impossible-travel check silently never ran (D01-D05, E01-E03, F01-F04),
//      and "I drove from Miami to Orlando" raised a false, unfixable
//      "DESCRIBED DRIVING MISSING" block (C10/C11).
//      -> the schema now carries destination_city/destination_state on a
//         DRIVING event, and the route legs / movement coverage consume it.
//   2. The strict schema made the model write the literal "Unknown" for an
//      unknown city/state (A08, C01, C08, C12, K02) -> now normalized to ''.
//   3. "10 PM to 4 AM" came back with the 4 AM dated BEFORE the 10 PM (G01).
// ============================================================================
import { describe, it, expect, vi } from 'vitest';
vi.mock('@/api/base44Client', () => ({ base44: {} }));
import { validateInterpretResult, rollOverEndAcrossMidnight } from './aiLayer';
import { cleanLocationText, isPlaceholderLocation } from './locationPlaceholders';
import { normalizeCandidateTimeline } from './timelineNormalization';
import { enrichProposalMileage, addRouteWarning, validateProposal, getDrivingLegs } from './proposalValidation';
import { extractDescribedMovements, movementCovered } from './narrativeMovements';
import { evaluateLive } from './liveAiEvaluator';
import { PROMPTS as LIVE_PROMPTS } from './liveAiPromptSet';

const TZ = 'America/New_York';
const NOW = new Date('2026-09-21T23:30:00Z'); // after every fixture event so no "elapsed gap" noise
const ROUTES = {
  'Miami, FL|Orlando, FL': { miles: 235, hours: 3.4 },
  'Dallas, TX|Houston, TX': { miles: 238, hours: 3.6 },
  'Atlanta, GA|Nashville, TN': { miles: 250, hours: 3.8 },
  'Chicago, IL|Indianapolis, IN': { miles: 183, hours: 2.9 },
  'Los Angeles, CA|Las Vegas, NV': { miles: 270, hours: 4.0 },
  'Phoenix, AZ|Tucson, AZ': { miles: 115, hours: 1.8 },
};
function router() {
  const calls = [];
  const provider = async (o, d) => { calls.push([o, d]); return ROUTES[`${o}|${d}`] || null; };
  return { provider, calls };
}

const explicitFp = { start_time: 'explicit', end_time: 'explicit', status: 'explicit', city: 'explicit', state: 'inferred' };
// The live model's Driving event: origin only, both times stated by the driver.
const drive = (city, state, startIso, endIso, extra = {}) => ({
  duty_status: 'DRIVING', start_timestamp: startIso, end_timestamp: endIso, city, state,
  field_provenance: explicitFp, ambiguous_fields: [], adjustments: [], source: 'typed', edit_target_index: null, ...extra,
});

async function pipeline(input, events, locConf = []) {
  const { normalized } = validateInterpretResult({
    intent: 'add_events', proposed_events: events, location_confirmations: locConf, original_input: input,
    deterministic_explicit_facts: { times: [], locations: [], statuses: [] },
  });
  const r = router();
  const { events: selfN } = normalizeCandidateTimeline(normalized.proposed_events);
  const enriched = await enrichProposalMileage(selfN, { routingProvider: r.provider, speedProfile: 'conservative', now: NOW, narrative: input });
  const routeWarning = await addRouteWarning(enriched.events, { routingProvider: r.provider, speedProfile: 'conservative', now: NOW, isFuture: false });
  const v = validateProposal([], enriched.events, { tz: TZ, now: NOW, isFuture: false, narrative: input, provenance: normalized, explicitGuard: normalized.explicit_guard, cycleType: '70_8' });
  return { normalized, enriched, routeWarning, warnings: v.warnings, calls: r.calls };
}

// ---- 1. impossible / plausible / mileage travel prompts (D01-D05, E01-E03, F03-F04) ----
const LOCCONF = (a, b) => [{ original: a[0], interpreted: a[1] }, { original: b[0], interpreted: b[1] }];
const D = [
  { id: 'D01', input: 'I left Miami at 8 AM and arrived in Orlando at 9 AM', o: ['Miami', 'FL'], d: ['Orlando', 'FL'], s: '2026-09-21T12:00:00.000Z', e: '2026-09-21T13:00:00.000Z' },
  { id: 'D02', input: 'Left Dallas at 8 AM and got to Houston at 8:45 AM', o: ['Dallas', 'TX'], d: ['Houston', 'TX'], s: '2026-09-21T12:00:00.000Z', e: '2026-09-21T12:45:00.000Z' },
  { id: 'D03', input: 'Left Atlanta at 8 AM and arrived in Nashville at 9 AM', o: ['Atlanta', 'GA'], d: ['Nashville', 'TN'], s: '2026-09-21T12:00:00.000Z', e: '2026-09-21T13:00:00.000Z' },
  { id: 'D04', input: 'Left Chicago at 8 AM and was in Indianapolis by 8:45 AM', o: ['Chicago', 'IL'], d: ['Indianapolis', 'IN'], s: '2026-09-21T12:00:00.000Z', e: '2026-09-21T12:45:00.000Z' },
  { id: 'D05', input: 'Left Los Angeles at 8 AM and got to Las Vegas by 9:30 AM', o: ['Los Angeles', 'CA'], d: ['Las Vegas', 'NV'], s: '2026-09-21T12:00:00.000Z', e: '2026-09-21T13:30:00.000Z' },
];

describe('impossible travel (D01-D05): a stated destination makes the route check run and WARN', () => {
  it.each(D)('$id: $input', async (c) => {
    const ev = drive(c.o[0], c.o[1], c.s, c.e, { destination_city: c.d[0], destination_state: c.d[1] });
    const { enriched, routeWarning, calls } = await pipeline(c.input, [ev], LOCCONF([c.o[0], `${c.o[0]}, ${c.o[1]}`], [c.d[0], `${c.d[0]}, ${c.d[1]}`]));

    // route lookup was performed for exactly origin -> destination
    expect(calls).toEqual([[`${c.o[0]}, ${c.o[1]}`, `${c.d[0]}, ${c.d[1]}`]]);
    // origin preserved, destination preserved
    expect(enriched.events[0].city).toBe(c.o[0]);
    expect(enriched.events[0].destination_city).toBe(c.d[0]);
    // the driver's stated departure/arrival are NOT changed to make the trip legal
    expect(enriched.events[0].start_timestamp).toBe(c.s);
    expect(enriched.events[0].end_timestamp).toBe(c.e);
    // impossible-travel warning surfaces: review severity, needs the driver's acknowledgment
    expect(routeWarning).not.toBeNull();
    expect(routeWarning.type).toBe('route_reasonableness');
    expect(routeWarning.explicitConflictLegs).toHaveLength(1);
    expect(routeWarning.requiresAcknowledgment).toBe(true);
    expect(routeWarning.severity).toBe('review');
    // mileage is the ROUTE figure (never an elapsed x speed guess)
    expect(enriched.events[0].mileage_source).toBe('route');
  });

  it('D01 WITHOUT a destination (the shape the live model returned) reproduces the silent miss the fix targets', async () => {
    const ev = drive('Miami', 'FL', D[0].s, D[0].e); // no destination_city
    const { enriched, routeWarning, calls } = await pipeline(D[0].input, [ev]);
    expect(calls).toEqual([]);             // no route lookup
    expect(routeWarning).toBeNull();       // no warning
    expect(enriched.events[0].mileage_source).toBe('unknown');
  });
});

describe('plausible trips and stated mileage with a stated destination (E01-E03, F03-F04)', () => {
  it.each([
    ['E01', 'Left Miami at 8 AM and arrived in Orlando at 1 PM', ['Miami', 'FL'], ['Orlando', 'FL'], '2026-09-21T12:00:00.000Z', '2026-09-21T17:00:00.000Z'],
    ['E02', 'Left Dallas at 6 AM and got to Houston at 11 AM', ['Dallas', 'TX'], ['Houston', 'TX'], '2026-09-21T10:00:00.000Z', '2026-09-21T15:00:00.000Z'],
    ['E03', 'Left Phoenix at 9 AM and got to Tucson at 11:30 AM', ['Phoenix', 'AZ'], ['Tucson', 'AZ'], '2026-09-21T13:00:00.000Z', '2026-09-21T15:30:00.000Z'],
  ])('%s is checked and NOT falsely flagged', async (_id, input, o, d, s, e) => {
    const { enriched, routeWarning, calls } = await pipeline(input, [drive(o[0], o[1], s, e, { destination_city: d[0], destination_state: d[1] })]);
    expect(calls).toHaveLength(1);
    expect(routeWarning?.explicitConflictLegs || []).toHaveLength(0);
    expect(routeWarning?.blockingConflicts || []).toHaveLength(0);
    expect(enriched.events[0].mileage_source).toBe('route');
  });

  it.each([
    ['F03', 150, true], ['F04', 500, true], ['F02', 200, false], ['F01', 230, false],
  ])('%s stated %i mi vs the ~235 mi route: mismatch flagged = %s, driver figure kept', async (_id, stated, flagged) => {
    const input = `I drove ${stated} miles from Miami to Orlando, left at 8 AM and got there at 1 PM`;
    const ev = drive('Miami', 'FL', '2026-09-21T12:00:00.000Z', '2026-09-21T17:00:00.000Z', { destination_city: 'Orlando', destination_state: 'FL' });
    const { enriched } = await pipeline(input, [ev]);
    expect(enriched.events[0].mileage).toBe(stated);              // never overwritten by the map
    expect(enriched.events[0].mileage_source).toBe('driver_stated');
    expect(enriched.events[0].route_miles).toBe(235);
    expect(enriched.legs).toHaveLength(1);
    const { statedMileageWarnings } = await import('./statedMileage');
    expect(statedMileageWarnings(enriched.legs, input).length > 0).toBe(flagged);
  });
});

// ---- 2. false "DESCRIBED DRIVING MISSING" (C10 / C11) ----
describe('"I drove from Miami to Orlando" (C11): the Driving event that states its destination covers the movement', () => {
  const input = 'I drove from Miami to Orlando';
  const ev = { ...drive('Miami', 'FL', '2026-09-21T12:00:00.000Z', '2026-09-21T16:00:00.000Z', { destination_city: 'Orlando', destination_state: 'FL' }),
    field_provenance: { start_time: 'inferred', end_time: 'inferred', status: 'explicit', city: 'explicit', state: 'explicit' }, ambiguous_fields: ['start_time', 'end_time'] };

  it('the live shape (no destination) was falsely blocked — the bug', () => {
    const noDest = { ...ev }; delete noDest.destination_city; delete noDest.destination_state;
    const moves = extractDescribedMovements(input, {});
    expect(moves.some((m) => m.to.city === 'Orlando')).toBe(true);
    expect(movementCovered([noDest], moves.find((m) => m.to.city === 'Orlando'))).toBe(false);
  });

  it('with destination_city the movement is covered and no described_movement_missing block is raised', async () => {
    const moves = extractDescribedMovements(input, {});
    expect(movementCovered([ev], moves.find((m) => m.to.city === 'Orlando'))).toBe(true);
    const { warnings } = await pipeline(input, [ev], LOCCONF(['Miami', 'Miami, FL'], ['Orlando', 'Orlando, FL']));
    expect(warnings.map((w) => w.type)).not.toContain('described_movement_missing');
  });

  it('a destination on the Driving event does not cover a DIFFERENT described city', () => {
    expect(movementCovered([ev], { from: null, to: { city: 'Jacksonville', state: '' } })).toBe(false);
  });
});

describe('getDrivingLegs destination precedence', () => {
  const t0 = '2026-09-21T12:00:00.000Z', t1 = '2026-09-21T14:00:00.000Z';
  it('a FOLLOWING event that names the arrival wins over destination_city (existing behavior unchanged)', () => {
    const legs = getDrivingLegs([
      drive('Dallas', 'TX', t0, t1, { destination_city: 'Austin', destination_state: 'TX' }),
      { duty_status: 'ON_DUTY', start_timestamp: t1, end_timestamp: '2026-09-21T14:15:00.000Z', city: 'Waco', state: 'TX' },
    ]);
    expect(legs[0].destination).toEqual({ city: 'Waco', state: 'TX' });
    expect(legs[0].destinationKnown).toBe(true);
  });
  it('an ongoing drive with no destination stays destinationless (never manufactured)', () => {
    const legs = getDrivingLegs([drive('Miami', 'FL', t0, null)]);
    expect(legs[0].destinationKnown).toBe(false);
  });
  it('a placeholder destination is ignored', () => {
    const legs = getDrivingLegs([drive('Miami', 'FL', t0, t1, { destination_city: 'Unknown', destination_state: 'Unknown' })]);
    expect(legs[0].destinationKnown).toBe(false);
  });
});

// ---- 3. "Unknown" placeholder locations (A08, C01, C08, C12, K02) ----
describe('placeholder locations are never a place', () => {
  it.each(['Unknown', 'unknown', ' N/A ', 'none', 'null', 'TBD', '-', '—', 'Unknown, Unknown', 'unspecified'])('"%s" is a placeholder', (v) => {
    expect(isPlaceholderLocation(v)).toBe(true);
    expect(cleanLocationText(v)).toBe('');
  });
  it.each(['Miami', 'FL', 'Unknownville', 'Nashville', 'Santa Fe'])('"%s" is a real place and is kept', (v) => {
    expect(isPlaceholderLocation(v)).toBe(false);
    expect(cleanLocationText(v)).toBe(v);
  });

  it('A08 "I loaded here at 8": the live event with city/state "Unknown" becomes an empty location', async () => {
    const ev = { duty_status: 'ON_DUTY', start_timestamp: '2026-09-21T12:00:00.000Z', end_timestamp: null, city: 'Unknown', state: 'Unknown',
      field_provenance: { start_time: 'explicit', end_time: 'inferred', status: 'inferred', city: 'inferred', state: 'inferred' }, ambiguous_fields: ['city', 'state'], adjustments: [], source: 'typed', edit_target_index: null };
    const { normalized } = validateInterpretResult({ intent: 'add_events', requires_clarification: true, proposed_events: [ev], location_confirmations: [] });
    expect(normalized.proposed_events[0].city).toBe('');
    expect(normalized.proposed_events[0].state).toBe('');
    expect(normalized.requires_clarification).toBe(true);
  });

  it('C12 (four Unknown events) all normalize to empty', () => {
    const mk = (s, st) => ({ duty_status: s, start_timestamp: st, end_timestamp: null, city: 'Unknown', state: 'Unknown', field_provenance: {}, ambiguous_fields: [], adjustments: [] });
    const { normalized } = validateInterpretResult({ intent: 'add_events', proposed_events: [mk('ON_DUTY', '2026-09-21T12:00:00.000Z'), mk('DRIVING', '2026-09-21T13:00:00.000Z'), mk('ON_DUTY', '2026-09-21T17:00:00.000Z'), mk('SLEEPER_BERTH', '2026-09-21T18:00:00.000Z')] });
    expect(normalized.proposed_events.every((e) => e.city === '' && e.state === '')).toBe(true);
  });

  it('an "Unknown" event is not used as a route endpoint', () => {
    const legs = getDrivingLegs([
      { duty_status: 'ON_DUTY', start_timestamp: '2026-09-21T10:00:00.000Z', end_timestamp: '2026-09-21T11:00:00.000Z', city: 'Unknown', state: 'Unknown' },
      drive('Miami', 'FL', '2026-09-21T11:00:00.000Z', '2026-09-21T15:00:00.000Z'),
    ]);
    expect(legs[0].origin).toEqual({ city: 'Miami', state: 'FL' });
  });
});

// ---- 4. overnight range with the end dated before the start (G01) ----
describe('"from 10 PM to 4 AM" (G01): the end rolls to the next day; nothing else is changed', () => {
  const start = '2026-09-22T02:00:00.000Z'; // 10 PM EDT Sep 21
  const badEnd = '2026-09-21T08:00:00.000Z'; // 4 AM EDT Sep 21  (BEFORE the start: the live model's output)
  it('rollOverEndAcrossMidnight', () => {
    expect(rollOverEndAcrossMidnight(start, badEnd)).toBe('2026-09-22T08:00:00.000Z'); // 4 AM EDT Sep 22
    expect(rollOverEndAcrossMidnight('2026-09-21T12:00:00.000Z', '2026-09-21T13:00:00.000Z')).toBe('2026-09-21T13:00:00.000Z'); // already fine
    expect(rollOverEndAcrossMidnight('2026-09-21T12:00:00.000Z', null)).toBeNull();
    // an end days before the start is a genuinely wrong date, not an overnight range -> untouched
    expect(rollOverEndAcrossMidnight('2026-09-25T12:00:00.000Z', '2026-09-21T13:00:00.000Z')).toBe('2026-09-21T13:00:00.000Z');
    // equal start/end is never turned into a 24 h event
    expect(rollOverEndAcrossMidnight('2026-09-21T12:00:00.000Z', '2026-09-21T12:00:00.000Z')).toBe('2026-09-21T12:00:00.000Z');
    // 1 h before the start rolls to 23 h later (still a positive duration under 24 h)
    expect(rollOverEndAcrossMidnight('2026-09-21T12:00:00.000Z', '2026-09-21T11:00:00.000Z')).toBe('2026-09-22T11:00:00.000Z');
  });

  it('the live G01 proposal no longer trips negative_duration, keeps 10 PM start and 4 AM end', async () => {
    const ev = drive('Miami', 'FL', start, badEnd, { destination_city: 'Orlando', destination_state: 'FL', field_provenance: { ...explicitFp, state: 'explicit' } });
    const { normalized, warnings } = await pipeline('I drove from Miami to Orlando from 10 PM to 4 AM', [ev], LOCCONF(['Miami', 'Miami, FL'], ['Orlando', 'Orlando, FL']));
    expect(normalized.proposed_events[0].start_timestamp).toBe(start);
    expect(normalized.proposed_events[0].end_timestamp).toBe('2026-09-22T08:00:00.000Z');
    expect(warnings.map((w) => w.type)).not.toContain('negative_duration');
  });
});

// ---- 5. the ambiguity safety net that covered the LLM's L04 miss ----
describe('L04 "loaded in Portland at 7": even when the model guesses a state, the app blocks', () => {
  it('Portland, OR (state only inferred) -> blocking ambiguous_city', async () => {
    const ev = { duty_status: 'ON_DUTY', start_timestamp: '2026-09-21T11:00:00.000Z', end_timestamp: null, city: 'Portland', state: 'OR',
      field_provenance: { start_time: 'explicit', end_time: 'inferred', status: 'inferred', city: 'explicit', state: 'inferred' }, ambiguous_fields: ['state'], adjustments: [], source: 'typed', edit_target_index: null };
    const { warnings } = await pipeline('loaded in Portland at 7', [ev], [{ original: 'Portland', interpreted: 'Portland, OR' }]);
    const amb = warnings.find((w) => w.type === 'ambiguous_city');
    expect(amb).toBeTruthy();
    expect(amb.severity).toBe('blocking');
  });
});

// ---- 6. the scorer itself (so a future live run is judged correctly) ----
describe('evaluator fixes from the live run', () => {
  const spec = (id) => LIVE_PROMPTS.find((p) => p.id === id);
  const base = (over) => ({ intent: 'add_events', requires_clarification: false, clarifications: [], proposed_events: [], ...over });

  it('a destination stated on the Driving event counts as the city being preserved', () => {
    const res = base({ proposed_events: [drive('Miami', 'FL', '2026-09-21T12:00:00.000Z', '2026-09-21T13:00:00.000Z', { destination_city: 'Orlando', destination_state: 'FL' })] });
    const out = evaluateLive({ id: 'X', includeCities: ['Miami', 'Orlando'] }, res, TZ);
    expect(out.fails).toEqual([]);
  });
  it('a destination that is only in location_confirmations is still reported as dropped', () => {
    const res = base({ proposed_events: [drive('Miami', 'FL', '2026-09-21T12:00:00.000Z', '2026-09-21T13:00:00.000Z')], location_confirmations: [{ original: 'Orlando', interpreted: 'Orlando, FL' }] });
    const out = evaluateLive({ id: 'X', includeCities: ['Miami', 'Orlando'] }, res, TZ);
    expect(out.fails.map((f) => f.msg).join(' ')).toMatch(/Orlando/);
  });
  it('an event that ends before it starts is a TIME failure even when the clock times match (G01)', () => {
    const res = base({ proposed_events: [drive('Miami', 'FL', '2026-09-22T02:00:00.000Z', '2026-09-21T08:00:00.000Z')] });
    const out = evaluateLive(spec('G01'), res, TZ);
    expect(out.fails.some((f) => f.cat === 'time' && /ends .* at or before it starts/.test(f.msg))).toBe(true);
  });
  it('a placeholder location is a LOCATION failure', () => {
    const res = base({ proposed_events: [{ duty_status: 'ON_DUTY', start_timestamp: '2026-09-21T12:00:00.000Z', end_timestamp: null, city: 'Unknown', state: 'Unknown', field_provenance: {} }] });
    const out = evaluateLive({ id: 'X' }, res, TZ);
    expect(out.fails.some((f) => f.cat === 'location' && /placeholder/.test(f.msg))).toBe(true);
  });
  it('C14 expects the 5 events the driver actually described (pretrip, drive, fuel, drive, shut down)', () => {
    expect(spec('C14').count.min).toBe(5);
  });
});
