// ============================================================================
// LogbookAI — IFTA AI assistant (Phase 3) regression tests. Covers the exact
// example commands from the spec plus ambiguous-input clarification behavior.
// Pure parser only — no writes happen here; that's Ifta.jsx's job after the
// driver reviews and applies.
// ============================================================================
import { describe, it, expect } from 'vitest';
import { parseIftaCommand, parseDatePhrase, parseQuarterPhrase } from './iftaAssistant';

const NOW = new Date('2026-09-05T12:00:00Z');

describe('parseIftaCommand — "Review my IFTA for Q3"', () => {
  it('resolves to a summary request for the named quarter', () => {
    const res = parseIftaCommand('Review my IFTA for Q3', { now: NOW });
    expect(res).toEqual({ type: 'summary', quarter: '2026-Q3' });
  });

  it('falls back to the current context quarter when none is named', () => {
    const res = parseIftaCommand('Review my IFTA', { now: NOW, quarter: '2026-Q2' });
    expect(res).toEqual({ type: 'summary', quarter: '2026-Q2' });
  });
});

describe('parseIftaCommand — "Which mileage still needs confirmation?"', () => {
  it('resolves to an unconfirmed-mileage query', () => {
    const res = parseIftaCommand('Which mileage still needs confirmation?', { now: NOW, quarter: '2026-Q3' });
    expect(res).toEqual({ type: 'unconfirmed_query', quarter: '2026-Q3' });
  });
});

describe('parseIftaCommand — "I fueled 126 gallons in Tifton, Georgia."', () => {
  it('proposes a fuel entry with jurisdiction normalized to a 2-letter code', () => {
    const res = parseIftaCommand('I fueled 126 gallons in Tifton, Georgia.', { now: NOW });
    expect(res.type).toBe('fuel_entry');
    expect(res.proposal).toEqual({ gallons: 126, city: 'Tifton', state: 'GA', receipt_date: '2026-09-05' });
  });

  it('accepts a 2-letter state code directly', () => {
    const res = parseIftaCommand('I fueled 90 gallons in Macon, GA', { now: NOW });
    expect(res.proposal).toMatchObject({ gallons: 90, city: 'Macon', state: 'GA' });
  });
});

describe('parseIftaCommand — "Change Georgia mileage for September 4 to 215 miles"', () => {
  it('proposes a mileage correction with jurisdiction, date, and miles resolved', () => {
    const res = parseIftaCommand('Change Georgia mileage for September 4 to 215 miles', { now: NOW });
    expect(res).toEqual({ type: 'mileage_correction', proposal: { jurisdiction: 'GA', log_date: '2026-09-04', miles: 215 } });
  });
});

describe('parseIftaCommand — "Recalculate September 4"', () => {
  it('proposes a recalculate-day action for the resolved date', () => {
    const res = parseIftaCommand('Recalculate September 4', { now: NOW });
    expect(res).toEqual({ type: 'recalculate_day', proposal: { log_date: '2026-09-04' } });
  });

  it('also recognizes "recompute" and "refresh" as synonyms', () => {
    expect(parseIftaCommand('Recompute September 4', { now: NOW }).proposal.log_date).toBe('2026-09-04');
    expect(parseIftaCommand('Refresh September 4', { now: NOW }).proposal.log_date).toBe('2026-09-04');
  });
});

describe('ambiguity — ask ONLY for the missing fact, never guess', () => {
  it('mileage correction with no date asks only for the date, keeping jurisdiction/miles', () => {
    const res = parseIftaCommand('Change Georgia mileage to 215 miles', { now: NOW });
    expect(res.type).toBe('clarify');
    expect(res.for).toBe('mileage_correction');
    expect(res.question).toMatch(/which day/i);
    expect(res.partial).toEqual({ jurisdiction: 'GA', miles: 215 });
  });

  it('mileage correction with an unrecognized jurisdiction asks only about the jurisdiction', () => {
    const res = parseIftaCommand('Change Neverland mileage for September 4 to 215 miles', { now: NOW });
    expect(res.type).toBe('clarify');
    expect(res.question).toMatch(/neverland/i);
  });

  it('fuel entry with an unrecognized state asks only about the state', () => {
    const res = parseIftaCommand('I fueled 50 gallons in Springfield, Narnia.', { now: NOW });
    expect(res.type).toBe('clarify');
    expect(res.for).toBe('fuel_entry');
    expect(res.question).toMatch(/narnia/i);
  });

  it('recalculate with no date asks only for the date', () => {
    const res = parseIftaCommand('Recalculate', { now: NOW });
    expect(res.type).toBe('clarify');
    expect(res.for).toBe('recalculate_day');
    expect(res.question).toMatch(/which day/i);
  });

  it('a date phrase that cannot be parsed produces a targeted clarification, not a guess', () => {
    const res = parseIftaCommand('Recalculate sometime last week', { now: NOW });
    expect(res.type).toBe('clarify');
    expect(res.question).toMatch(/sometime last week/i);
  });
});

describe('date phrase resolution defaults to the most recent past occurrence when no year is given', () => {
  it('a month/day that would be in the future this year resolves to last year instead', () => {
    // "now" is September 2026 — "December 4" with no year would be in the
    // future, so it should resolve to December 2025, not December 2026.
    const d = parseDatePhrase('December 4', { now: NOW });
    expect(d).toBe('2025-12-04');
  });

  it('a month/day already in the past this year resolves to this year', () => {
    const d = parseDatePhrase('September 4', { now: NOW });
    expect(d).toBe('2026-09-04');
  });

  it('parses "today" and "yesterday"', () => {
    expect(parseDatePhrase('today', { now: NOW })).toBe('2026-09-05');
    expect(parseDatePhrase('yesterday', { now: NOW })).toBe('2026-09-04');
  });

  it('parses numeric M/D and ISO dates', () => {
    expect(parseDatePhrase('9/4', { now: NOW })).toBe('2026-09-04');
    expect(parseDatePhrase('2026-09-04', { now: NOW })).toBe('2026-09-04');
  });
});

describe('parseQuarterPhrase', () => {
  it('recognizes "Q3" and an explicit year', () => {
    expect(parseQuarterPhrase('Q3 2025', { now: NOW })).toBe('2025-Q3');
  });
  it('recognizes ordinal quarter words', () => {
    expect(parseQuarterPhrase('the third quarter', { now: NOW })).toBe('2026-Q3');
  });
  it('returns null when no quarter is named', () => {
    expect(parseQuarterPhrase('review my mileage', { now: NOW })).toBeNull();
  });
});

describe('unrecognized input never fabricates a proposal', () => {
  it('returns unrecognized for unrelated text', () => {
    expect(parseIftaCommand('What is the weather today?', { now: NOW })).toEqual({ type: 'unrecognized' });
  });
  it('returns unrecognized for empty input', () => {
    expect(parseIftaCommand('', { now: NOW })).toEqual({ type: 'unrecognized' });
  });
});
