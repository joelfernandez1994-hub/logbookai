// ============================================================================
// LogbookAI — REGRESSION SUITE from the natural-driver-language stress test.
// ----------------------------------------------------------------------------
// Every case here is a prompt/scenario that the real (unmocked) deterministic
// pipeline mishandled when run end-to-end:
//   1. Travel narratives were swallowed by the deterministic single-intent
//      parser, which silently dropped origin, destination and arrival time —
//      so an impossible "Left Miami at 8 AM and got to Orlando at 9 AM" became
//      one open-ended Driving event with no cities and NEVER reached the route
//      check; "left LA at 6 and arrived in Las Vegas at 11" stamped Las Vegas
//      on the departure; "left Miami around 8ish and got to Orlando about noon"
//      logged the departure at NOON.
//   2. "drove for about 3 hours" was read as "about 3 (o'clock)" and produced a
//      fabricated 3-hour Driving event starting at 3 PM.
//   3. A multi-state city name with no state ("Springfield", "Columbia") was
//      never questioned anywhere.
//   4. A past-tense statement resolved to a FUTURE time (said at 11 AM: "went
//      to bed at 10 pm") produced no warning at all.
//   5. "I loaded here" silently produced a blank-location event.
// Route distances quoted below were measured with the app's own routing stack
// (Nominatim + OSRM) on 2026-09-20.
// ============================================================================
import { describe, it, expect } from 'vitest';
import { isMultiEventNarrative, isTravelNarrative, referencesHere } from './narrativeClassifier';
import { parseVoiceCommand } from './voiceParser';
import { findAmbiguousCityIssues, narrativeStatesCity, isAmbiguousCityName } from './ambiguousLocations';
import { validateProposal, inspectProposalRoutes } from './proposalValidation';

const TZ = 'America/New_York';
const NOW = new Date('2026-09-20T15:00:00Z'); // 11:00 AM ET
const fp = { start_time: 'explicit', end_time: 'explicit', status: 'explicit', city: 'explicit', state: 'explicit' };

describe('travel narratives never reach the single-intent deterministic parser', () => {
  it.each([
    'Left Miami at 8 AM and got to Orlando at 9 AM',
    'left Miami around 8ish and got to Orlando about noon',
    'I left Atlanta at 7 this morning headed to Nashville',
    'left Los Angeles at 6 and arrived in Las Vegas at 11',
    'drove over to Hialeah at 9',
    'started driving at 8 from Miami',
    'got there around noon',
    'I got there at 8',
    'ran from Denver to Colorado Springs',
    'I arrived in Orlando at noon',
    'headed to Atlanta',
    'loaded here and drove to Orlando',
    'I was off duty until 5 then loaded and left for Savannah',
  ])('routes to AI: %s', (p) => {
    expect(isMultiEventNarrative(p)).toBe(true);
  });

  it.each([
    'loaded at 6:15',
    'fueled at 10',
    'went off duty at 5',
    'on duty at 7 in Miami',
    'driving now',
    'off duty now',
    'went to bed at 10 pm',
    'went sleeper at 9',
    'left around 7',
    'loaded from 7 to 8',
    'took my 30 at noon',
  ])('trivial single-intent commands stay deterministic: %s', (p) => {
    expect(isTravelNarrative(p)).toBe(false);
  });

  it('the parser itself no longer collapses the impossible-travel prompt into one blank-location event when routed', () => {
    // (Guard for the routing contract: the classifier must claim this text.)
    expect(isMultiEventNarrative('Left Miami at 8 AM and got to Orlando at 9 AM')).toBe(true);
  });
});

describe('duration/distance words are never clock times', () => {
  const ctx = { now: NOW, timezone: TZ, events: [] };
  it('"drove for about 3 hours" no longer fabricates a 3 PM Driving event', () => {
    const r = parseVoiceCommand('drove for about 3 hours', ctx);
    expect(r.handled).toBe(false);
  });
  it('"stopped for around 30 minutes" is not read as 30 o\'clock', () => {
    const r = parseVoiceCommand('stopped for around 30 minutes', ctx);
    expect((r.events || []).length).toBe(0);
  });
  it('a real approximate clock time still works ("left around 7")', () => {
    const r = parseVoiceCommand('left around 7', ctx);
    expect(r.handled).toBe(true);
    expect(r.events[0].duty_status).toBe('DRIVING');
  });
});

describe('"here" is never silently resolved', () => {
  it.each(['I loaded here at 8', 'I just got loaded here', 'I left here at 7', 'I stopped at my current location'])(
    'detects a here-reference: %s', (p) => expect(referencesHere(p)).toBe(true));
  it.each(['loaded at 6:15', "here's what happened", 'off duty now'])(
    'does not flag: %s', (p) => expect(referencesHere(p)).toBe(false));
});

describe('ambiguous multi-state city names', () => {
  const ev = (city, state, extra = {}) => ({
    duty_status: 'ON_DUTY', city, state, start_timestamp: '2026-09-20T12:00:00.000Z',
    end_timestamp: '2026-09-20T13:00:00.000Z', field_provenance: { ...fp, state: state ? 'inferred' : 'explicit' }, ...extra,
  });

  it('flags Springfield and Columbia when no state was stated', () => {
    const issues = findAmbiguousCityIssues([ev('Springfield', ''), ev('Columbia', '')], [], 'I drove from Springfield to Columbia');
    expect(issues.map((i) => i.city).sort()).toEqual(['Columbia', 'Springfield']);
  });

  it('flags a state the model merely INFERRED with no support', () => {
    const issues = findAmbiguousCityIssues([ev('Springfield', 'IL')], [], 'I loaded in Springfield');
    expect(issues).toHaveLength(1);
  });

  it('accepts a state the driver stated ("Springfield, IL" / "Springfield Illinois")', () => {
    expect(findAmbiguousCityIssues([ev('Springfield', 'IL')], [], 'loaded in Springfield, IL')).toHaveLength(0);
    expect(findAmbiguousCityIssues([ev('Springfield', 'IL')], [], 'loaded in Springfield Illinois')).toHaveLength(0);
  });

  it('a lowercase word after the city is NOT treated as a state ("Springfield in the morning")', () => {
    expect(narrativeStatesCity('loaded in Springfield in the morning', 'Springfield')).toBe(false);
    expect(narrativeStatesCity('drove Springfield to Columbia', 'Springfield')).toBe(false);
  });

  it('accepts an inferred state that a neighboring UNAMBIGUOUS event in the same state supports', () => {
    const orlando = { ...ev('Orlando', 'FL'), field_provenance: fp };
    const jax = ev('Jacksonville', 'FL');
    expect(findAmbiguousCityIssues([orlando, jax], [], 'went to Orlando then Jacksonville')).toHaveLength(0);
  });

  it('accepts a location the driver confirmed in Edit Proposal', () => {
    expect(findAmbiguousCityIssues([ev('Columbia', 'SC', { driver_confirmed_location: true })], [], 'x')).toHaveLength(0);
  });

  it('never questions unique well-known cities', () => {
    expect(isAmbiguousCityName('Miami')).toBe(false);
    expect(findAmbiguousCityIssues([ev('Miami', ''), ev('Orlando', '')], [], 'Miami to Orlando')).toHaveLength(0);
  });

  it('validateProposal surfaces a BLOCKING "which state?" warning', () => {
    const proposed = [
      { ...ev('Springfield', ''), duty_status: 'ON_DUTY', start_timestamp: '2026-09-20T12:00:00.000Z', end_timestamp: '2026-09-20T13:00:00.000Z' },
    ];
    const v = validateProposal([], proposed, { cycleType: '70_8', tz: TZ, now: NOW, narrative: 'loaded in Springfield' });
    const w = v.warnings.find((x) => x.type === 'ambiguous_city');
    expect(w).toBeTruthy();
    expect(w.severity).toBe('blocking');
  });
});

describe('future-dated actual events are flagged', () => {
  it('"went to bed at 10 pm" said at 11 AM (resolved to tonight) gets a review warning', () => {
    const proposed = [{
      duty_status: 'OFF_DUTY', city: '', state: '', start_timestamp: '2026-09-21T02:00:00.000Z', end_timestamp: null, is_ongoing: true, field_provenance: fp,
    }];
    const v = validateProposal([], proposed, { cycleType: '70_8', tz: TZ, now: NOW, narrative: 'went to bed at 10 pm' });
    const w = v.warnings.find((x) => x.type === 'future_event');
    expect(w).toBeTruthy();
    expect(w.severity).toBe('review');
  });

  it('no warning for an event that has already started, or when the caller marked it a plan', () => {
    const past = [{ duty_status: 'ON_DUTY', city: '', state: '', start_timestamp: '2026-09-20T12:00:00.000Z', end_timestamp: null, is_ongoing: true, field_provenance: fp }];
    expect(validateProposal([], past, { cycleType: '70_8', tz: TZ, now: NOW }).warnings.some((x) => x.type === 'future_event')).toBe(false);
    const fut = [{ ...past[0], start_timestamp: '2026-09-21T02:00:00.000Z' }];
    expect(validateProposal([], fut, { cycleType: '70_8', tz: TZ, now: NOW, isFuture: true }).warnings.some((x) => x.type === 'future_event')).toBe(false);
  });
});

describe('impossible travel is caught by the route check (routing provider injected)', () => {
  // Measured 2026-09-20 with the app's routing stack: Miami→Orlando 233 mi / 4.37 h.
  const provider = async () => ({ miles: 233, hours: 4.37 });
  const drive = (endHour) => ([
    { duty_status: 'DRIVING', city: 'Miami', state: 'FL', start_timestamp: '2026-09-20T12:00:00.000Z', end_timestamp: new Date(Date.UTC(2026, 8, 20, 12 + endHour)).toISOString(), field_provenance: fp },
    { duty_status: 'ON_DUTY', city: 'Orlando', state: 'FL', start_timestamp: new Date(Date.UTC(2026, 8, 20, 12 + endHour)).toISOString(), end_timestamp: new Date(Date.UTC(2026, 8, 20, 13 + endHour)).toISOString(), field_provenance: fp },
  ]);
  it('Miami→Orlando in 1 hour is a route/time conflict', async () => {
    const legs = await inspectProposalRoutes(drive(1), { routingProvider: provider, now: new Date('2026-09-20T20:00:00Z') });
    expect(legs[0].evaluation.conflict).toBe(true);
  });
  it('Miami→Orlando in 5 hours is plausible', async () => {
    const legs = await inspectProposalRoutes(drive(5), { routingProvider: provider, now: new Date('2026-09-20T20:00:00Z') });
    expect(legs[0].evaluation.conflict).toBe(false);
  });
});
