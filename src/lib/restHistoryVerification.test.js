// Regression tests: deterministic rest-history verification (no AI, no DB).
// Covers the PRD-required classifications — valid cross-midnight rest,
// consecutive Off Duty days, partial-day gaps, overlaps/conflicts, and
// missing historical records — plus the guarantee that verification NEVER
// mutates the driver's persisted log records.
import { describe, it, expect } from 'vitest';
import {
  verifyRestHistory, isRestHistoryNote, isStaleRestHistoryNote, formatUnresolvedRange,
} from './restHistoryVerification';

const ev = (duty_status, start, end, extra = {}) => ({
  duty_status, start_timestamp: start, end_timestamp: end || null, city: 'Springfield', state: 'IL', ...extra,
});
const ts = (d) => (d instanceof Date ? d.toISOString() : d);

describe('verifyRestHistory — verified classifications', () => {
  it('cross-midnight rest ≥10h ending right before driving verifies as cross_midnight_rest', () => {
    const events = [
      ev('OFF_DUTY', '2026-10-17T20:00:00Z', '2026-10-18T10:00:00Z'),
      ev('DRIVING', '2026-10-18T10:00:00Z', '2026-10-18T16:00:00Z'),
    ];
    const v = verifyRestHistory(events, { tz: 'UTC', asOf: '2026-10-18T16:00:00Z' });
    expect(v.verified).toBe(true);
    expect(v.status).toBe('verified');
    expect(v.kind).toBe('full_reset');
    expect(v.classification).toBe('cross_midnight_rest');
    expect(v.anchorInterval.start.toISOString()).toBe('2026-10-17T20:00:00.000Z');
    expect(v.anchorInterval.end.toISOString()).toBe('2026-10-18T10:00:00.000Z');
    expect(v.unresolvedRange).toBeNull();
  });

  it('consecutive Off Duty days chain into one qualifying reset; sub-minute boundary seams do not block', () => {
    // 1-second date-boundary gaps (the exact seam class seen in real records).
    const events = [
      ev('OFF_DUTY', '2026-10-14T00:00:00Z', '2026-10-14T23:59:59Z'),
      ev('OFF_DUTY', '2026-10-15T00:00:00Z', '2026-10-15T23:59:59Z'),
      ev('OFF_DUTY', '2026-10-16T00:00:00Z', '2026-10-16T08:00:00Z'),
      ev('DRIVING', '2026-10-16T08:00:00Z', '2026-10-16T12:00:00Z'),
    ];
    const v = verifyRestHistory(events, { tz: 'UTC', asOf: '2026-10-16T12:00:00Z' });
    expect(v.verified).toBe(true);
    expect(v.kind).toBe('full_reset');
    expect(v.classification).toBe('cross_midnight_rest');
    expect(v.anchor.toISOString()).toBe('2026-10-16T08:00:00.000Z');
  });

  it('a valid split-sleeper anchor verifies as split_sleeper', () => {
    const events = [
      ev('OFF_DUTY', '2026-10-15T00:00:00Z', '2026-10-15T10:00:00Z'),
      ev('DRIVING', '2026-10-15T10:00:00Z', '2026-10-15T14:00:00Z'),
      ev('SLEEPER_BERTH', '2026-10-15T14:00:00Z', '2026-10-15T21:30:00Z'), // ≥7h
      ev('DRIVING', '2026-10-15T21:30:00Z', '2026-10-15T23:00:00Z'),
    ];
    const v = verifyRestHistory(events, { tz: 'UTC', asOf: '2026-10-15T23:00:00Z' });
    expect(v.verified).toBe(true);
    expect(v.kind).toBe('split_sleeper');
  });

  it('no driving at/before the evaluation point → verified, no_driving', () => {
    const events = [ev('OFF_DUTY', '2026-10-16T00:00:00Z', '2026-10-16T12:00:00Z')];
    const v = verifyRestHistory(events, { tz: 'UTC', asOf: '2026-10-16T12:00:00Z' });
    expect(v.verified).toBe(true);
    expect(v.status).toBe('no_driving');
  });

  it('record begins with driving and no prior rest → verified, absent_history (engine type none)', () => {
    const events = [ev('DRIVING', '2026-10-16T00:00:00Z', '2026-10-16T04:00:00Z')];
    const v = verifyRestHistory(events, { tz: 'UTC', asOf: '2026-10-16T04:00:00Z' });
    expect(v.verified).toBe(true);
    expect(v.status).toBe('verified');
    expect(v.classification).toBe('absent_history');
  });

  it('brand-new record whose first entry is a leading rest run → implied anchor, verified', () => {
    const events = [
      ev('OFF_DUTY', '2026-10-16T00:00:00Z', '2026-10-16T04:00:00Z'),
      ev('DRIVING', '2026-10-16T04:00:00Z', '2026-10-16T08:00:00Z'),
    ];
    const v = verifyRestHistory(events, { tz: 'UTC', asOf: '2026-10-16T08:00:00Z' });
    expect(v.verified).toBe(true);
    expect(v.kind).toBe('implied_first_record');
  });
});

describe('verifyRestHistory — unverified classifications keep clocks gated with the exact interval', () => {
  it('partial-day gap → unverified with the exact unresolved range', () => {
    const events = [
      ev('OFF_DUTY', '2026-10-15T00:00:00Z', '2026-10-15T20:00:00Z'),
      ev('DRIVING', '2026-10-16T02:00:00Z', '2026-10-16T06:00:00Z'),
    ];
    const v = verifyRestHistory(events, { tz: 'UTC', asOf: '2026-10-16T06:00:00Z' });
    expect(v.verified).toBe(false);
    expect(v.status).toBe('unverified');
    expect(v.classification).toBe('gap');
    expect(v.unresolvedRange.start.toISOString()).toBe('2026-10-15T20:00:00.000Z');
    expect(v.unresolvedRange.end.toISOString()).toBe('2026-10-16T02:00:00.000Z');
    expect(v.anchor).toBeNull();
  });

  it('same-start conflict (overlap) → unverified, never a verified anchor through contradictions', () => {
    const events = [
      ev('DRIVING', '2026-10-16T06:00:00Z', '2026-10-16T10:00:00Z'),
      ev('ON_DUTY', '2026-10-16T10:00:00Z', '2026-10-16T11:00:00Z'),
      ev('DRIVING', '2026-10-16T10:00:00Z', '2026-10-16T14:00:00Z'),
    ];
    const v = verifyRestHistory(events, { tz: 'UTC', asOf: '2026-10-16T14:00:00Z' });
    expect(v.verified).toBe(false);
    expect(v.status).toBe('unverified');
    expect(v.classification).toBe('overlap');
    expect(v.unresolvedRange.start.toISOString()).toBe('2026-10-16T10:00:00.000Z');
  });
});

describe('rest-history note staleness', () => {
  const note = { type: 'rest_history_unverified', title: 'HOS REST HISTORY UNVERIFIED', message: 'The rest history immediately before your driving could not be verified contiguously.' };
  const verified = { verified: true, status: 'verified' };
  const unverified = { verified: false, status: 'unverified' };

  it('saved note is stale once recomputation verifies the rest', () => {
    expect(isRestHistoryNote(note)).toBe(true);
    expect(isStaleRestHistoryNote(note, verified)).toBe(true);
  });

  it('saved note still applies while verification fails', () => {
    expect(isStaleRestHistoryNote(note, unverified)).toBe(false);
    expect(isStaleRestHistoryNote(note, null)).toBe(false);
  });

  it('non-rest-history notes are never suppressed by this check', () => {
    expect(isRestHistoryNote({ title: 'TIMELINE STRUCTURE', message: 'gap' })).toBe(false);
    expect(isStaleRestHistoryNote({ title: 'TIMELINE STRUCTURE', message: 'gap' }, verified)).toBe(false);
  });

  it('formats the unresolved range in the log timezone', () => {
    expect(formatUnresolvedRange({ start: '2026-10-15T20:00:00Z', end: '2026-10-16T02:00:00Z' }, 'UTC')).toMatch(/Oct 15/);
    expect(formatUnresolvedRange(null, 'UTC')).toBe('');
  });
});

describe('no mutation guarantee', () => {
  it('verification never alters the persisted event records', () => {
    const events = [
      ev('OFF_DUTY', '2026-10-15T00:00:00Z', '2026-10-15T20:00:00Z', { review_notes: [{ title: 'HOS REST HISTORY UNVERIFIED', message: 'x' }] }),
      ev('DRIVING', '2026-10-16T02:00:00Z', '2026-10-16T06:00:00Z', { review_notes: [{ title: 'HOS REST HISTORY UNVERIFIED', message: 'x' }] }),
    ];
    const snapshot = JSON.stringify(events);
    verifyRestHistory(events, { tz: 'UTC', asOf: '2026-10-16T06:00:00Z' });
    verifyRestHistory(events, { tz: 'UTC', asOf: '2026-10-18T06:00:00Z' });
    expect(JSON.stringify(events)).toBe(snapshot);
  });
});