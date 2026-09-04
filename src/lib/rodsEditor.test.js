import { describe, it, expect } from 'vitest';
import {
  snapHour, formatHour, formatH24, daySegments, planDayInsertion, planEdit,
  applyOps, buildAfterEvents, validateTimeline,
} from './rodsEditor';

const DAY = new Date('2026-08-19T00:00:00Z').getTime();
const iso = (ms) => new Date(ms).toISOString();
const ev = (status, startH, endH, extra = {}) => ({
  id: extra.id || `${status}-${startH}`,
  start_timestamp: iso(DAY + startH * 3600000),
  end_timestamp: iso(DAY + endH * 3600000),
  duty_status: status,
  city: extra.city || 'Miami', state: extra.state || 'FL',
  remark: extra.remark || '', ...extra,
});

describe('rodsEditor helpers', () => {
  it('snapHour rounds to nearest minute', () => {
    expect(snapHour(5.503, 1)).toBeCloseTo(5.5, 5);
    expect(snapHour(5.517, 1)).toBeCloseTo(5.5167, 3);
  });

  it('formatHour 12h', () => {
    expect(formatHour(0)).toBe('12:00 AM');
    expect(formatHour(5.5)).toBe('5:30 AM');
    expect(formatHour(12)).toBe('12:00 PM');
    expect(formatHour(13.25)).toBe('1:15 PM');
    expect(formatHour(24)).toBe('12:00 AM');
  });

  it('formatH24', () => {
    expect(formatH24(5.5)).toBe('05:30');
    expect(formatH24(13.25)).toBe('13:15');
  });
});

describe('planDayInsertion — split logic', () => {
  it('insert into empty day creates one event', () => {
    const ops = planDayInsertion([], ev('ON_DUTY', 5.5, 6));
    expect(ops.creates).toHaveLength(1);
    expect(ops.updates).toHaveLength(0);
    expect(ops.deletes).toHaveLength(0);
  });

  it('insert fully inside a block splits it into three', () => {
    // existing driving 6:00 -> 12:00
    const drive = ev('DRIVING', 6, 12);
    const ops = planDayInsertion([drive], ev('ON_DUTY', 8.5, 9, { id: 'fuel' }));
    // driving truncated to [6,8.5], remainder [9,12] created, fuel created
    expect(ops.updates).toHaveLength(1);
    expect(ops.updates[0].id).toBe('DRIVING-6');
    expect(new Date(ops.updates[0].data.end_timestamp).getTime()).toBe(DAY + 8.5 * 3600000);
    expect(ops.creates).toHaveLength(2);
    const remainder = ops.creates.find((c) => c.duty_status === 'DRIVING');
    expect(remainder).toBeTruthy();
    expect(new Date(remainder.start_timestamp).getTime()).toBe(DAY + 9 * 3600000);
    expect(new Date(remainder.end_timestamp).getTime()).toBe(DAY + 12 * 3600000);
    const fuel = ops.creates.find((c) => c.id === 'fuel');
    expect(fuel.duty_status).toBe('ON_DUTY');
  });

  it('fully covered existing event is deleted', () => {
    const a = ev('ON_DUTY', 7, 8);
    const ops = planDayInsertion([a], ev('DRIVING', 6, 10, { id: 'drive' }));
    expect(ops.deletes).toContain('ON_DUTY-7');
  });

  it('overlap at start truncates existing end', () => {
    const a = ev('OFF_DUTY', 0, 6);
    const ops = planDayInsertion([a], ev('DRIVING', 5.5, 6.5, { id: 'd' }));
    expect(ops.updates).toHaveLength(1);
    expect(new Date(ops.updates[0].data.end_timestamp).getTime()).toBe(DAY + 5.5 * 3600000);
  });

  it('overlap at end truncates existing start', () => {
    const a = ev('OFF_DUTY', 0, 6);
    const ops = planDayInsertion([a], ev('DRIVING', 5, 7, { id: 'd' }));
    // a covers [0,6], drive [5,7] -> a truncated to [0,5]
    expect(new Date(ops.updates[0].data.end_timestamp).getTime()).toBe(DAY + 5 * 3600000);
  });

  it('applyOps yields a continuous non-overlapping timeline', () => {
    const drive = ev('DRIVING', 6, 12);
    const ops = planDayInsertion([drive], ev('ON_DUTY', 8.5, 9, { id: 'fuel' }));
    const result = applyOps([drive], ops).map((e) => [e.duty_status, (new Date(e.start_timestamp).getTime() - DAY) / 3600000, (new Date(e.end_timestamp).getTime() - DAY) / 3600000]);
    expect(result).toEqual([
      ['DRIVING', 6, 8.5],
      ['ON_DUTY', 8.5, 9],
      ['DRIVING', 9, 12],
    ]);
    // no overlaps
    for (let i = 1; i < result.length; i++) expect(result[i][1]).toBe(result[i - 1][2]);
  });
});

describe('planEdit', () => {
  it('edits an existing event in place and splits neighbors', () => {
    const drive = ev('DRIVING', 6, 12);
    const on = ev('ON_DUTY', 12, 13);
    const ops = planEdit([drive, on], 'DRIVING-6', {
      ...ev('DRIVING', 6, 10, { id: 'DRIVING-6' }),
    });
    // target updated, on-duty unaffected
    const upd = ops.updates.find((u) => u.id === 'DRIVING-6');
    expect(new Date(upd.data.end_timestamp).getTime()).toBe(DAY + 10 * 3600000);
  });

  it('does NOT create a duplicate event when only metadata changes on an otherwise-unchanged event', () => {
    // Regression: planEdit used to delegate wholesale to planDayInsertion,
    // which always self-inserts the edited event as a brand-new "create" in
    // addition to the update — so adding a city/state to an existing status
    // spawned a second, duplicate record instead of just updating the original.
    const drive = ev('DRIVING', 6, 12);
    const ops = planEdit([drive], 'DRIVING-6', {
      ...ev('DRIVING', 6, 12, { id: 'DRIVING-6', city: 'Chicago', state: 'IL', remark: 'BOL #4471' }),
    });
    expect(ops.creates).toHaveLength(0);
    expect(ops.deletes).toHaveLength(0);
    const upd = ops.updates.find((u) => u.id === 'DRIVING-6');
    expect(upd).toBeTruthy();
    expect(upd.data.city).toBe('Chicago');
    expect(upd.data.state).toBe('IL');
    expect(upd.data.remark).toBe('BOL #4471');
  });

  it('does NOT create a duplicate when adding a location to the currently-open (ongoing) status', () => {
    // Same regression as above, but for the live open status: no end_timestamp,
    // is_ongoing true. The edit must patch the existing record in place and
    // must NOT spawn a zero-duration "is_ongoing: false" phantom twin, which
    // would make the real open status disappear from the normalized timeline.
    const start = iso(DAY + 6 * 3600000);
    const ongoing = { id: 'open-drive', start_timestamp: start, end_timestamp: null, duty_status: 'DRIVING', city: '', state: '', remark: '', is_ongoing: true };
    const ops = planEdit([ongoing], 'open-drive', {
      duty_status: 'DRIVING', start_timestamp: start, end_timestamp: null, is_ongoing: true,
      city: 'Chicago', state: 'IL', remark: '',
    });
    expect(ops.creates).toHaveLength(0);
    const upd = ops.updates.find((u) => u.id === 'open-drive');
    expect(upd).toBeTruthy();
    expect(upd.data.city).toBe('Chicago');
    expect(upd.data.is_ongoing).toBe(true);
    expect(upd.data.end_timestamp).toBeFalsy();
  });
});

describe('validateTimeline', () => {
  it('flags overlapping events', () => {
    const a = ev('DRIVING', 8, 10);
    const b = ev('ON_DUTY', 9, 11);
    const v = validateTimeline([a, b], { cycleType: '70_8', tz: 'UTC', now: new Date(DAY + 12 * 3600000) });
    expect(v.warnings.some((w) => w.type === 'overlap')).toBe(true);
  });

  it('clean continuous timeline produces no overlap warning', () => {
    const a = ev('DRIVING', 8, 10);
    const b = ev('ON_DUTY', 10, 11);
    const v = validateTimeline([a, b], { cycleType: '70_8', tz: 'UTC', now: new Date(DAY + 12 * 3600000) });
    expect(v.warnings.some((w) => w.type === 'overlap')).toBe(false);
  });
});

describe('buildAfterEvents', () => {
  it('keeps outside-day events unchanged', () => {
    const outside = ev('OFF_DUTY', -6, 0, { id: 'prev' });
    const drive = ev('DRIVING', 6, 12);
    const ops = planDayInsertion([drive], ev('ON_DUTY', 8.5, 9, { id: 'fuel' }));
    const after = buildAfterEvents([outside, drive], [drive], ops);
    expect(after.find((e) => e.id === 'prev')).toBeTruthy();
    expect(after.filter((e) => e.duty_status === 'ON_DUTY' && new Date(e.start_timestamp).getTime() === DAY + 8.5 * 3600000)).toHaveLength(1);
  });
});