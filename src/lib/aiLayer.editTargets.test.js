// ============================================================================
// LogbookAI — resolveEditTargets regression tests. Guards the fix for a real
// production bug: an AI-proposed edit_events/delete_events intent used to
// ALWAYS get applied as a new insertEventsBatch call (never a real edit),
// which would duplicate/overlap the timeline instead of correcting it.
// resolveEditTargets is the seam that must resolve an index back to a real
// existing event id — and must report "unresolved" rather than ever letting
// an unresolvable edit fall through as a silent insert.
// ============================================================================
import { describe, it, expect } from 'vitest';
import { resolveEditTargets, validateInterpretResult } from './aiLayer';

const EVENTS = [
  { id: 'a', start_timestamp: '2026-08-20T10:00:00.000Z', duty_status: 'OFF_DUTY' },
  { id: 'b', start_timestamp: '2026-08-20T13:00:00.000Z', duty_status: 'ON_DUTY', remark: 'Fuel' },
  { id: 'c', start_timestamp: '2026-08-20T13:20:00.000Z', duty_status: 'DRIVING' },
];

describe('resolveEditTargets — edit_events', () => {
  it('resolves a valid edit_target_index to the real event', () => {
    const normalized = { intent: 'edit_events', proposed_events: [{ edit_target_index: 1, city: 'Orlando' }] };
    const { resolvedEdits, unresolvedEdits } = resolveEditTargets(EVENTS, normalized);
    expect(resolvedEdits).toHaveLength(1);
    expect(resolvedEdits[0].target.id).toBe('b');
    expect(unresolvedEdits).toHaveLength(0);
  });

  it('treats a null edit_target_index as unresolved — never silently maps to an event', () => {
    const normalized = { intent: 'edit_events', proposed_events: [{ edit_target_index: null, city: 'Orlando' }] };
    const { resolvedEdits, unresolvedEdits } = resolveEditTargets(EVENTS, normalized);
    expect(resolvedEdits).toHaveLength(0);
    expect(unresolvedEdits).toHaveLength(1);
  });

  it('treats an out-of-range index as unresolved', () => {
    const normalized = { intent: 'edit_events', proposed_events: [{ edit_target_index: 99, city: 'Orlando' }] };
    const { unresolvedEdits } = resolveEditTargets(EVENTS, normalized);
    expect(unresolvedEdits).toHaveLength(1);
  });

  it('a mix of resolved and unresolved edits reports both (caller treats the whole batch as unresolved)', () => {
    const normalized = { intent: 'edit_events', proposed_events: [{ edit_target_index: 0 }, { edit_target_index: null }] };
    const { resolvedEdits, unresolvedEdits } = resolveEditTargets(EVENTS, normalized);
    expect(resolvedEdits).toHaveLength(1);
    expect(unresolvedEdits).toHaveLength(1);
  });
});

describe('resolveEditTargets — delete_events', () => {
  it('resolves valid delete_target_indices to real events', () => {
    const normalized = { intent: 'delete_events', delete_target_indices: [0, 2] };
    const { resolvedDeletes, unresolvedDeletes } = resolveEditTargets(EVENTS, normalized);
    expect(resolvedDeletes.map(r => r.event.id)).toEqual(['a', 'c']);
    expect(unresolvedDeletes).toHaveLength(0);
  });

  it('an out-of-range delete index is unresolved, never deletes the wrong event', () => {
    const normalized = { intent: 'delete_events', delete_target_indices: [42] };
    const { resolvedDeletes, unresolvedDeletes } = resolveEditTargets(EVENTS, normalized);
    expect(resolvedDeletes).toHaveLength(0);
    expect(unresolvedDeletes).toHaveLength(1);
  });

  it('an empty delete_target_indices resolves to nothing (caller must treat this as unresolved, not a no-op success)', () => {
    const normalized = { intent: 'delete_events', delete_target_indices: [] };
    const { resolvedDeletes, unresolvedDeletes } = resolveEditTargets(EVENTS, normalized);
    expect(resolvedDeletes).toHaveLength(0);
    expect(unresolvedDeletes).toHaveLength(0);
  });
});

describe('resolveEditTargets — other intents are inert', () => {
  it('returns all-empty for add_events/replace_day/question (nothing to resolve)', () => {
    for (const intent of ['add_events', 'replace_day', 'question', 'hos_question', 'clarification']) {
      const r = resolveEditTargets(EVENTS, { intent, proposed_events: [{ edit_target_index: 0 }] });
      expect(r.resolvedEdits).toHaveLength(0);
      expect(r.resolvedDeletes).toHaveLength(0);
    }
  });

  it('handles missing/empty events array without throwing', () => {
    expect(() => resolveEditTargets([], { intent: 'edit_events', proposed_events: [{ edit_target_index: 0 }] })).not.toThrow();
    expect(() => resolveEditTargets(null, { intent: 'delete_events', delete_target_indices: [0] })).not.toThrow();
  });
});

describe('validateInterpretResult — carries edit_target_index / delete_target_indices through normalization', () => {
  it('normalizes edit_target_index per proposed event', () => {
    const { normalized } = validateInterpretResult({
      intent: 'edit_events',
      proposed_events: [{ start_timestamp: '2026-08-20T13:00:00.000Z', duty_status: 'ON_DUTY', edit_target_index: 1 }],
    });
    expect(normalized.proposed_events[0].edit_target_index).toBe(1);
  });

  it('defaults a missing edit_target_index to null (not 0, not undefined-as-truthy)', () => {
    const { normalized } = validateInterpretResult({
      intent: 'edit_events',
      proposed_events: [{ start_timestamp: '2026-08-20T13:00:00.000Z', duty_status: 'ON_DUTY' }],
    });
    expect(normalized.proposed_events[0].edit_target_index).toBeNull();
  });

  it('carries delete_target_indices through and filters non-integers', () => {
    const { normalized } = validateInterpretResult({
      intent: 'delete_events', proposed_events: [], delete_target_indices: [0, 'x', 2, null],
    });
    expect(normalized.delete_target_indices).toEqual([0, 2]);
  });

  it('accepts the new "delete_events" intent as valid (not coerced to add_events)', () => {
    const { normalized, errors } = validateInterpretResult({ intent: 'delete_events', proposed_events: [], delete_target_indices: [0] });
    expect(normalized.intent).toBe('delete_events');
    expect(errors).toEqual([]);
  });
});
