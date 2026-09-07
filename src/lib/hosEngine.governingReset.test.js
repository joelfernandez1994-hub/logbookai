// ============================================================================
// LogbookAI — REGRESSION: 14-hour window anchor must not reach through an
// unlogged gap to an ancient qualifying reset.
// ----------------------------------------------------------------------------
// Live bug (account 6a861df91bc2d86b11ec06b2, "Today" screen): the visible
// 24-hour timeline was
//   00:00–06:00 OFF_DUTY, 06:00–06:15 ON_DUTY (Pre-Trip), 06:15→ongoing DRIVING
// and the graph/Driving-Remaining/Cycle cards all agreed the timeline was
// continuous and valid — but the "14-Hour Window" card showed 0h 0min "since
// 11:59 PM", internally inconsistent with the visible day.
//
// Root cause: computeGoverningReset() searched the driver's ENTIRE historical
// segments for "the most recent >=10h qualifying rest block", with no
// requirement that the block be reachable from `now` via a contiguous
// (gap-free) timeline. This account's real history had a genuine >=10h OFF
// DUTY block from 2026-08-24T16:05Z to 2026-08-25T03:59Z (03:59 UTC = 11:59
// PM ET) — then NOTHING logged for ~13 days — then today's fresh (6h,
// non-qualifying) OFF_DUTY block. The search reached straight through that
// 13-day silence and anchored the 14-hour window on the 13-day-old reset,
// producing a ~13-day "elapsed" wall-clock time -> remainingMs clamped to 0,
// windowStart = the stale Aug 24/25 boundary ("11:59 PM").
//
// Fix: computeGoverningReset() now only searches the CONTIGUOUS region
// reachable from `now` (reachableRegion() in hosEngine.js) — the same
// "never reach through a discontinuity to an older reset" protection
// computeContiguousGoverningReset() already provided for AI-proposal
// construction, generalized so every caller (Today, compliance checks, Trip
// Planner) shares it, since they all read the same canonical timeline. When
// the reachable region has no qualifying reset AND genuinely reaches the
// very first segment ever logged (nothing earlier exists to weigh against
// it), the record's own leading rest run is used as an "implied" anchor
// (type: 'implied') rather than reporting unverified — there's no history to
// contradict it. When the region instead stops at a real gap with older
// history beyond it, the result is 'unverified' (referenceTime: null,
// window14.applicable: false) — never a fabricated "0h 0min" number.
// Today.jsx (and LogAssistant.jsx's HOS summary sent to the AI) were also
// fixed to gate on `hos.window14.applicable` / `hos.driving.applicable`, not
// just `timelineValidation.valid` — an inapplicable clock must show "--" /
// unavailable, never the raw fallback numbers baked into
// compute14HourWindow/computeDrivingLimit's "not applicable" return shape.
// ============================================================================
import { describe, it, expect } from 'vitest';
import { computeHOS, computeGoverningReset, normalizeEvents } from './hosEngine';

const TZ = 'America/New_York';

function iso(hoursFromMidnightUtc, dateStr = '2026-09-07') {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  return new Date(d.getTime() + hoursFromMidnightUtc * 3600000).toISOString();
}

describe('REGRESSION — 14-hour window anchor: requested exact scenario', () => {
  // 00:00–06:00 OFF DUTY / 06:00–06:15 ON DUTY / 06:15→current DRIVING, and
  // NOTHING else in the account's history (a fresh record — not a gap in a
  // longer one).
  const events = [
    { duty_status: 'OFF_DUTY', start_timestamp: iso(4), end_timestamp: iso(10) }, // 00:00–06:00 ET (UTC-4)
    { duty_status: 'ON_DUTY', start_timestamp: iso(10), end_timestamp: iso(10.25) }, // 06:00–06:15 ET
    { duty_status: 'DRIVING', start_timestamp: iso(10.25), end_timestamp: null, is_ongoing: true }, // 06:15 ET → ongoing
  ];
  const now = new Date(iso(13.5)); // ~9:30 AM ET

  it('the 14-hour window is anchored at the morning work start, not at a prior-day/midnight artifact', () => {
    const hos = computeHOS(events, '70_8', TZ, now, { historyComplete: true });
    expect(hos.calculable).toBe(true);
    expect(hos.window14.applicable).toBe(true);
    // Anchored at 06:00 ET (end of the leading OFF_DUTY run that precedes
    // On Duty/Driving) — NOT at 23:59/11:59 PM of any prior day, and NOT
    // null/zeroed out.
    const windowStart = new Date(hos.window14.windowStart);
    expect(windowStart.toISOString()).toBe(iso(10));
    expect(windowStart.getUTCHours()).not.toBe(3); // 03:59 UTC == 11:59 PM ET — must never be this
    // ~3h15m elapsed since 06:00 ET -> plenty of window remaining, never 0.
    expect(hos.window14.remainingMs).toBeGreaterThan(10 * 3600000);
  });

  it('governing reset anchors driving-remaining at the same 06:00 ET point (Today and the HOS engine read the same timeline)', () => {
    const hos = computeHOS(events, '70_8', TZ, now, { historyComplete: true });
    expect(hos.driving.applicable).toBe(true);
    expect(new Date(hos.driving.tourStart).toISOString()).toBe(iso(10));
  });
});

describe('REGRESSION — the exact live production bug (account 6a861df91bc2d86b11ec06b2)', () => {
  // Verbatim (duty_status/start/end) reconstruction of this account's real
  // DutyStatusEvent rows: a genuine >=10h reset on 2026-08-24/25 (ending
  // 03:59 UTC = 11:59 PM ET), then a ~13-day unlogged gap, then today's
  // fresh (6h, non-qualifying on its own) OFF_DUTY/ON_DUTY/DRIVING sequence.
  const events = [
    { duty_status: 'OFF_DUTY', start_timestamp: '2026-08-24T04:00:00.000Z', end_timestamp: '2026-08-24T10:00:00.000Z' },
    { duty_status: 'ON_DUTY', start_timestamp: '2026-08-24T10:00:00.000Z', end_timestamp: '2026-08-24T10:15:00.000Z' },
    { duty_status: 'DRIVING', start_timestamp: '2026-08-24T10:15:00.000Z', end_timestamp: '2026-08-24T11:15:00.000Z' },
    { duty_status: 'ON_DUTY', start_timestamp: '2026-08-24T11:15:00.000Z', end_timestamp: '2026-08-24T11:35:00.000Z' },
    { duty_status: 'DRIVING', start_timestamp: '2026-08-24T11:35:00.000Z', end_timestamp: '2026-08-24T12:35:00.000Z' },
    { duty_status: 'OFF_DUTY', start_timestamp: '2026-08-24T12:35:00.000Z', end_timestamp: '2026-08-24T13:05:00.000Z' },
    { duty_status: 'DRIVING', start_timestamp: '2026-08-24T13:05:00.000Z', end_timestamp: '2026-08-24T14:05:00.000Z' },
    { duty_status: 'ON_DUTY', start_timestamp: '2026-08-24T14:05:00.000Z', end_timestamp: '2026-08-24T14:50:00.000Z' },
    { duty_status: 'DRIVING', start_timestamp: '2026-08-24T14:50:00.000Z', end_timestamp: '2026-08-24T15:50:00.000Z' },
    { duty_status: 'ON_DUTY', start_timestamp: '2026-08-24T15:50:00.000Z', end_timestamp: '2026-08-24T16:05:00.000Z' },
    { duty_status: 'OFF_DUTY', start_timestamp: '2026-08-24T16:05:00.000Z', end_timestamp: '2026-08-25T03:59:00.000Z' }, // 11h54m qualifying, ends 11:59 PM ET
    // ~13-day unlogged gap in the real data here.
    { duty_status: 'OFF_DUTY', start_timestamp: '2026-09-07T04:00:00.000Z', end_timestamp: '2026-09-07T10:00:00.000Z' }, // 00:00–06:00 ET, 6h — not qualifying alone
    { duty_status: 'ON_DUTY', start_timestamp: '2026-09-07T10:00:00.000Z', end_timestamp: '2026-09-07T10:15:00.000Z' },
    { duty_status: 'DRIVING', start_timestamp: '2026-09-07T10:15:00.000Z', end_timestamp: null, is_ongoing: true },
  ];
  const now = new Date('2026-09-07T13:25:00.000Z'); // ~9:25 AM ET, matches the reported screenshot

  it('never anchors the 14-hour window on the stale Aug 24/25 reset reached through the 13-day gap', () => {
    const hos = computeHOS(events, '70_8', TZ, now, { historyComplete: true });
    expect(hos.calculable).toBe(true); // today's own slice is still a valid, continuous timeline
    expect(hos.governing.type).not.toBe('full'); // must not silently accept the ancient reset
    expect(hos.window14.windowStart).not.toEqual(new Date('2026-08-25T03:59:00.000Z'));
  });

  it('reports the window as unverified (not applicable) rather than a fabricated "0h 0min"', () => {
    const hos = computeHOS(events, '70_8', TZ, now, { historyComplete: true });
    expect(hos.governing.type).toBe('unverified');
    expect(hos.window14.applicable).toBe(false);
    expect(hos.driving.applicable).toBe(false);
    // The old bug's exact symptom — a numeric 0 alongside a real windowStart
    // — must never recur: when unavailable, windowStart is null, not a
    // computed-but-wrong timestamp.
    expect(hos.window14.windowStart).toBeNull();
  });
});

describe('computeGoverningReset — reachability does not disturb the ordinary contiguous case', () => {
  it('a normal, unbroken day with a real >=10h reset right before driving still anchors on it (type "full")', () => {
    const segments = normalizeEvents([
      { duty_status: 'OFF_DUTY', start_timestamp: '2026-09-06T20:00:00.000Z', end_timestamp: '2026-09-07T10:00:00.000Z' }, // 14h, qualifying
      { duty_status: 'ON_DUTY', start_timestamp: '2026-09-07T10:00:00.000Z', end_timestamp: '2026-09-07T10:15:00.000Z' },
      { duty_status: 'DRIVING', start_timestamp: '2026-09-07T10:15:00.000Z', end_timestamp: null, is_ongoing: true },
    ], new Date('2026-09-07T12:00:00.000Z'));
    const governing = computeGoverningReset(segments, new Date('2026-09-07T12:00:00.000Z'));
    expect(governing.type).toBe('full');
    expect(governing.referenceTime.toISOString()).toBe('2026-09-07T10:00:00.000Z');
  });
});
