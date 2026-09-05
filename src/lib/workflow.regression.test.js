// ============================================================================
// LogbookAI — End-to-end driver-workflow regression tests (vitest).
// Exercises the EXACT same library functions the UI calls (Today.jsx's quick
// status/BOL/DVIR handlers, Logs.jsx's manual edit handler) against a mocked
// base44 client that behaves like a real (if simplified) database: writes
// actually persist and are visible to later reads/filters in the same test.
// This is the closest a unit test can get to the real driver workflow
// without a component-rendering harness (this project has none — vitest
// runs in a plain node environment, and importing a page component pulls in
// UI code that touches `window` at import time).
// ============================================================================
import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mock base44 client: a tiny in-memory "database" so create/update/filter
// behave like the real backend would (unlike timelineWriter.test.js's mock,
// which only records calls) — needed here because changeStatus() re-reads
// "is_ongoing" records from the DB, and DVIR history needs real persistence. ---
let dseStore = new Map();
let dvirStore = new Map();
let certStore = new Map();
const calls = { create: [], update: [], delete: [], dvirCreate: [], dvirUpdate: [] };
let nextId = 1;

vi.mock('@/api/base44Client', () => ({
  base44: {
    entities: {
      DutyStatusEvent: {
        create: vi.fn(async (data) => {
          const id = `ev${nextId++}`;
          const rec = { id, is_ongoing: false, is_current_version: true, ...data };
          dseStore.set(id, rec);
          calls.create.push(rec);
          return rec;
        }),
        update: vi.fn(async (id, data) => {
          const rec = { ...dseStore.get(id), ...data };
          dseStore.set(id, rec);
          calls.update.push({ id, data });
          return rec;
        }),
        delete: vi.fn(async (id) => { dseStore.delete(id); calls.delete.push(id); return { id }; }),
        filter: vi.fn(async (query = {}) => {
          return [...dseStore.values()].filter((r) => Object.entries(query).every(([k, v]) => r[k] === v));
        }),
      },
      Certification: {
        filter: vi.fn(async ({ log_date }) => [...certStore.values()].filter((c) => c.log_date === log_date)),
        update: vi.fn(async (id, data) => { certStore.set(id, { ...certStore.get(id), ...data }); return certStore.get(id); }),
      },
      EventVersion: { create: vi.fn(async () => ({})) },
      DVIR: {
        create: vi.fn(async (data) => {
          const id = `dvir${nextId++}`;
          const rec = { id, ...data };
          dvirStore.set(id, rec);
          calls.dvirCreate.push(rec);
          return rec;
        }),
        update: vi.fn(async (id, data) => {
          const rec = { ...dvirStore.get(id), ...data };
          dvirStore.set(id, rec);
          calls.dvirUpdate.push({ id, data });
          return rec;
        }),
        delete: vi.fn(async (id) => { dvirStore.delete(id); return { id }; }),
        list: vi.fn(async () => [...dvirStore.values()].sort((a, b) => (a.log_date < b.log_date ? 1 : -1))),
      },
    },
  },
}));

import { changeStatus, updateEventFields, editEvent } from './timelineWriter';
import { validateTimeline, normalizedSegments } from './timelineEngine';
import { computeHOS } from './hosEngine';
import { saveDvir, getDvirs } from './dvirData';

const reload = () => [...dseStore.values()];

beforeEach(() => {
  dseStore = new Map();
  dvirStore = new Map();
  certStore = new Map();
  Object.keys(calls).forEach((k) => (calls[k].length = 0));
  nextId = 1;
});

describe('Quick status (Today.jsx 2x2 selector → handleChangeStatus → changeStatus)', () => {
  it('runs the full OFF_DUTY → ON_DUTY → DRIVING → re-tap DRIVING → ON_DUTY sequence correctly', async () => {
    const T0 = '2026-08-20T00:00:00.000Z'; // midnight — full current-day coverage from dayStart
    const T1 = '2026-08-20T07:00:00.000Z';
    const T2 = '2026-08-20T07:30:00.000Z';
    const T2b = '2026-08-20T09:00:00.000Z'; // re-tapping DRIVING later
    const T3 = '2026-08-20T10:00:00.000Z';

    // 1. Start OFF_DUTY.
    await changeStatus('OFF_DUTY', { start_timestamp: T0, city: 'Miami', state: 'FL' }, reload());
    let events = reload();
    expect(events).toHaveLength(1);
    const offDuty = events[0];
    expect(offDuty.duty_status).toBe('OFF_DUTY');
    expect(offDuty.is_ongoing).toBe(true);
    expect(offDuty.end_timestamp).toBeNull();

    // 2. Tap ON_DUTY.
    await changeStatus('ON_DUTY', { start_timestamp: T1, city: 'Miami', state: 'FL' }, events);
    events = reload();
    expect(events).toHaveLength(2);
    // 3. Confirm OFF_DUTY closes exactly when ON_DUTY begins.
    const offDutyClosed = events.find((e) => e.id === offDuty.id);
    expect(offDutyClosed.end_timestamp).toBe(T1);
    expect(offDutyClosed.is_ongoing).toBe(false);
    const onDuty = events.find((e) => e.duty_status === 'ON_DUTY');
    expect(onDuty.is_ongoing).toBe(true);
    expect(onDuty.start_timestamp).toBe(T1);

    // 4. Tap DRIVING.
    await changeStatus('DRIVING', { start_timestamp: T2, city: 'Miami', state: 'FL' }, events);
    events = reload();
    const onDutyClosed = events.find((e) => e.id === onDuty.id);
    expect(onDutyClosed.end_timestamp).toBe(T2);
    const driving = events.find((e) => e.duty_status === 'DRIVING');
    expect(driving.is_ongoing).toBe(true);
    expect(driving.end_timestamp).toBeNull();

    // 5. Advance evalNow and confirm DRIVING remains open/current WITHOUT another DB write.
    const createsBeforeAdvance = calls.create.length;
    const updatesBeforeAdvance = calls.update.length;
    const laterNow = new Date(new Date(T2).getTime() + 3 * 3600000); // +3h
    const hos = computeHOS(events, '70_8', 'UTC', laterNow, { historyComplete: true });
    expect(hos.calculable).toBe(true);
    expect(hos.currentStatus.id).toBe(driving.id);
    expect(hos.currentStatus.duty_status).toBe('DRIVING');
    expect(calls.create.length).toBe(createsBeforeAdvance); // no new DB write just from time passing
    expect(calls.update.length).toBe(updatesBeforeAdvance);

    // 6. Tap DRIVING again and confirm no duplicate/new event is created.
    const createsBeforeRetap = calls.create.length;
    await changeStatus('DRIVING', { start_timestamp: T2b, city: 'Miami', state: 'FL' }, events);
    expect(calls.create.length).toBe(createsBeforeRetap); // no new create
    events = reload();
    expect(events.filter((e) => e.duty_status === 'DRIVING')).toHaveLength(1);
    const stillDriving = events.find((e) => e.duty_status === 'DRIVING');
    expect(stillDriving.id).toBe(driving.id);
    expect(stillDriving.start_timestamp).toBe(T2); // NOT shifted to T2b

    // 7. Tap ON_DUTY and confirm DRIVING closes at that timestamp and ON_DUTY becomes open.
    await changeStatus('ON_DUTY', { start_timestamp: T3, city: 'Orlando', state: 'FL' }, events);
    events = reload();
    const drivingClosed = events.find((e) => e.id === driving.id);
    expect(drivingClosed.end_timestamp).toBe(T3);
    expect(drivingClosed.is_ongoing).toBe(false);
    const finalOnDuty = events.find((e) => e.duty_status === 'ON_DUTY' && e.is_ongoing);
    expect(finalOnDuty.start_timestamp).toBe(T3);
    expect(finalOnDuty.city).toBe('Orlando');

    // Whole-day sanity: the resulting timeline is continuous through "now".
    const finalNow = new Date(new Date(T3).getTime() + 60000);
    const v = validateTimeline(events, { now: finalNow, dateStr: '2026-08-20', timezone: 'UTC' });
    expect(v.valid).toBe(true);
  });
});

describe('BOL metadata (Today.jsx BOL field → updateEventFields)', () => {
  it('patches the same event id in place across repeated edits, never creating a new event', async () => {
    await changeStatus('DRIVING', { start_timestamp: '2026-08-20T06:00:00.000Z' }, []);
    let events = reload();
    const openId = events[0].id;
    const createsBefore = calls.create.length;

    // 1 & 2. Add a BOL number while an event is open; confirm the id is preserved.
    await updateEventFields(events, openId, { bill_of_lading_number: 'BOL-4471' }, {});
    events = reload();
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe(openId);
    expect(events[0].bill_of_lading_number).toBe('BOL-4471');
    // 3. Confirm no new DutyStatusEvent is created.
    expect(calls.create.length).toBe(createsBefore);

    // 4. Edit the BOL again and confirm the same behavior.
    await updateEventFields(events, openId, { bill_of_lading_number: 'BOL-9900' }, {});
    events = reload();
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe(openId);
    expect(events[0].bill_of_lading_number).toBe('BOL-9900');
    expect(calls.create.length).toBe(createsBefore);
    // The event's own duty-status timing was never touched by either edit.
    expect(events[0].start_timestamp).toBe('2026-08-20T06:00:00.000Z');
    expect(events[0].is_ongoing).toBe(true);
  });
});

describe('DVIR (Today.jsx Daily DVIR card → saveDvir/getDvirs)', () => {
  it('completes today’s DVIR, it appears immediately, editing it does not duplicate, and history stays intact', async () => {
    const today = new Date().toISOString().slice(0, 10);

    // 1. Complete today's DVIR from Today.
    const created = await saveDvir({ log_date: today, tractor_number: 'T-100', inspection_result: 'no_defects', driver_signature_name: 'Joel' });
    expect(calls.dvirCreate).toHaveLength(1);

    // 2. Confirm it appears as completed immediately.
    let todays = (await getDvirs(9)).filter((d) => d.log_date === today);
    expect(todays).toHaveLength(1);
    expect(todays[0].inspection_result).toBe('no_defects');

    // 3. Reopen/view it (edit) without creating an unintended duplicate.
    await saveDvir({ ...created, id: created.id, repair_notes: 'reviewed, no issues' });
    expect(calls.dvirCreate).toHaveLength(1); // still just one create
    expect(calls.dvirUpdate).toHaveLength(1); // the edit went through update
    todays = (await getDvirs(9)).filter((d) => d.log_date === today);
    expect(todays).toHaveLength(1); // no duplicate record

    // 4. Confirm historical DVIRs remain accessible in the existing history area.
    const oldDate = new Date(Date.now() - 60 * 24 * 3600000).toISOString().slice(0, 10); // 60 days ago
    await saveDvir({ log_date: oldDate, tractor_number: 'T-100', inspection_result: 'no_defects', driver_signature_name: 'Joel' });
    // getDvirs(9) — Today's own "recent" window — correctly excludes the old one...
    const recent = await getDvirs(9);
    expect(recent.some((d) => d.log_date === oldDate)).toBe(false);
    // ...but VehicleInspection.jsx's history view uses a wider window (30) and
    // must still find it — nothing was lost, it's just outside Today's slice.
    const history = await getDvirs(90);
    expect(history.some((d) => d.log_date === oldDate)).toBe(true);
    expect(history.some((d) => d.log_date === today)).toBe(true);
  });
});

describe('Manual Edit Log (Logs.jsx saveEvent → editEvent)', () => {
  const DAY = '2026-08-20';
  const NOW = new Date('2026-08-20T12:00:00Z');

  function seedDay() {
    dseStore = new Map([
      ['a', { id: 'a', log_date: DAY, start_timestamp: '2026-08-20T00:00:00.000Z', end_timestamp: '2026-08-20T06:00:00.000Z', duty_status: 'OFF_DUTY', city: 'Miami', state: 'FL', remark: '', is_ongoing: false, is_current_version: true }],
      ['b', { id: 'b', log_date: DAY, start_timestamp: '2026-08-20T06:00:00.000Z', end_timestamp: '2026-08-20T12:00:00.000Z', duty_status: 'DRIVING', city: 'Miami', state: 'FL', remark: '', is_ongoing: true, is_current_version: true }],
    ]);
  }

  function assertContinuous(events) {
    const v = validateTimeline(events, { now: NOW, dateStr: DAY, timezone: 'UTC' });
    expect(v.valid).toBe(true);
    expect(v.hasElapsedGap).toBe(false);
    expect(v.hasDuplicateCoverage).toBe(false);
    return v;
  }

  it('1. edits city/state on an existing event with no duplicate or gap', async () => {
    seedDay();
    const events = reload();
    const b = events.find((e) => e.id === 'b');
    const res = await editEvent(events, 'b', { ...b, city: 'Orlando', state: 'FL' }, {});
    expect(res.ops.creates).toHaveLength(0);
    const after = reload();
    expect(after.find((e) => e.id === 'b').city).toBe('Orlando');
    assertContinuous(after);
  });

  it('2. edits a remark with no duplicate or gap', async () => {
    seedDay();
    const events = reload();
    const b = events.find((e) => e.id === 'b');
    const res = await editEvent(events, 'b', { ...b, remark: 'Heavy traffic on I-95' }, {});
    expect(res.ops.creates).toHaveLength(0);
    const after = reload();
    expect(after.find((e) => e.id === 'b').remark).toBe('Heavy traffic on I-95');
    assertContinuous(after);
  });

  it('3. edits start/end time and the neighbor is truncated to keep the day continuous (no gap, no overlap)', async () => {
    seedDay();
    const events = reload();
    const a = events.find((e) => e.id === 'a');
    // Extend OFF_DUTY's end from 6:00 to 6:15 — the neighbor (DRIVING 'b',
    // still ongoing) must be truncated to start at 6:15 so no gap/overlap appears.
    const res = await editEvent(events, 'a', { ...a, end_timestamp: '2026-08-20T06:15:00.000Z' }, {});
    expect(res.ops.creates).toHaveLength(0); // pure truncation, no split needed here
    const after = reload();
    expect(after.find((e) => e.id === 'a').end_timestamp).toBe('2026-08-20T06:15:00.000Z');
    expect(after.find((e) => e.id === 'b').start_timestamp).toBe('2026-08-20T06:15:00.000Z');
    assertContinuous(after);
  });
});
