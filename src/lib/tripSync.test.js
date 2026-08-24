import { describe, it, expect, vi } from 'vitest';

vi.mock('@/api/base44Client', () => ({ base44: { entities: {} } }));

import { findTimelineGaps } from './tripSync';

const TZ = 'UTC';
const DAY = '2026-08-20';
const AFTER_DAY = new Date('2026-08-21T12:00:00.000Z');

const event = (start, end, extra = {}) => ({
  start_timestamp: start,
  end_timestamp: end,
  duty_status: 'OFF_DUTY',
  is_ongoing: false,
  ...extra,
});

describe('driver-facing timeline gap classification', () => {
  it('reports a real mid-day gap between two known events', () => {
    const gaps = findTimelineGaps([
      event('2026-08-20T00:00:00.000Z', '2026-08-20T08:00:00.000Z'),
      event('2026-08-20T09:00:00.000Z', '2026-08-21T00:00:00.000Z', { duty_status: 'DRIVING' }),
    ], DAY, TZ, AFTER_DAY);

    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({
      start: new Date('2026-08-20T08:00:00.000Z'),
      end: new Date('2026-08-20T09:00:00.000Z'),
      ms: 60 * 60 * 1000,
    });
  });

  it('reports a trailing gap after an explicitly ended event', () => {
    const gaps = findTimelineGaps([
      event('2026-08-20T00:00:00.000Z', '2026-08-20T18:00:00.000Z'),
    ], DAY, TZ, AFTER_DAY);

    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({
      start: new Date('2026-08-20T18:00:00.000Z'),
      end: new Date('2026-08-21T00:00:00.000Z'),
      ms: 6 * 60 * 60 * 1000,
    });
  });

  it('does not report a gap for an open-ended carry-in from the prior day', () => {
    const gaps = findTimelineGaps([
      event('2026-08-19T20:00:00.000Z', null, { is_ongoing: true }),
    ], DAY, TZ, AFTER_DAY);

    expect(gaps).toEqual([]);
  });

  it('does not classify a completely untouched historical day as a gap', () => {
    expect(findTimelineGaps([], DAY, TZ, AFTER_DAY)).toEqual([]);
  });

  it('does not classify a blank current day as a gap', () => {
    const now = new Date('2026-08-20T10:00:00.000Z');
    expect(findTimelineGaps([], DAY, TZ, now)).toEqual([]);
  });

  it('does not classify a blank future day as a gap', () => {
    const now = new Date('2026-08-19T10:00:00.000Z');
    expect(findTimelineGaps([], DAY, TZ, now)).toEqual([]);
  });
});