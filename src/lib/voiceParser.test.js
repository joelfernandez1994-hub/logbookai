// ============================================================================
// LogbookAI — Deterministic voice/text parser regression tests (vitest).
// Covers the P2 AI-logging improvements: time-range parsing ("10 PM to 6 AM"),
// context-aware AM/PM disambiguation (closest-to-now instead of a fixed hour
// heuristic), and the raised explicit-time-count cap before falling back to
// the paid AI path. Nothing here calls an LLM — parseVoiceCommand is pure.
// ============================================================================
import { describe, it, expect } from 'vitest';
import { parseVoiceCommand } from './voiceParser';

const TZ = 'America/Chicago';

describe('parseVoiceCommand — time ranges', () => {
  it('parses "off duty from 10 PM to 6 AM" as one event with an explicit end, not a dangling open status', () => {
    const now = new Date('2026-08-20T22:05:00Z'); // irrelevant to the explicit times below
    const res = parseVoiceCommand('I was off duty from 10 PM to 6 AM', { now, timezone: TZ });
    expect(res.handled).toBe(true);
    expect(res.events).toHaveLength(1);
    const e = res.events[0];
    expect(e.duty_status).toBe('OFF_DUTY');
    expect(e.end_timestamp).not.toBeNull();
    // end (6 AM) is after start (10 PM) — rolled into the next calendar day.
    expect(new Date(e.end_timestamp).getTime()).toBeGreaterThan(new Date(e.start_timestamp).getTime());
    const hours = (new Date(e.end_timestamp) - new Date(e.start_timestamp)) / 3600000;
    expect(hours).toBeCloseTo(8, 1);
  });

  it('parses "sleeper from 11 to 7" (no explicit meridian on either side, but explicit berth context) as SLEEPER_BERTH', () => {
    const now = new Date('2026-08-20T11:30:00-05:00');
    const res = parseVoiceCommand('sleeper from 11 to 7', { now, timezone: TZ });
    expect(res.handled).toBe(true);
    const e = res.events[0];
    expect(e.duty_status).toBe('SLEEPER_BERTH');
    const hours = (new Date(e.end_timestamp) - new Date(e.start_timestamp)) / 3600000;
    expect(hours).toBeGreaterThan(0);
    expect(e._ambiguous.time).toBe(true); // still flagged for driver review
  });

  it('still respects an explicit meridian on both sides of a range (no guessing needed)', () => {
    const now = new Date('2026-08-20T15:00:00Z');
    const res = parseVoiceCommand('on duty from 6:00 AM to 6:15 AM', { now, timezone: TZ });
    const e = res.events[0];
    expect(e._ambiguous.time).toBe(false);
  });
});

describe('parseVoiceCommand — context-aware AM/PM default', () => {
  it('defaults an ambiguous hour to whichever meridian is closest to "now" instead of a fixed guess', () => {
    // 6 with no am/pm, spoken right after 6:05 PM -> should default to 6 PM,
    // not 6 AM (the old static heuristic treated 1-7 as always PM, which
    // happens to agree here, but 8-11 was always forced to AM regardless of
    // context — that's the case this test protects against regressing).
    const now = new Date('2026-08-20T18:05:00-05:00');
    const res = parseVoiceCommand('off duty at 6', { now, timezone: TZ });
    const e = res.events[0];
    const hourUTC = new Date(e.start_timestamp).getUTCHours();
    // 6 PM Chicago (UTC-5) = 23:00 UTC, not 11:00 UTC (6 AM).
    expect(hourUTC).toBe(23);
    expect(e._ambiguous.time).toBe(true);
  });

  it('defaults hour-9 to whichever meridian is closest to now, overriding the old fixed am-only guess', () => {
    // The prior heuristic ALWAYS forced 8-11 to AM regardless of context.
    // Here "now" is 9:05 PM, so "at 9" should resolve to 9 PM (closest),
    // not 9 AM twelve hours away.
    const now = new Date('2026-08-20T21:05:00-05:00');
    const res = parseVoiceCommand('on duty at 9', { now, timezone: TZ });
    const e = res.events[0];
    const hourUTC = new Date(e.start_timestamp).getUTCHours();
    // 9 PM Chicago (UTC-5) = 02:00 UTC (next day), not 14:00 UTC (9 AM).
    expect(hourUTC).toBe(2);
  });

  it('leaves noon (12, no meridian) defaulting to PM and unambiguous, matching prior behavior', () => {
    const now = new Date('2026-08-20T15:00:00Z');
    const res = parseVoiceCommand('on duty at 12', { now, timezone: TZ });
    const e = res.events[0];
    expect(e._ambiguous.time).toBe(false);
  });
});

describe('parseVoiceCommand — explicit-time cap', () => {
  it('handles three simple single-status clauses deterministically instead of always deferring to AI', () => {
    const now = new Date('2026-08-20T12:00:00Z');
    const text = 'off duty at 6:00 AM, on duty at 6:15 AM, driving at 6:30 AM';
    const res = parseVoiceCommand(text, { now, timezone: TZ });
    expect(res.handled).toBe(true);
    expect(res.events.length).toBeGreaterThanOrEqual(3);
  });

  it('still defers a genuinely complex multi-leg narrative to AI', () => {
    const now = new Date('2026-08-20T12:00:00Z');
    const text = 'Yesterday I was off duty until 6:00 AM, on duty at 6:00 AM, driving at 6:15 AM, fuel at 9:30 AM, driving at 9:50 AM, unloading at 12:30 PM, then off duty at 1:15 PM.';
    expect(parseVoiceCommand(text, { now, timezone: TZ })).toMatchObject({ handled: false, reason: 'complex_timeline', fallback: 'ai' });
  });
});
