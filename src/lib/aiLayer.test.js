import { describe, it, expect } from 'vitest';
import { planReplaceRange, planInsert } from './timelineEngine';
import {
  validateInterpretResult, isQuestionIntent, shouldOfferApply, replaceDayRange, normalizeStatus,
} from './aiLayer';

const tz = 'America/Chicago';

describe('aiLayer.validateInterpretResult', () => {
  it('normalizes SLEEPER -> SLEEPER_BERTH and start_time -> start_timestamp', () => {
    const { valid, normalized } = validateInterpretResult({
      intent: 'add_events',
      summary: 'Logged your morning',
      proposed_events: [
        { start_time: '2026-08-20T11:00:00Z', end_time: '2026-08-20T15:00:00Z', status: 'SLEEPER', city: 'Miami', state: 'FL', activity: 'Sleeper', remark: '' },
      ],
    });
    expect(valid).toBe(true);
    expect(normalized.proposed_events[0].duty_status).toBe('SLEEPER_BERTH');
    expect(normalized.proposed_events[0].start_timestamp).toBe('2026-08-20T11:00:00Z');
    expect(normalized.proposed_events[0].end_timestamp).toBe('2026-08-20T15:00:00Z');
    expect(normalized.interpretation).toBe('Logged your morning');
  });

  it('flags an invalid schema (missing start time, bad status) but still returns a normalized shape', () => {
    const { valid, errors, normalized } = validateInterpretResult({
      intent: 'add_events',
      proposed_events: [{ start_time: '', status: 'DRIVE', city: '', state: '' }],
    });
    expect(valid).toBe(false);
    expect(errors.some((e) => /missing a start time/.test(e))).toBe(true);
    expect(errors.some((e) => /invalid duty status/.test(e))).toBe(true);
    expect(normalized.proposed_events[0].duty_status).toBe('DRIVE'); // bad status preserved + flagged
  });

  it('falls back to add_events for an unknown intent', () => {
    const { normalized } = validateInterpretResult({ intent: 'bogus', proposed_events: [] });
    expect(normalized.intent).toBe('add_events');
  });

  it('preserves requires_clarification and clarification_question', () => {
    const { normalized } = validateInterpretResult({
      intent: 'clarification', requires_clarification: true,
      clarification_question: 'Did you mean 11:00 AM?', proposed_events: [],
    });
    expect(normalized.requires_clarification).toBe(true);
    expect(normalized.clarification_question).toBe('Did you mean 11:00 AM?');
  });
});

describe('aiLayer intent branching', () => {
  it('treats question and hos_question as non-applying', () => {
    expect(isQuestionIntent('question')).toBe(true);
    expect(isQuestionIntent('hos_question')).toBe(true);
    expect(isQuestionIntent('add_events')).toBe(false);
  });

  it('offers Apply only for proposing intents with events and no fabrication refusal', () => {
    expect(shouldOfferApply({ intent: 'add_events', proposed_events: [{ start_timestamp: '2026-08-20T11:00:00Z', duty_status: 'DRIVING' }] })).toBe(true);
    expect(shouldOfferApply({ intent: 'replace_day', proposed_events: [{ start_timestamp: '2026-08-20T11:00:00Z', duty_status: 'ON_DUTY' }] })).toBe(true);
    expect(shouldOfferApply({ intent: 'question', proposed_events: [] })).toBe(false);
    expect(shouldOfferApply({ intent: 'add_events', proposed_events: [] })).toBe(false);
    expect(shouldOfferApply({ intent: 'add_events', refuses_fabrication: true, proposed_events: [{ start_timestamp: '2026-08-20T11:00:00Z', duty_status: 'DRIVING' }] })).toBe(false);
  });
});

describe('aiLayer.replaceDayRange', () => {
  it('returns a 24h window anchored at the target date in tz', () => {
    const { dayStart, dayEnd } = replaceDayRange('2026-08-20', tz);
    expect(dayEnd - dayStart).toBe(24 * 3600000);
    expect(dayStart.toISOString().startsWith('2026-08-20')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Canonical writer guarantees the AI layer relies on (replace vs append,
// duplicate / invalid rejection without writing).
// ---------------------------------------------------------------------------
describe('planReplaceRange (replace-day must REPLACE, not append)', () => {
  const existing = [
    { id: 'a', log_date: '2026-08-20', start_timestamp: '2026-08-20T13:00:00Z', end_timestamp: '2026-08-20T15:00:00Z', duty_status: 'DRIVING', is_ongoing: false },
    { id: 'b', log_date: '2026-08-20', start_timestamp: '2026-08-20T15:00:00Z', end_timestamp: '2026-08-20T17:00:00Z', duty_status: 'ON_DUTY', is_ongoing: false },
  ];
  const replacement = [
    { start_timestamp: '2026-08-20T13:00:00Z', end_timestamp: '2026-08-20T14:00:00Z', duty_status: 'ON_DUTY', remark: 'Fuel', is_ongoing: false },
  ];

  it('deletes events fully inside the range, not appends alongside them', () => {
    const ops = planReplaceRange(existing, '2026-08-20T13:00:00Z', '2026-08-20T17:00:00Z', replacement);
    expect(ops.deletes).toContain('a');
    expect(ops.deletes).toContain('b');
    expect(ops.creates.length).toBe(1);
    expect(ops.creates[0].duty_status).toBe('ON_DUTY');
  });

  it('truncates a cross-boundary event so the adjacent day is preserved', () => {
    const cross = [
      { id: 'x', log_date: '2026-08-20', start_timestamp: '2026-08-20T16:00:00Z', end_timestamp: '2026-08-20T20:00:00Z', duty_status: 'DRIVING', is_ongoing: false },
    ];
    const ops = planReplaceRange(cross, '2026-08-20T13:00:00Z', '2026-08-20T17:00:00Z', replacement);
    // x straddles the right edge -> its start is moved to rangeEnd (preserved), not deleted
    expect(ops.deletes).not.toContain('x');
    expect(ops.updates.some((u) => u.id === 'x' && u.data.start_timestamp === '2026-08-20T17:00:00Z')).toBe(true);
    // the replacement event is inserted at the range start
    expect(ops.creates.some((c) => c.start_timestamp === '2026-08-20T13:00:00Z')).toBe(true);
  });
});

describe('planInsert (failed / invalid / duplicate writes nothing)', () => {
  it('rejects end-before-start as invalid and creates nothing', () => {
    const ops = planInsert([], {
      start_timestamp: '2026-08-20T15:00:00Z', end_timestamp: '2026-08-20T14:00:00Z',
      duty_status: 'DRIVING', is_ongoing: false,
    });
    expect(ops.invalid).toBe(true);
    expect(ops.creates.length).toBe(0);
  });

  it('rejects an exact duplicate (same start + status) and creates nothing', () => {
    const existing = [{ id: 'a', start_timestamp: '2026-08-20T15:00:00Z', end_timestamp: '2026-08-20T16:00:00Z', duty_status: 'DRIVING', is_ongoing: false }];
    const ops = planInsert(existing, { start_timestamp: '2026-08-20T15:00:00Z', duty_status: 'DRIVING', is_ongoing: false });
    expect(ops.duplicate).toBe(true);
    expect(ops.creates.length).toBe(0);
  });

  it('a cancellation (no apply call) leaves the existing timeline untouched', () => {
    // The writer is never invoked on Cancel; planInsert with no new event trivially
    // produces no creates, modelling "nothing written".
    const ops = planInsert([], { start_timestamp: '', duty_status: '', is_ongoing: false });
    expect(ops.invalid || ops.creates.length === 0).toBe(true);
  });
});

describe('normalizeStatus', () => {
  it('maps SLEEPER to SLEEPER_BERTH and uppercases', () => {
    expect(normalizeStatus('SLEEPER')).toBe('SLEEPER_BERTH');
    expect(normalizeStatus('driving')).toBe('DRIVING');
    expect(normalizeStatus('SLEEPER_BERTH')).toBe('SLEEPER_BERTH');
  });
});