// ============================================================================
// LogbookAI — REGRESSION: explicit-time-fact canonical-boundary matching.
// ----------------------------------------------------------------------------
// Live bug (AIProposal id 6a9e227b418ac923c41c60fc, "Gary, IN -> Lincoln, NE"
// full-day narrative): every one of the driver's stated times used "around"/
// "about" hedging with no explicit AM/PM ("around 2:45", "Around 4:15", ...).
// Two compounding defects in the OLD guard:
//   1. extractExplicitFacts() defaulted an unmarked hour to AM, so "2:45"
//      (meant 2:45 PM, obvious from the day's chronology) normalized to
//      "02:45" and could never match the real "14:45" boundary the AI
//      correctly produced.
//   2. detectExplicitFactAlterations() required the exact SAME event field
//      to carry field_provenance:'explicit' for that specific value, instead
//      of accepting that the value exists ANYWHERE in the proposal's real
//      timeline — which is what actually matters, and is what makes a
//      SHARED boundary (one clock value closing event A and opening event B)
//      correctly count as preserved regardless of which side got the label.
// Together these produced 5 false "Explicit clock time was dropped, changed
// silently, or tagged inferred" blocks on a proposal that was actually
// correct.
//
// Fix: extractExplicitFacts (base44/functions/manualLogAssistant/entry.ts,
// mirrored here — Deno-only, not vitest-importable, keep both in sync) now
// returns BOTH 12-hour readings for an unmarked hour (`candidates`) and
// tags a hedged mention `approximate: true` instead of dropping it.
// detectExplicitFactAlterations (aiLayer.js) now matches at the CANONICAL
// BOUNDARY level: a fact is preserved if any of its candidate values appears
// as ANY event's start or end anywhere in the proposal, regardless of which
// field carries it. An approximate fact within 30 min of some boundary is
// preserved; outside that tolerance it becomes a review-level note, never a
// block (the driver themselves signaled an estimate). An EXACT (unhedged)
// fact that never appears anywhere still blocks — never weakened.
// ============================================================================
import { describe, it, expect } from 'vitest';
import { detectExplicitFactAlterations } from './aiLayer';

// --- Mirror of manualLogAssistant/entry.ts's extraction (Deno-only, not
// importable here) --- keep in sync if either changes.
function clockCandidates(hour, minute, meridiem) {
  const h12 = Number(hour) % 12;
  const mm = String(Number(minute)).padStart(2, '0');
  const am = `${String(h12).padStart(2, '0')}:${mm}`;
  const pm = `${String(h12 + 12).padStart(2, '0')}:${mm}`;
  if (meridiem) {
    const isPm = /^p/i.test(meridiem.replace(/\./g, ''));
    return [isPm ? pm : am];
  }
  return am === pm ? [am] : [am, pm];
}
const APPROX_QUALIFIER_RE = /\b(?:about|around|near|roughly|approximately|circa|ish|cerca de(?: las?)?|alrededor(?: de(?: las?)?)?|a eso de(?: las?)?|aproximadamente|casi)\s*$/i;
function isApproximateMention(text, matchIndex) {
  const lookback = text.slice(Math.max(0, matchIndex - 20), matchIndex);
  return APPROX_QUALIFIER_RE.test(lookback);
}
function makeTimeFact(raw, candidates, text, index) {
  return { raw, normalized: candidates[0], candidates, approximate: isApproximateMention(text, index) };
}
function extractExplicitTimes(input) {
  const text = String(input || '');
  const times = [];
  for (const m of text.matchAll(/\b(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?)?\b/gi)) {
    times.push(makeTimeFact(m[0], clockCandidates(m[1], m[2], m[3]), text, m.index));
  }
  for (const m of text.matchAll(/(?<![:\d])(\d{1,2})\s*(a\.?m\.?|p\.?m\.?)\b/gi)) {
    times.push(makeTimeFact(m[0], clockCandidates(m[1], '0', m[2]), text, m.index));
  }
  for (const m of text.matchAll(/\bmidnight\b/gi)) {
    times.push(makeTimeFact(m[0], ['00:00'], text, m.index));
  }
  for (const m of text.matchAll(/\bnoon\b/gi)) {
    times.push(makeTimeFact(m[0], ['12:00'], text, m.index));
  }
  return times;
}

function ev(start, end, extra = {}) {
  return { duty_status: 'ON_DUTY', start_time_local: start, end_time_local: end, field_provenance: { status: 'explicit' }, ...extra };
}

describe('extractExplicitTimes (mirrors manualLogAssistant/entry.ts) — candidates + approximate tagging', () => {
  it('an unhedged, unmarked hour ("2:45") returns BOTH AM/PM candidates — never assumes AM', () => {
    const [fact] = extractExplicitTimes('arrived at 2:45');
    expect(fact.candidates).toEqual(['02:45', '14:45']);
    expect(fact.approximate).toBe(false);
  });

  it('an explicit meridiem narrows to exactly one candidate', () => {
    expect(extractExplicitTimes('arrived at 2:45 PM')[0].candidates).toEqual(['14:45']);
    expect(extractExplicitTimes('arrived at 2:45 AM')[0].candidates).toEqual(['02:45']);
  });

  it('a hedged mention is tagged approximate but STILL RETAINED (never dropped from consideration)', () => {
    const facts = extractExplicitTimes('around 2:45 I arrived');
    expect(facts).toHaveLength(1);
    expect(facts[0].approximate).toBe(true);
  });

  it('12:00 (noon-ish) yields midnight/noon candidates when unmarked', () => {
    expect(extractExplicitTimes('at 12:00')[0].candidates).toEqual(['00:00', '12:00']);
  });
});

describe('REGRESSION — canonical-boundary matching (live Gary,IN -> Lincoln,NE narrative)', () => {
  const LIVE_NARRATIVE = `I was off duty in Gary until about 5:45 this morning. I did my pretrip and rolled out around 6.

I stopped in Joliet around 8:20 for fuel, was on duty there about 20 minutes, then got back on the road.

I made it to Davenport around 11:30, took my 30 off duty, and started rolling again at noon.

Got to Des Moines around 2:45, went on duty to unload and do paperwork for about 30 minutes, then went off duty for about an hour.

Around 4:15 I went back on duty for a quick equipment check, about 15 minutes, then started driving again around 4:30.

Stopped in Omaha around 7 for fuel, was on duty there about 20 minutes, then got back on the road.

I got to Lincoln around 8:15, did a 15-minute post-trip, then went off duty for the night around 8:30.`;

  // Verbatim (clock-relevant fields) from the real proposed_events of
  // AIProposal 6a9e227b418ac923c41c60fc.
  const REAL_PROPOSED = [
    ev('2026-09-06T00:00:00', '2026-09-06T05:45:00'),
    ev('2026-09-06T05:45:00', '2026-09-06T06:00:00'),
    ev('2026-09-06T06:00:00', '2026-09-06T08:20:00'),
    ev('2026-09-06T08:20:00', '2026-09-06T08:40:00'),
    ev('2026-09-06T08:40:00', '2026-09-06T11:30:00'),
    ev('2026-09-06T11:30:00', '2026-09-06T12:00:00'),
    ev('2026-09-06T12:00:00', '2026-09-06T14:45:00'),
    ev('2026-09-06T14:45:00', '2026-09-06T15:15:00'),
    ev('2026-09-06T15:15:00', '2026-09-06T16:15:00'),
    ev('2026-09-06T16:15:00', '2026-09-06T16:30:00'),
    ev('2026-09-06T16:30:00', '2026-09-06T19:00:00'),
    ev('2026-09-06T19:00:00', '2026-09-06T19:20:00'),
    ev('2026-09-06T19:20:00', '2026-09-06T20:15:00'),
    ev('2026-09-06T20:15:00', '2026-09-06T20:30:00'),
    ev('2026-09-06T20:30:00', null),
  ];

  it('zero explicit time facts are dropped/blocked — all 8 stated times (5 of which are the exact PM values that used to false-positive) are preserved', () => {
    const times = extractExplicitTimes(LIVE_NARRATIVE);
    const guard = detectExplicitFactAlterations(REAL_PROPOSED, { times, locations: [], statuses: [] });
    expect(guard.droppedExplicitEvents.filter((i) => i.type === 'time')).toEqual([]);
    expect(guard.approximateMismatches).toEqual([]);
    expect(guard.blocking).toBe(false);
  });
});

describe('Regression corpus — the exact scenarios requested', () => {
  it('1. explicit start time preserved', () => {
    const events = [ev('2026-09-06T08:20:00', '2026-09-06T08:40:00')];
    const times = extractExplicitTimes('at 8:20 AM I started fueling');
    expect(detectExplicitFactAlterations(events, { times }).blocking).toBe(false);
  });

  it('2. explicit end time preserved', () => {
    const events = [ev('2026-09-06T08:00:00', '2026-09-06T08:20:00')];
    const times = extractExplicitTimes('stopped fueling at 8:20 AM');
    expect(detectExplicitFactAlterations(events, { times }).blocking).toBe(false);
  });

  it('3. explicit shared boundary used as end + next start — ONE fact, not two, and preserved regardless of which side is labeled explicit', () => {
    const events = [
      ev('2026-09-06T11:30:00', '2026-09-06T12:00:00', { field_provenance: { end_time: 'explicit' } }),
      ev('2026-09-06T12:00:00', '2026-09-06T14:45:00', { duty_status: 'DRIVING', field_provenance: { start_time: 'inferred' } }), // the OTHER side is NOT marked explicit
    ];
    const times = extractExplicitTimes('took my 30 then started rolling again at noon');
    const guard = detectExplicitFactAlterations(events, { times });
    expect(guard.blocking).toBe(false); // preserved via the boundary value alone, not requiring both sides tagged
  });

  it('4a. approximate explicit time within tolerance is preserved, not even a review note', () => {
    const events = [ev('2026-09-06T08:15:00', '2026-09-06T08:35:00')]; // AI rounded 8:20 -> 8:15, 5 min off
    const times = extractExplicitTimes('stopped around 8:20 for fuel');
    const guard = detectExplicitFactAlterations(events, { times });
    expect(guard.blocking).toBe(false);
    expect(guard.approximateMismatches).toEqual([]);
  });

  it('4b. approximate explicit time far outside tolerance is a REVIEW note, never a hard block', () => {
    const events = [ev('2026-09-06T11:00:00', '2026-09-06T11:20:00')]; // nowhere near 8:20
    const times = extractExplicitTimes('stopped around 8:20 for fuel');
    const guard = detectExplicitFactAlterations(events, { times });
    expect(guard.blocking).toBe(false); // never blocks on an approximate mismatch alone
    expect(guard.approximateMismatches).toHaveLength(1);
  });

  it('5. duration-derived end time never triggers a false drop (the driver never stated that clock value)', () => {
    // "on duty for 20 minutes" from an explicit 8:20 start — the derived
    // 8:40 end was never written as literal text, so it is never extracted
    // as a fact at all; nothing to falsely flag.
    const events = [ev('2026-09-06T08:20:00', '2026-09-06T08:40:00', { field_provenance: { start_time: 'explicit', end_time: 'inferred' } })];
    const times = extractExplicitTimes('stopped at 8:20 for fuel, on duty for 20 minutes');
    expect(times).toHaveLength(1); // only 8:20 was ever stated
    expect(detectExplicitFactAlterations(events, { times }).blocking).toBe(false);
  });

  it('6. repeated mention of the same clock time never double-flags or requires two occurrences', () => {
    const events = [ev('2026-09-06T08:20:00', '2026-09-06T08:40:00')];
    const times = extractExplicitTimes('at 8:20 I stopped. Confirmed, 8:20 AM.');
    expect(times.length).toBeGreaterThanOrEqual(2); // driver mentioned it twice
    const guard = detectExplicitFactAlterations(events, { times });
    expect(guard.blocking).toBe(false);
    expect(guard.droppedExplicitEvents).toEqual([]);
  });

  it('7. one real dropped EXACT explicit time still blocks — the safeguard is never weakened', () => {
    const events = [ev('2026-09-06T09:00:00', '2026-09-06T09:20:00')]; // nowhere near 8:20
    const times = extractExplicitTimes('stopped at exactly 8:20 AM for fuel'); // unhedged -> approximate:false
    const guard = detectExplicitFactAlterations(events, { times });
    expect(guard.blocking).toBe(true);
    expect(guard.droppedExplicitEvents.some((i) => i.type === 'time' && i.value.includes('8:20'))).toBe(true);
  });
});

// ============================================================================
// REGRESSION — Spanish "alrededor (de las)"/"a eso de las" hedge vocabulary.
// ----------------------------------------------------------------------------
// Live bug (AIProposal id 6a9eb6663369dbb69c6560f1, request_text "I made it
// to Valdosta around 1:30, unloaded for 30 minutes, then went off duty." —
// interpretation shown to the Spanish-locale driver: "He interpretado que
// llegaste a Valdosta, GA, alrededor de la 1:30 PM..."): the OLD
// APPROX_QUALIFIER_RE recognized English "around" but had NO Spanish
// "alrededor"/"alrededor de (las)"/"a eso de (las)" entry at all, even though
// that exact phrasing is the app's own natural Spanish rendering of "around"
// (see feasibilityQuestion.js's "Llegada estimada alrededor de las...").  A
// Spanish narrative hedging a time with "alrededor"/"a eso de" was therefore
// treated as an EXACT (non-approximate) fact, so any AI rounding away from
// the literal value could hard-block Apply instead of using the same 30-
// minute tolerance an English "around" mention already received.
// Fix: APPROX_QUALIFIER_RE (manualLogAssistant/entry.ts, mirrored above) and
// voiceParser.js's TIME_PREFIX regex both now accept "alrededor(?: de(?:
// las?)?)?" and "a eso de(?: las?)?" alongside the existing "cerca de(?:
// las?)?".
// ============================================================================
describe('REGRESSION — Spanish "alrededor"/"a eso de" hedge vocabulary (live Valdosta proposal)', () => {
  it('"alrededor de la 1:30 PM" is tagged approximate, not an exact fact', () => {
    const [fact] = extractExplicitTimes('llegaste a Valdosta, GA, alrededor de la 1:30 PM, realizaste 30 minutos de descarga');
    expect(fact.approximate).toBe(true);
  });

  it('"alrededor de las 1:30 PM" (plural "las") is tagged approximate', () => {
    const [fact] = extractExplicitTimes('Llegue a Valdosta, GA alrededor de las 1:30 PM, hice 30 minutos de descarga');
    expect(fact.approximate).toBe(true);
  });

  it('"a eso de la 1:30 PM" (alternate Spanish hedge phrase) is tagged approximate', () => {
    const [fact] = extractExplicitTimes('llegue a Valdosta, GA a eso de la 1:30 PM');
    expect(fact.approximate).toBe(true);
  });

  it('bare "alrededor" with no "de" still counts as a hedge prefix', () => {
    const [fact] = extractExplicitTimes('parked alrededor 1:30 PM');
    expect(fact.approximate).toBe(true);
  });

  it('REAL live proposal: the exact Valdosta request_text + real proposed_events — zero drops, zero review notes', () => {
    // Verbatim from AIProposal 6a9eb6663369dbb69c6560f1.
    const requestText = 'I made it to Valdosta around 1:30, unloaded for 30 minutes, then went off duty.';
    const times = extractExplicitTimes(requestText);
    const events = [
      ev('2026-08-25T13:30:00', '2026-08-25T14:00:00', { duty_status: 'ON_DUTY', field_provenance: { start_time: 'inferred', end_time: 'inferred', status: 'explicit', city: 'inferred', state: 'inferred' } }),
      ev('2026-08-25T14:00:00', null, { duty_status: 'OFF_DUTY', field_provenance: { start_time: 'inferred', end_time: 'inferred', status: 'explicit', city: 'inferred', state: 'inferred' } }),
    ];
    const guard = detectExplicitFactAlterations(events, { times, locations: [], statuses: [] });
    expect(guard.blocking).toBe(false);
    expect(guard.droppedExplicitEvents).toEqual([]);
    expect(guard.approximateMismatches).toEqual([]);
  });
});

// ============================================================================
// REGRESSION — bare-hour meridiem times and 12 AM/PM / noon / midnight.
// ----------------------------------------------------------------------------
// Live bug (driver report "Could not safely build a proposal — Explicit clock
// time was dropped, changed silently, or tagged inferred. (\"6 AM\")"): the
// old single-array .map() read a bare-hour match's meridiem group as MINUTES,
// so "6 AM" produced NaN-minute candidates that could never match the real
// "06:00" boundary. A proposal the AI had built correctly was false-blocked.
// Also: "noon" was never extracted at all.
// ============================================================================
describe('REGRESSION — bare-hour meridiem times map group 2 as MERIDIEM (live "6 AM" bug)', () => {
  it('"6 AM" is a real fact with candidate 06:00 — never NaN', () => {
    const fact = extractExplicitTimes('off duty until 6 AM')[0];
    expect(fact.candidates).toEqual(['06:00']);
    expect(fact.candidates.every((c) => /^\d{2}:\d{2}$/.test(c))).toBe(true);
  });

  it('every hour 1–12 in AM and PM form maps to the correct 24-hour value', () => {
    for (let h = 1; h <= 12; h++) {
      const amExpected = `${String(h % 12).padStart(2, '0')}:00`;
      const pmExpected = `${String(h === 12 ? 12 : h + 12).padStart(2, '0')}:00`;
      expect(extractExplicitTimes(`stopped at ${h} AM`)[0].candidates).toEqual([amExpected]);
      expect(extractExplicitTimes(`stopped at ${h} PM`)[0].candidates).toEqual([pmExpected]);
    }
  });

  it('representative values: 1 AM, 6 PM, 11 AM, 11 PM', () => {
    expect(extractExplicitTimes('at 1 AM')[0].candidates).toEqual(['01:00']);
    expect(extractExplicitTimes('at 6 PM')[0].candidates).toEqual(['18:00']);
    expect(extractExplicitTimes('at 11 AM')[0].candidates).toEqual(['11:00']);
    expect(extractExplicitTimes('at 11 PM')[0].candidates).toEqual(['23:00']);
  });

  it('noon is 12:00 and midnight is 00:00 (12 PM and 12 AM too)', () => {
    expect(extractExplicitTimes('started rolling at noon')[0].candidates).toEqual(['12:00']);
    expect(extractExplicitTimes('went off duty at midnight')[0].candidates).toEqual(['00:00']);
    expect(extractExplicitTimes('lunch at 12 PM')[0].candidates).toEqual(['12:00']);
    expect(extractExplicitTimes('back on duty at 12 AM')[0].candidates).toEqual(['00:00']);
  });

  it('a bare hour WITHOUT a meridiem is still never a time fact', () => {
    expect(extractExplicitTimes('drove 8 hours and 300 miles at night')).toHaveLength(0);
  });

  it('a hedged bare hour is approximate: "around 6 AM"', () => {
    expect(extractExplicitTimes('left around 6 AM')[0].approximate).toBe(true);
  });

  it('LIVE SCREENSHOT SCENARIO: stated "6 AM"/"06:00" boundaries are preserved — no false block', () => {
    const times = extractExplicitTimes('off duty in Miami, FL until 6 AM, 15-minute pre-trip, driving from 6:15 AM to 10:15 AM to Orlando');
    const events = [
      ev('2026-10-20T00:00:00', '2026-10-20T06:00:00', { duty_status: 'OFF_DUTY' }),
      ev('2026-10-20T06:00:00', '2026-10-20T06:15:00', { duty_status: 'ON_DUTY' }),
      ev('2026-10-20T06:15:00', '2026-10-20T10:15:00', { duty_status: 'DRIVING' }),
    ];
    const guard = detectExplicitFactAlterations(events, { times, locations: [], statuses: [] });
    expect(guard.blocking).toBe(false);
    expect(guard.droppedExplicitEvents).toEqual([]);
  });

  it('a genuinely dropped exact bare-hour time still blocks — the safeguard is never weakened', () => {
    const times = extractExplicitTimes('started driving at exactly 6 AM');
    const events = [ev('2026-10-20T07:00:00', '2026-10-20T09:00:00')]; // nowhere near 06:00
    const guard = detectExplicitFactAlterations(events, { times });
    expect(guard.blocking).toBe(true);
    expect(guard.droppedExplicitEvents.some((i) => i.type === 'time' && i.value.includes('6 AM'))).toBe(true);
  });

  it('a stated "noon" fact is preserved when a 12:00 boundary exists, and blocks when dropped', () => {
    const times = extractExplicitTimes('took my 30 at noon then rolled again');
    expect(detectExplicitFactAlterations([ev('2026-10-20T11:30:00', '2026-10-20T12:00:00')], { times }).blocking).toBe(false);
    expect(detectExplicitFactAlterations([ev('2026-10-20T13:00:00', '2026-10-20T13:30:00')], { times }).blocking).toBe(true);
  });
});