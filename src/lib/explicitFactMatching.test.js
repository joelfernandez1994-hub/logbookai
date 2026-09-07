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
function extractExplicitTimes(input) {
  const text = String(input || '');
  return [...text.matchAll(/\b(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?)?\b/gi)].map((m) => {
    const candidates = clockCandidates(m[1], m[2], m[3]);
    return { raw: m[0], normalized: candidates[0], candidates, approximate: isApproximateMention(text, m.index) };
  });
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
