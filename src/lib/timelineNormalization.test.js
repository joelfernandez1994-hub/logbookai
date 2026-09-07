// ============================================================================
// LogbookAI — normalizeCandidateTimeline regression tests. Pure, no AI, no
// network. Covers the general boundary-cleanup rules (see module header):
// sort, close-open-against-next, truncate-inferred-past-explicit, never move
// an explicit fact, surface genuine explicit conflicts, only the last event
// stays open, and never truncate across more than one later boundary.
// ============================================================================
import { describe, it, expect } from 'vitest';
import { normalizeCandidateTimeline } from './timelineNormalization';

const H = 3600000;
const base = new Date('2026-09-06T12:00:00.000Z').getTime(); // noon UTC anchor
const at = (h) => new Date(base + h * H).toISOString();

function ev(status, startH, endH, opts = {}) {
  return {
    duty_status: status,
    start_timestamp: at(startH),
    end_timestamp: endH == null ? null : at(endH),
    city: opts.city || '', state: opts.state || '',
    remark: opts.remark || '',
    field_provenance: opts.field_provenance,
    is_ongoing: opts.is_ongoing,
    id: opts.id,
  };
}

describe('normalizeCandidateTimeline — the user\'s own worked example', () => {
  it('"11:30 OFF DUTY (30-min break)" then "12:00 DRIVING" normalizes to 11:30–12:00 / 12:00–ongoing', () => {
    const events = [
      ev('OFF_DUTY', 11.5, null, { remark: '30-minute break', field_provenance: { end_time: 'inferred' } }),
      ev('DRIVING', 12, null, { field_provenance: { start_time: 'explicit' } }),
    ];
    const { events: out, conflicts } = normalizeCandidateTimeline(events);
    expect(conflicts).toHaveLength(0);
    expect(out[0].end_timestamp).toBe(at(12));
    expect(out[1].end_timestamp).toBeNull(); // only the LAST event may remain ongoing
  });

  it('if the AI returns 11:05–11:30 DRIVING then 11:30–12:00 OFF DUTY, that is already fine (no change)', () => {
    const events = [
      ev('DRIVING', 11 + 5 / 60, 11.5, { field_provenance: { end_time: 'explicit' } }),
      ev('OFF_DUTY', 11.5, 12, { field_provenance: { end_time: 'explicit' } }),
    ];
    const { events: out, conflicts } = normalizeCandidateTimeline(events);
    expect(conflicts).toHaveLength(0);
    expect(out[0].end_timestamp).toBe(at(11.5));
    expect(out[1].start_timestamp).toBe(at(11.5));
  });

  it('11:05–1:30 DRIVING (inferred end) overlapping 11:30–12:00 OFF DUTY truncates the Driving segment to 11:30', () => {
    const events = [
      ev('DRIVING', 11 + 5 / 60, 13.5, { field_provenance: { end_time: 'inferred' } }),
      ev('OFF_DUTY', 11.5, 12, { field_provenance: { start_time: 'explicit', end_time: 'explicit' } }),
    ];
    const { events: out, conflicts } = normalizeCandidateTimeline(events);
    expect(conflicts).toHaveLength(0);
    expect(out[0].end_timestamp).toBe(at(11.5)); // truncated, never past the OFF_DUTY start
    expect(out[1].start_timestamp).toBe(at(11.5)); // OFF_DUTY's explicit start untouched
  });
});

describe('normalizeCandidateTimeline — rule 2: no end at all', () => {
  it('an ongoing event with a later event closes at that later event\'s start', () => {
    const events = [
      ev('OFF_DUTY', 0, null, { is_ongoing: true }),
      ev('ON_DUTY', 5, 5.5),
    ];
    const { events: out } = normalizeCandidateTimeline(events);
    expect(out[0].end_timestamp).toBe(at(5));
    expect(out[0].is_ongoing).toBe(false);
  });
});

describe('normalizeCandidateTimeline — rule 4/5: explicit facts are never moved; genuine conflicts surface', () => {
  it('two explicit boundaries that conflict are both preserved, with one blocking conflict reported', () => {
    const events = [
      ev('DRIVING', 8, 11.5, { field_provenance: { end_time: 'explicit' } }),
      ev('OFF_DUTY', 11 + 5 / 60, 11.5, { field_provenance: { start_time: 'explicit' } }),
    ];
    const { events: out, conflicts } = normalizeCandidateTimeline(events);
    expect(out[0].end_timestamp).toBe(at(11.5)); // untouched
    expect(out[1].start_timestamp).toBe(at(11 + 5 / 60)); // untouched
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].type).toBe('explicit_boundary_conflict');
    expect(conflicts[0].severity).toBe('blocking');
  });

  it('an existing persisted (closed) record without field_provenance is treated as a stated fact for rule 5', () => {
    const events = [
      { duty_status: 'DRIVING', start_timestamp: at(8), end_timestamp: at(11.5), city: '', state: '' }, // no field_provenance — existing record
      { duty_status: 'OFF_DUTY', start_timestamp: at(11 + 5 / 60), end_timestamp: at(11.5), city: '', state: '' },
    ];
    const { conflicts } = normalizeCandidateTimeline(events);
    expect(conflicts).toHaveLength(1);
  });
});

describe('normalizeCandidateTimeline — rule 6: only the final event may remain ongoing', () => {
  it('a non-last ongoing event is always closed; the truly last one is left open', () => {
    const events = [
      ev('OFF_DUTY', 0, 1),
      ev('ON_DUTY', 1, null, { is_ongoing: true }), // NOT last — must be closed
      ev('DRIVING', 2, null, { is_ongoing: true }), // last — may stay open
    ];
    const { events: out } = normalizeCandidateTimeline(events);
    expect(out[1].end_timestamp).toBe(at(2));
    expect(out[2].end_timestamp).toBeNull();
  });
});

describe('normalizeCandidateTimeline — rule 7: never truncate across more than one later boundary', () => {
  it('an inferred block spanning THREE later explicit events is truncated only to the immediate next one', () => {
    const events = [
      ev('DRIVING', 0, 10, { field_provenance: { end_time: 'inferred' } }), // wildly over-long inferred end
      ev('ON_DUTY', 2, 2.5, { field_provenance: { start_time: 'explicit', end_time: 'explicit' } }),
      ev('OFF_DUTY', 2.5, 3, { field_provenance: { start_time: 'explicit', end_time: 'explicit' } }),
      ev('DRIVING', 3, 4, { field_provenance: { start_time: 'explicit', end_time: 'explicit' } }),
    ];
    const { events: out } = normalizeCandidateTimeline(events);
    expect(out[0].end_timestamp).toBe(at(2)); // truncated to the IMMEDIATE next event only
    expect(out[1].start_timestamp).toBe(at(2)); // untouched
    expect(out[1].end_timestamp).toBe(at(2.5)); // untouched — never pushed further
  });
});

describe('normalizeCandidateTimeline — rule 1: sorts by start regardless of input order', () => {
  it('an out-of-order input array is sorted before normalization', () => {
    const events = [
      ev('DRIVING', 2, 3),
      ev('OFF_DUTY', 0, 2),
    ];
    const { events: out } = normalizeCandidateTimeline(events);
    expect(out[0].duty_status).toBe('OFF_DUTY');
    expect(out[1].duty_status).toBe('DRIVING');
  });
});

describe('normalizeCandidateTimeline — edge cases', () => {
  it('handles an empty/missing input without throwing', () => {
    expect(() => normalizeCandidateTimeline([])).not.toThrow();
    expect(() => normalizeCandidateTimeline(null)).not.toThrow();
    expect(normalizeCandidateTimeline(null).events).toEqual([]);
  });

  it('a single event is left completely untouched', () => {
    const events = [ev('OFF_DUTY', 0, null, { is_ongoing: true })];
    const { events: out, conflicts } = normalizeCandidateTimeline(events);
    expect(out[0].end_timestamp).toBeNull();
    expect(conflicts).toHaveLength(0);
  });

  it('non-overlapping, already-clean events pass through with no changes', () => {
    const events = [ev('OFF_DUTY', 0, 1), ev('ON_DUTY', 1, 1.5), ev('DRIVING', 1.5, null)];
    const { events: out, conflicts } = normalizeCandidateTimeline(events);
    expect(out.map((e) => e.end_timestamp)).toEqual([at(1), at(1.5), null]);
    expect(conflicts).toHaveLength(0);
  });
});
