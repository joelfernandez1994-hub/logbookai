// ============================================================================
// Idempotency regression tests for applyTimelineOps / insertEventsBatch.
// ----------------------------------------------------------------------------
// These tests prove the DB-side existing-row re-check + button lock make
// normal retries, double-clicks, and stale-snapshot replays idempotent: one
// proposed event → one DutyStatusEvent row, and zero duplicate
// (start_timestamp, duty_status) pairs.
//
// IMPORTANT: this does NOT fake an atomic concurrency guarantee. Base44
// entities expose no unique constraint / idempotency token, so two truly
// simultaneous independent writers could still create a duplicate pair. The
// re-check + in-flight guard protect a single Apply flow (retries, double-
// clicks, stale snapshots); cross-flow concurrency is out of scope.
// ============================================================================
import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = [];
let nextId = 1;
const calls = { create: [], update: [], delete: [] };

vi.mock('@/api/base44Client', () => ({
  base44: {
    entities: {
      DutyStatusEvent: {
        create: vi.fn(async (data) => { const rec = { id: `ev${nextId++}`, ...data }; store.push(rec); calls.create.push(rec); return rec; }),
        update: vi.fn(async (id, data) => { const i = store.findIndex(r => r.id === id); if (i >= 0) Object.assign(store[i], data); calls.update.push({ id, data }); return { id, ...data }; }),
        delete: vi.fn(async (id) => { const i = store.findIndex(r => r.id === id); if (i >= 0) store.splice(i, 1); calls.delete.push(id); return { id }; }),
        filter: vi.fn(async ({ log_date }) => store.filter(r => r.log_date === log_date)),
      },
      Certification: { filter: vi.fn(async () => []), update: vi.fn(async () => ({})) },
      EventVersion: { create: vi.fn(async (data) => ({ id: `v${nextId++}`, ...data })) },
    },
  },
}));

import { insertEventsBatch, replaceRangeEvents } from './timelineWriter';

const DAY = '2026-08-20';
const TZ = 'America/New_York';
function iso(h, date = DAY) {
  const b = new Date(`${date}T00:00:00-04:00`);
  return new Date(b.getTime() + h * 3600000).toISOString();
}

beforeEach(() => {
  store.length = 0; calls.create.length = 0; calls.update.length = 0; calls.delete.length = 0; nextId = 1;
});

describe('insertEventsBatch idempotency', () => {
  it('a replayed Apply with a stale events snapshot creates no duplicate rows', async () => {
    const existing = [{ id: 'a', log_date: DAY, start_timestamp: iso(0), end_timestamp: iso(24), duty_status: 'OFF_DUTY', city: 'Miami', state: 'FL', is_ongoing: false, is_current_version: true }];
    const proposed = [{ log_date: DAY, start_timestamp: iso(8), end_timestamp: iso(10), duty_status: 'DRIVING', city: 'Miami', state: 'FL' }];
    await insertEventsBatch(existing, proposed, { carrierName: 'C' });
    // Replay with the SAME stale snapshot (does not include the first apply's creates).
    await insertEventsBatch(existing, proposed, { carrierName: 'C' });
    const drives = store.filter(r => r.duty_status === 'DRIVING');
    expect(drives.length).toBe(1);
    const keys = new Set(store.map(r => `${new Date(r.start_timestamp).getTime()}|${r.duty_status}`));
    expect(keys.size).toBe(store.length);
  });

  it('within-batch duplicate proposed events create a single row', async () => {
    const proposed = [
      { log_date: DAY, start_timestamp: iso(8), end_timestamp: iso(10), duty_status: 'DRIVING', city: 'Miami', state: 'FL' },
      { log_date: DAY, start_timestamp: iso(8), end_timestamp: iso(10), duty_status: 'DRIVING', city: 'Miami', state: 'FL' },
    ];
    await insertEventsBatch([], proposed, { carrierName: 'C' });
    expect(store.filter(r => r.duty_status === 'DRIVING').length).toBe(1);
  });
});

describe('replaceRangeEvents idempotency', () => {
  it('a replacement reusing a deleted event slot is not falsely blocked as a duplicate', async () => {
    store.push({ id: 'x', log_date: DAY, start_timestamp: iso(8), end_timestamp: iso(10), duty_status: 'DRIVING', city: 'Miami', state: 'FL', is_current_version: true });
    const existing = [...store];
    const dayStart = new Date(`${DAY}T00:00:00-04:00`);
    const dayEnd = new Date(dayStart.getTime() + 24 * 3600000);
    await replaceRangeEvents(existing, dayStart, dayEnd, [
      { log_date: DAY, start_timestamp: iso(8), end_timestamp: iso(9), duty_status: 'DRIVING', city: 'Miami', state: 'FL' },
    ], { carrierName: 'C' });
    expect(calls.delete).toContain('x');
    const replacement = store.filter(r => r.duty_status === 'DRIVING' && new Date(r.start_timestamp).getTime() === new Date(iso(8)).getTime());
    expect(replacement.length).toBe(1);
  });
});