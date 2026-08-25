import { describe, it, expect } from 'vitest';
import { coalescedSegments } from './timelineDisplay';

const DAY = '2026-08-24';
const base = new Date(`${DAY}T00:00:00-04:00`);
const H = 3600000;
const iso = (h) => new Date(base.getTime() + h * H).toISOString();
const ev = (status, s, e, city, remark = '') => ({
  id: `${s}-${status}-${city}`,
  start_timestamp: iso(s), end_timestamp: iso(e),
  duty_status: status, city, state: 'FL', remark,
  is_ongoing: false, is_current_version: true,
});

describe('coalescedSegments predicate', () => {
  it('keeps distinct On Duty segments apart when city/remark differ (Ocala unloading + Gainesville post-trip)', () => {
    const events = [
      ev('ON_DUTY', 12.05, 12.83, 'Ocala', 'unloading'),
      ev('ON_DUTY', 12.83, 13.08, 'Gainesville', 'post-trip inspection'),
    ];
    const segs = coalescedSegments(events, new Date(iso(20)));
    expect(segs.length).toBe(2);
    expect(segs[0].city).toBe('Ocala');
    expect(segs[1].city).toBe('Gainesville');
  });

  it('merges contiguous same-status same-city same-remark reselection duplicates', () => {
    const events = [
      ev('ON_DUTY', 8, 9, 'Miami', 'fuel'),
      ev('ON_DUTY', 9, 10, 'Miami', 'fuel'),
    ];
    const segs = coalescedSegments(events, new Date(iso(20)));
    expect(segs.length).toBe(1);
    expect(segs[0].city).toBe('Miami');
  });

  it('keeps different statuses separate', () => {
    const events = [
      ev('ON_DUTY', 8, 9, 'Miami', 'fuel'),
      ev('DRIVING', 9, 10, 'Miami', 'drive'),
    ];
    const segs = coalescedSegments(events, new Date(iso(20)));
    expect(segs.length).toBe(2);
  });

  it('does not merge when only the remark differs', () => {
    const events = [
      ev('ON_DUTY', 8, 9, 'Miami', 'fuel'),
      ev('ON_DUTY', 9, 10, 'Miami', 'loading'),
    ];
    const segs = coalescedSegments(events, new Date(iso(20)));
    expect(segs.length).toBe(2);
  });
});