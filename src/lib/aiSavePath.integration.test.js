// ============================================================================
// LogbookAI — AI SAVE-PATH INTEGRATION (isolated in-memory test identity).
// ----------------------------------------------------------------------------
// Exercises the REAL downstream pipeline an AI proposal takes once the model
// has answered — normalize -> route enrichment -> validateProposal ->
// timelineWriter (insertEventsBatch / editEvent / deleteEventById) ->
// reload -> graph totals -> HOS -> certification — against a STRICT in-memory
// base44 store (a mocked authenticated test user). No production data is
// touched, and no production auth is weakened. The store REJECTS writes to
// nonexistent records, so a write to a placeholder/fake id fails the test
// exactly the way a real database would.
//
// The AI stage itself is a fixture (the structured proposal the model
// returns); it is NOT a claim about live-LLM behavior.
// ============================================================================
import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = { DutyStatusEvent: [], Certification: [], EventVersion: [] };
let seq = 0;
const matches = (row, q) => Object.entries(q || {}).every(([k, v]) => row[k] === v);

vi.mock('@/api/base44Client', () => ({
  base44: {
    entities: {
      DutyStatusEvent: {
        create: async (d) => { const r = { id: `e${++seq}`, ...d }; store.DutyStatusEvent.push(r); return { ...r }; },
        update: async (id, d) => {
          const r = store.DutyStatusEvent.find((x) => x.id === id);
          if (!r) throw new Error(`404: DutyStatusEvent ${id} does not exist`);
          Object.assign(r, d); return { ...r };
        },
        delete: async (id) => {
          const i = store.DutyStatusEvent.findIndex((x) => x.id === id);
          if (i < 0) throw new Error(`404: DutyStatusEvent ${id} does not exist`);
          store.DutyStatusEvent.splice(i, 1); return { id };
        },
        filter: async (q) => store.DutyStatusEvent.filter((r) => matches(r, q)).map((r) => ({ ...r })),
      },
      Certification: {
        filter: async (q) => store.Certification.filter((r) => matches(r, q)).map((r) => ({ ...r })),
        update: async (id, d) => { const r = store.Certification.find((x) => x.id === id); if (!r) throw new Error('404 cert'); Object.assign(r, d); return { ...r }; },
      },
      EventVersion: { create: async (d) => { const r = { id: `v${++seq}`, ...d }; store.EventVersion.push(r); return r; } },
    },
  },
}));

import { insertEventsBatch, editEvent, deleteEventById } from './timelineWriter';
import { normalizeCandidateTimeline } from './timelineNormalization';
import { enrichProposalMileage, validateProposal, hasBlocking, findOverlaps } from './proposalValidation';
import { resolveEditTargets } from './aiLayer';
import { computeHOS, getDailyGrid } from './hosEngine';

const TZ = 'America/New_York';
const DAY = '2026-09-14';
const CYCLE = '70_8';
const NOW = new Date('2026-09-14T13:00:00-04:00');
const at = (h, m = 0) => new Date(new Date(`${DAY}T00:00:00-04:00`).getTime() + (h * 60 + m) * 60000).toISOString();
const fp = { start_time: 'explicit', end_time: 'explicit', status: 'explicit', city: 'explicit', state: 'explicit' };
const provider = async () => ({ miles: 233, hours: 4.37 }); // Miami -> Orlando, measured with the app's routing stack

// Mirrors LogAssistant.jsx shapeEvent (the exact shape handed to the writer).
const shapeEvent = (p, isLast) => ({
  log_date: p.date || p.start_timestamp.slice(0, 10),
  start_timestamp: p.start_timestamp,
  end_timestamp: p.end_timestamp || (isLast && !p.end_timestamp ? null : p.end_timestamp),
  duty_status: p.duty_status, city: p.city || '', state: p.state || '',
  remark: p.remark || p.activity_type || '', tractor_number: '', trailer_numbers: '',
  method_of_creation: 'Typed AI', is_ongoing: isLast && !p.end_timestamp,
  ...(p.field_provenance ? { field_provenance: p.field_provenance } : {}),
});

const row = (status, s, e, extra = {}) => ({
  log_date: DAY, duty_status: status, start_timestamp: at(...[].concat(s)), end_timestamp: e == null ? null : at(...[].concat(e)),
  city: 'Miami', state: 'FL', remark: '', is_ongoing: e == null, is_current_version: true, ...extra,
});
const seed = (...rows) => rows.map((r) => { const rec = { id: `e${++seq}`, ...r }; store.DutyStatusEvent.push(rec); return { ...rec }; });
const reload = () => store.DutyStatusEvent.map((r) => ({ ...r })).sort((a, b) => new Date(a.start_timestamp) - new Date(b.start_timestamp));
const hrs = (ms) => ms / 3600000;

beforeEach(() => { store.DutyStatusEvent.length = 0; store.Certification.length = 0; store.EventVersion.length = 0; seq = 0; });

describe('full path: AI proposal -> validation -> confirm -> write -> reload -> graph/totals/HOS', () => {
  // Structured proposal exactly as manualLogAssistant would return it (fixture).
  const proposal = () => ([
    { duty_status: 'ON_DUTY', city: 'Miami', state: 'FL', start_timestamp: at(6), end_timestamp: at(6, 15), activity_type: 'Pre-Trip', remark: 'Pre-Trip', field_provenance: fp },
    { duty_status: 'ON_DUTY', city: 'Miami', state: 'FL', start_timestamp: at(6, 15), end_timestamp: at(7), activity_type: 'Loading', remark: 'Loading', field_provenance: fp },
    { duty_status: 'DRIVING', city: 'Miami', state: 'FL', start_timestamp: at(7), end_timestamp: at(11, 30), field_provenance: fp },
    { duty_status: 'ON_DUTY', city: 'Orlando', state: 'FL', start_timestamp: at(11, 30), end_timestamp: at(12, 30), activity_type: 'Unloading', remark: 'Unloading', field_provenance: fp },
    { duty_status: 'OFF_DUTY', city: 'Orlando', state: 'FL', start_timestamp: at(12, 30), end_timestamp: null, field_provenance: fp },
  ]);

  it('persists EXACTLY what the driver reviewed, with correct graph totals and calculable HOS', async () => {
    // Existing: verified 10h+ rest before the day (30h off duty), open until 06:00.
    const prior = seed(
      { ...row('OFF_DUTY', 0, 6), log_date: '2026-09-13', start_timestamp: '2026-09-13T00:00:00-04:00', end_timestamp: at(6), city: 'Miami' },
    );
    let events = reload();

    // 1. self-normalize + route enrichment (real code, injected routing provider)
    const { events: selfNorm } = normalizeCandidateTimeline(proposal());
    const enriched = await enrichProposalMileage(selfNorm, { routingProvider: provider, now: NOW, narrative: 'x' });
    // 2. the review-screen validation
    const v = validateProposal(events, enriched.events, { cycleType: CYCLE, tz: TZ, now: NOW, narrative: 'loaded in Miami, drove to Orlando, unloaded, went off duty' });
    expect(hasBlocking(v.warnings), JSON.stringify(v.warnings.map((w) => w.type))).toBe(false);
    expect(v.violations).toEqual([]);

    // 3. confirm -> canonical writer
    const reviewed = enriched.events;
    const res = await insertEventsBatch(events, reviewed.map((p, i) => shapeEvent(p, i === reviewed.length - 1)), { carrierName: 'Test Carrier' });
    expect(res.error).toBeUndefined();

    // 4. reload from the store and compare with the reviewed proposal
    const persisted = reload().filter((r) => r.log_date === DAY);
    expect(persisted.map((r) => [r.duty_status, r.start_timestamp, r.end_timestamp, r.city, r.state])).toEqual(
      reviewed.map((p) => [p.duty_status, p.start_timestamp, p.end_timestamp || null, p.city, p.state]),
    );
    expect(persisted[persisted.length - 1].is_ongoing).toBe(true);
    expect(store.DutyStatusEvent.length).toBe(prior.length + reviewed.length); // nothing duplicated or lost

    // 5. no overlaps / gaps in the saved timeline
    expect(findOverlaps(reload(), NOW)).toEqual([]);

    // 6. graph totals (hours per status for the day, evaluated at NOW=13:00)
    const grid = getDailyGrid(reload(), DAY, TZ, NOW);
    expect(grid.totals.ON_DUTY).toBeCloseTo(2.0, 2);          // 0:15 pre-trip + 0:45 loading + 1:00 unloading
    expect(grid.totals.DRIVING).toBeCloseTo(4.5, 2);
    expect(grid.totals.OFF_DUTY).toBeCloseTo(6.5, 2);         // 00:00-06:00 + 12:30-13:00

    // 7. HOS clocks from the persisted timeline
    const hos = computeHOS(reload(), CYCLE, TZ, NOW, { historyComplete: true });
    expect(hos.calculable).toBe(true);
    expect(hrs(hos.driving.drivingRemainingMs)).toBeCloseTo(6.5, 1); // 11h - 4.5h driven
  });

  it('a write against a nonexistent record fails loudly (the strict store would have caught the __new_0 bug)', async () => {
    await expect(insertEventsBatch([], [
      shapeEvent({ duty_status: 'DRIVING', start_timestamp: at(3), end_timestamp: at(5), city: 'Miami', state: 'FL' }, false),
      shapeEvent({ duty_status: 'ON_DUTY', start_timestamp: at(4), end_timestamp: at(5), city: 'Miami', state: 'FL' }, true),
    ], {})).resolves.toBeTruthy(); // completes without touching a fake id
    const saved = reload();
    const drive = saved.find((r) => r.duty_status === 'DRIVING');
    expect(drive.end_timestamp).toBe(at(4));                 // truncated, not persisted overlapping
    expect(findOverlaps(saved, NOW)).toEqual([]);
  });
});

describe('certification on an AI edit / apply', () => {
  const certify = () => store.Certification.push({ id: 'cert1', log_date: DAY, is_superseded: false });
  const day = () => seed(
    row('OFF_DUTY', 0, 6), row('ON_DUTY', 6, [6, 15], { remark: 'Pre-Trip' }), row('DRIVING', [6, 15], [11, 30]), row('ON_DUTY', [11, 30], [12, 30], { city: 'Orlando', remark: 'Unloading' }),
  );

  it('an AI CORRECTION on a certified day supersedes the certification and versions the edited events', async () => {
    certify();
    const events = day();
    const driving = events.find((e) => e.duty_status === 'DRIVING');
    const before = { ...driving };
    const res = await editEvent(events, driving.id, { ...shapeEvent({ ...driving, end_timestamp: at(11, 45) }, false), field_provenance: fp }, { editedBy: 'Test Driver', reason: 'AI Correction' });
    expect(res.error).toBeUndefined();
    expect(store.Certification[0].is_superseded).toBe(true);
    const v = store.EventVersion.find((x) => x.original_event_id === driving.id);
    expect(v).toBeTruthy();
    expect(v.action).toBe('edited');
    expect(v.snapshot.end_timestamp).toBe(before.end_timestamp); // the PRE-edit value is preserved
    expect(v.edit_reason).toBe('AI Correction');
  });

  it('an AI APPLY (insert) on a certified day supersedes the certification', async () => {
    certify();
    const events = day();
    await insertEventsBatch(events, [shapeEvent({ duty_status: 'OFF_DUTY', start_timestamp: at(12, 30), end_timestamp: null, city: 'Orlando', state: 'FL' }, true)], { reason: 'AI Apply' });
    expect(store.Certification[0].is_superseded).toBe(true);
  });

  it('an AI DELETE on a certified day versions the deleted event and supersedes the certification', async () => {
    certify();
    const events = day();
    const unload = events.find((e) => e.remark === 'Unloading');
    await deleteEventById(events, unload.id, { editedBy: 'Test Driver', reason: 'AI Delete' });
    expect(store.Certification[0].is_superseded).toBe(true);
    expect(store.EventVersion.some((x) => x.original_event_id === unload.id && x.action === 'deleted')).toBe(true);
  });

  it('an edit on an UNcertified day creates no versions and touches no certification', async () => {
    const events = day();
    const driving = events.find((e) => e.duty_status === 'DRIVING');
    await editEvent(events, driving.id, shapeEvent({ ...driving, end_timestamp: at(11, 45) }, false), {});
    expect(store.EventVersion).toHaveLength(0);
  });
});

describe('AI corrections and deletes touch only the intended event', () => {
  const build = () => seed(
    row('OFF_DUTY', 0, 6),
    row('ON_DUTY', 6, 7, { remark: 'Loading' }),
    row('DRIVING', 7, [11, 30]),
    row('ON_DUTY', [11, 30], 12, { city: 'Ocala', remark: 'Fuel' }),
    row('DRIVING', 12, 15, { city: 'Ocala' }),
    row('ON_DUTY', 15, 16, { city: 'Orlando', remark: 'Unloading' }),
  );
  const snap = (rows) => JSON.stringify(rows.map((r) => [r.id, r.duty_status, r.start_timestamp, r.end_timestamp, r.remark]));
  const idxOf = (events, pred) => events.findIndex(pred);

  it('"change that load time to 7:30": only the load and the abutting drive change; count unchanged; no overlap', async () => {
    const events = build();
    const loadIdx = idxOf(events, (e) => e.remark === 'Loading');
    const { resolvedEdits } = resolveEditTargets(events, { intent: 'edit_events', proposed_events: [{ edit_target_index: loadIdx }] });
    expect(resolvedEdits).toHaveLength(1);
    const target = resolvedEdits[0].target;
    await editEvent(events, target.id, { ...shapeEvent({ ...target, end_timestamp: at(7, 30) }, false), field_provenance: fp }, {});
    const after = reload();
    expect(after).toHaveLength(events.length);
    expect(after.find((e) => e.remark === 'Loading').end_timestamp).toBe(at(7, 30));
    const untouched = (r) => !['Loading'].includes(r.remark) && !(r.duty_status === 'DRIVING' && r.start_timestamp <= at(7, 30) && r.end_timestamp <= at(11, 30));
    expect(snap(after.filter(untouched).filter((r) => r.remark === 'Fuel' || r.remark === 'Unloading' || r.duty_status === 'OFF_DUTY'))).toBe(
      snap(events.filter(untouched).filter((r) => r.remark === 'Fuel' || r.remark === 'Unloading' || r.duty_status === 'OFF_DUTY')));
    expect(findOverlaps(after, NOW)).toEqual([]);
  });

  it('"I wasn\'t driving then, I was on duty": one event changes status, count and neighbors unchanged', async () => {
    const events = build();
    const drive = events.find((e) => e.duty_status === 'DRIVING' && e.start_timestamp === at(7));
    const idx = idxOf(events, (e) => e.id === drive.id);
    const { resolvedEdits } = resolveEditTargets(events, { intent: 'edit_events', proposed_events: [{ edit_target_index: idx }] });
    await editEvent(events, resolvedEdits[0].target.id, shapeEvent({ ...drive, duty_status: 'ON_DUTY' }, false), {});
    const after = reload();
    expect(after).toHaveLength(events.length);
    expect(after.find((e) => e.id === drive.id).duty_status).toBe('ON_DUTY');
    expect(after.filter((e) => e.duty_status === 'DRIVING')).toHaveLength(1); // the OTHER drive is untouched
    expect(findOverlaps(after, NOW)).toEqual([]);
  });

  it('"delete that fuel stop": exactly that record is removed; neighbors are NOT deleted or resized, and the resulting unlogged interval is surfaced (HOS unavailable), not silently filled', async () => {
    const events = build();
    const fuel = events.find((e) => e.remark === 'Fuel');
    const { resolvedDeletes } = resolveEditTargets(events, { intent: 'delete_events', delete_target_indices: [events.findIndex((e) => e.id === fuel.id)] });
    expect(resolvedDeletes).toHaveLength(1);
    await deleteEventById(events, fuel.id, {});
    const after = reload();
    expect(after).toHaveLength(events.length - 1);
    expect(after.some((e) => e.id === fuel.id)).toBe(false);
    for (const e of events.filter((x) => x.id !== fuel.id)) {
      const still = after.find((r) => r.id === e.id);
      expect(still.start_timestamp).toBe(e.start_timestamp);
      expect(still.end_timestamp).toBe(e.end_timestamp);
    }
    const hos = computeHOS(after, CYCLE, TZ, NOW, { historyComplete: true });
    expect(hos.calculable).toBe(false); // canonical rule: an unlogged interval is a gap, never silently assigned
  });

  it('an unresolved reference (index -1 or out of range) never becomes a new inserted event', () => {
    const events = build();
    for (const bad of [-1, 99, null, undefined]) {
      const r = resolveEditTargets(events, { intent: 'edit_events', proposed_events: [{ edit_target_index: bad }] });
      expect(r.resolvedEdits).toHaveLength(0);
      expect(r.unresolvedEdits).toHaveLength(1);
    }
    const d = resolveEditTargets(events, { intent: 'delete_events', delete_target_indices: [-1, 42] });
    expect(d.resolvedDeletes).toHaveLength(0);
  });

  it('"move my sleeper time to 10 PM" that would leave an unlogged gap is flagged BLOCKING at review, not saved silently', () => {
    const events = seed(row('OFF_DUTY', 0, 6), row('ON_DUTY', 6, 20, { remark: 'Work' }), row('SLEEPER_BERTH', 20, null));
    const sleeper = events.find((e) => e.duty_status === 'SLEEPER_BERTH');
    const edited = { ...sleeper, start_timestamp: at(22), field_provenance: fp };
    const withoutTarget = events.filter((e) => e.id !== sleeper.id);
    const v = validateProposal(withoutTarget, [edited], { cycleType: CYCLE, tz: TZ, now: new Date('2026-09-14T23:00:00-04:00'), narrative: 'move my sleeper time to 10 PM' });
    expect(hasBlocking(v.warnings)).toBe(true);
    expect(v.warnings.some((w) => w.type === 'elapsed_gap' || w.title === 'TIMELINE STRUCTURE')).toBe(true);
  });
});
