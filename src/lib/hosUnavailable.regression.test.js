// Regression: unavailable / unverified HOS must never render as a coerced
// zero ("0 hr 0 min" / "0.00 hr") or "OK" in the Proposed Log Change dialog.
//
// Root cause being guarded against: ProposedChangeDialog used to format raw
// computeHOS fields directly (fmtDur(drivingRemainingMs) etc.). When
// computeHOS returns calculable:false (invalid timeline) those fields are
// intentional placeholder zeros, which rendered as "0 hr 0 min" / "OK" —
// misleading, because zero means "exhausted", not "cannot calculate". The
// dialog now reuses deriveHosDisplay (proposalValidation), which returns
// state-tagged cells: unavailable/unverified → '—', never a placeholder 0.
//
// Also verifies the fresh-account vs. older-history-with-gap distinction:
//   - fresh account (valid day, no prior records) → only cycle is '—'
//     (Unverified); driving/14h are real values, not placeholder zeros.
//   - unlogged multi-day gap (invalid timeline) → every clock is '—'
//     (Unavailable).
import { describe, it, expect } from 'vitest';
import { computeHOS } from './hosEngine';
import { deriveHosDisplay } from './proposalValidation';

const H = 3600000;
const base = new Date('2026-08-27T00:00:00-04:00');
const iso = (h) => new Date(base.getTime() + h * H).toISOString();
const tz = 'America/New_York';
const now = new Date(base.getTime() + 24 * H - 1);

describe('deriveHosDisplay — unavailable HOS never renders as zero (Proposed Log Change regression)', () => {
  it('invalid timeline (overlap/conflict) → every clock is "—" Unavailable, never 0/OK', () => {
    const overlap = [
      { duty_status: 'DRIVING', start_timestamp: iso(6), end_timestamp: iso(8), city: 'A', state: 'IL' },
      { duty_status: 'ON_DUTY', start_timestamp: iso(7), end_timestamp: iso(9), city: 'A', state: 'IL' },
    ];
    const hos = computeHOS(overlap, '70_8', tz, now, { historyComplete: true });
    // Guard: the engine really did mark this uncalculable (the precondition
    // for the bug). If the engine ever stops flagging overlaps as invalid,
    // this test must be updated — it should never silently pass on a
    // calculable timeline.
    expect(hos.calculable).toBe(false);

    const d = deriveHosDisplay(hos, true);
    expect(d.calculable).toBe(false);
    for (const cell of [d.driving, d.window14, d.break, d.cycle]) {
      expect(cell.value).toBe('—');
      expect(cell.state).toBe('unavailable');
      expect(cell.value).not.toMatch(/0/);
      expect(cell.value).not.toBe('OK');
    }
  });

  it('fresh account (valid day, no prior history) → cycle "—" Unverified; driving not a coerced zero', () => {
    // A full valid OFF day with no prior records: timeline is valid, but
    // cycle history is missing. This is the distinct "fresh account" case —
    // it must NOT be treated the same as an invalid-timeline gap.
    const freshDay = [
      { duty_status: 'OFF_DUTY', start_timestamp: iso(0), end_timestamp: iso(24), city: 'A', state: 'IL' },
    ];
    const hos = computeHOS(freshDay, '70_8', tz, now, { historyComplete: false });
    expect(hos.calculable).toBe(true);

    const d = deriveHosDisplay(hos, false);
    // Cycle is the only unverified clock for a fresh account.
    expect(d.cycle.value).toBe('—');
    expect(d.cycle.state).toBe('unverified');
    // Driving has not started → real remaining (full 11h), never a fabricated
    // exhausted-zero while cycle is unverified.
    expect(d.driving.value).not.toBe('0 hr 0 min');
    expect(d.driving.state).not.toBe('unavailable');
    expect(d.driving.value).not.toBe('OK');
  });

  it('unverified reset anchor (windowUnverified) → driving & 14h window "—" Unverified, not 0', () => {
    const freshDay = [
      { duty_status: 'OFF_DUTY', start_timestamp: iso(0), end_timestamp: iso(24), city: 'A', state: 'IL' },
    ];
    const hos = computeHOS(freshDay, '70_8', tz, now, { historyComplete: true, windowUnverified: true });
    const d = deriveHosDisplay(hos, true);
    expect(d.driving.state).toBe('unverified');
    expect(d.window14.state).toBe('unverified');
    expect(d.driving.value).toBe('—');
    expect(d.window14.value).toBe('—');
    expect(d.driving.value).not.toBe('0 hr 0 min');
    expect(d.window14.value).not.toBe('0 hr 0 min');
  });
});