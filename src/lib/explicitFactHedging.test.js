// ============================================================================
// LogbookAI — REGRESSION: hedged ("around"/"about") times must never be
// treated as hard explicit facts by the AI proposal safety guard.
// ----------------------------------------------------------------------------
// Bug (verified against a real live AIProposal, id 6a9e1fb4b7e2b3fcaa1b1047):
// a driver narrative describing an entire day used "around"/"about" for
// EVERY single time mention ("until about 5:45", "around 8:20", ...). The
// AI correctly rounded/inferred these and marked them field_provenance
// "inferred" (honest reflection of the driver's own hedging) — but
// manualLogAssistant/entry.ts's extractExplicitFacts() treated every bare
// H:MM regex match as an inviolable "explicit fact" regardless of any
// hedge word before it, so aiLayer.detectExplicitFactAlterations() then
// flagged EVERY one of those correctly-inferred fields as a "dropped
// explicit fact" and silently blocked Apply — with ProposalReview never
// even rendering (LogAssistant's !canApply branch didn't surface
// explicit_guard.blocking reasons at all), leaving the driver with only the
// interpretation text and a Dismiss button and zero explanation.
//
// Two fixes, both covered here:
//   1. extractExplicitFacts() (base44/functions/manualLogAssistant/entry.ts)
//      now excludes a time immediately preceded by an approximation
//      qualifier (about/around/near/roughly/approximately/circa/ish, and
//      Spanish cerca de/aproximadamente/casi) from the explicit-facts set.
//      That file runs in Deno and isn't importable into vitest, so the
//      function below MIRRORS it exactly (same regex, same lookback
//      window) as a permanent spec test — keep both in sync if either
//      changes.
//   2. LogAssistant.jsx's "!canApply" branch now always surfaces
//      explicit_guard.blocking's actual reasons (or a generic "no events
//      produced" notice) instead of silently showing only the
//      interpretation text — verified via aiLayer's own guard output shape.
// ============================================================================
import { describe, it, expect } from 'vitest';
import { detectExplicitFactAlterations } from './aiLayer';

// Exact mirror of extractExplicitFacts' time-hedging logic in
// base44/functions/manualLogAssistant/entry.ts — see header note above.
const APPROX_QUALIFIER_RE = /\b(?:about|around|near|roughly|approximately|circa|ish|cerca de(?: las?)?|aproximadamente|casi)\s*$/i;
function isApproximateMention(text, matchIndex) {
  const lookback = text.slice(Math.max(0, matchIndex - 20), matchIndex);
  return APPROX_QUALIFIER_RE.test(lookback);
}
function normalizeClockFact(hour, minute, meridiem) {
  let h = Number(hour);
  if (meridiem) {
    const pm = /^p/i.test(meridiem.replace(/\./g, ''));
    h = h % 12 + (pm ? 12 : 0);
  }
  return `${String(h).padStart(2, '0')}:${String(Number(minute)).padStart(2, '0')}`;
}
function extractExplicitTimes(input) {
  const text = String(input || '');
  return [...text.matchAll(/\b(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?)?\b/gi)]
    .filter((m) => !isApproximateMention(text, m.index))
    .map((m) => ({ raw: m[0], normalized: normalizeClockFact(m[1], m[2], m[3]) }));
}

const LIVE_NARRATIVE = `I was off duty in Gary until about 5:45 this morning. I did my pretrip and rolled out around 6.

I stopped in Joliet around 8:20 for fuel, was on duty there about 20 minutes, then got back on the road.

I made it to Davenport around 11:30, took my 30 off duty, and started rolling again at noon.

Got to Des Moines around 2:45, went on duty to unload and do paperwork for about 30 minutes, then went off duty for about an hour.

Around 4:15 I went back on duty for a quick equipment check, about 15 minutes, then started driving again around 4:30.

Stopped in Omaha around 7 for fuel, was on duty there about 20 minutes, then got back on the road.

I got to Lincoln around 8:15, did a 15-minute post-trip, then went off duty for the night around 8:30.`;

describe('extractExplicitFacts time-hedging fix (mirrors manualLogAssistant/entry.ts)', () => {
  it('the exact live narrative yields ZERO explicit time facts — every mention was hedged', () => {
    const times = extractExplicitTimes(LIVE_NARRATIVE);
    expect(times).toEqual([]);
  });

  it('"around 8:20" is excluded but a genuinely unhedged "8:20 AM" is kept', () => {
    expect(extractExplicitTimes('stopped around 8:20 for fuel')).toEqual([]);
    expect(extractExplicitTimes('stopped at 8:20 AM for fuel').length).toBe(1);
  });

  it('"about 5:45" / "near 5:45" / "roughly 5:45" / "approximately 5:45" are all excluded', () => {
    for (const phrase of ['about 5:45', 'near 5:45', 'roughly 5:45', 'approximately 5:45', 'circa 5:45']) {
      expect(extractExplicitTimes(`off duty until ${phrase}`)).toEqual([]);
    }
  });

  it('Spanish hedges ("cerca de las", "aproximadamente") are also excluded', () => {
    expect(extractExplicitTimes('fuera de servicio cerca de las 5:45')).toEqual([]);
    expect(extractExplicitTimes('empecé a manejar aproximadamente 6:00')).toEqual([]);
  });

  it('an unhedged time elsewhere in an otherwise-hedged narrative is still correctly captured (never over-suppressed)', () => {
    const times = extractExplicitTimes('off duty until around 5:45, then on duty at exactly 6:00 for pre-trip');
    expect(times).toHaveLength(1);
    expect(times[0].normalized).toBe('06:00');
  });

  it('a bare hour with no colon (e.g. "around 6", "around 7") was never part of the explicit-facts set to begin with', () => {
    expect(extractExplicitTimes('rolled out around 6')).toEqual([]);
  });
});

describe('REGRESSION — the guard no longer blocks a fully-hedged full-day narrative', () => {
  it('when deterministic_explicit_facts.times correctly comes back empty (all hedged), the explicit-fact guard does not block, even though every field is field_provenance "inferred"', () => {
    const events = [
      { duty_status: 'ON_DUTY', start_timestamp: '2026-09-06T09:45:00.000Z', start_time_local: '2026-09-06T05:45:00', end_time_local: '2026-09-06T06:00:00', field_provenance: { start_time: 'inferred', end_time: 'inferred', status: 'explicit' } },
      { duty_status: 'DRIVING', start_timestamp: '2026-09-06T10:00:00.000Z', start_time_local: '2026-09-06T06:00:00', end_time_local: '2026-09-06T08:20:00', field_provenance: { start_time: 'inferred', end_time: 'inferred', status: 'explicit' } },
    ];
    const guard = detectExplicitFactAlterations(events, { times: extractExplicitTimes(LIVE_NARRATIVE), locations: [], statuses: [] });
    expect(guard.blocking).toBe(false);
  });

  it('the guard STILL blocks a genuinely dropped explicit (unhedged) time — never weakened by the hedging fix', () => {
    const events = [
      { duty_status: 'ON_DUTY', start_timestamp: '2026-09-06T10:30:00.000Z', start_time_local: '2026-09-06T06:30:00', end_time_local: '2026-09-06T06:45:00', field_provenance: { start_time: 'inferred', end_time: 'inferred', status: 'explicit' } },
    ];
    const times = extractExplicitTimes('on duty at exactly 6:00 for pre-trip'); // unhedged 6:00, never appears in the proposal above
    const guard = detectExplicitFactAlterations(events, { times, locations: [], statuses: [] });
    expect(guard.blocking).toBe(true);
    expect(guard.droppedExplicitEvents.length).toBeGreaterThan(0);
  });
});
