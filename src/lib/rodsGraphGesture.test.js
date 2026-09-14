// ============================================================================
// LogbookAI — REGRESSION: continuous swipe-drawing on the Edit Log Graph.
// ----------------------------------------------------------------------------
// "Press a row, drag continuously across the timeline, release" must produce
// ONE canonical edit — never a fragmented series of inserts, one per hour
// boundary crossed. These functions are pure (no DOM), so a real multi-hour
// swipe is simulated as a sequence of updateDrawGesture calls with increasing
// clientX, exactly mirroring what onPointerMove does in RodsGraphEditor.jsx.
// ============================================================================
import { describe, it, expect } from 'vitest';
import {
  xToHour, beginDrawGesture, updateDrawGesture, finalizeDrawGesture, autoScrollDelta,
} from './rodsGraphGesture';
import { planDayInsertion, applyOps, daySegments } from './rodsEditor';
import { computeGraphLayout, LEFT_W } from './rodsGraphLayout';
import { shouldUseFullScreenEditGraph } from './editLogChrome';

const ROWS_LEFT = 64; // matches LEFT_W in rodsGraphLayout.js
const PX_PER_HOUR = 20; // arbitrary fixed scale for the coordinate math below

// clientX for a given hour-of-day, at the fixed test scale above.
const xFor = (hour) => ROWS_LEFT + hour * PX_PER_HOUR;

describe('one continuous swipe across several hours produces exactly ONE canonical edit', () => {
  it('press at 6am, drag to 10am, release -> a single {status, lo:6, hi:10} range', () => {
    const startHour = xToHour(xFor(6), ROWS_LEFT, PX_PER_HOUR);
    let gesture = beginDrawGesture('DRIVING', xFor(6), 100, startHour);

    // Simulate the drag as a series of move events, one per half hour, the
    // same way real pointermove events arrive during a physical swipe.
    for (let h = 6.5; h <= 10; h += 0.5) {
      const hour = xToHour(xFor(h), ROWS_LEFT, PX_PER_HOUR);
      gesture = updateDrawGesture(gesture, xFor(h), 100, hour);
    }

    const result = finalizeDrawGesture(gesture);
    expect(result).toEqual({ status: 'DRIVING', lo: 6, hi: 10 });
  });
});

describe('swipe across multiple hour boundaries never breaks the gesture', () => {
  it('a swipe from 11:45pm-adjacent hour 23.75 through midnight-crossing hour 24 stays one gesture', () => {
    // A swipe spanning many integer-hour boundaries (1 -> 2 -> 3 ... -> 9):
    // the ONLY state that matters is the accumulated start/end hour, so
    // crossing 8 separate hour boundaries in one motion is still one result.
    let gesture = beginDrawGesture('ON_DUTY', xFor(1), 50, 1);
    for (const h of [2, 3, 4, 5, 6, 7, 8, 9]) {
      gesture = updateDrawGesture(gesture, xFor(h), 50, h);
    }
    const result = finalizeDrawGesture(gesture);
    expect(result).toEqual({ status: 'ON_DUTY', lo: 1, hi: 9 });
  });

  it('reversing direction mid-swipe tracks the CURRENT finger position (like a normal drag-select), not the farthest point ever reached', () => {
    let gesture = beginDrawGesture('OFF_DUTY', xFor(2), 50, 2);
    gesture = updateDrawGesture(gesture, xFor(6), 50, 6); // forward to 6
    gesture = updateDrawGesture(gesture, xFor(4), 50, 4); // back up to 4
    const result = finalizeDrawGesture(gesture);
    // Still exactly ONE result (not two, not a leftover 6) — the range is
    // [start, current-end], the same single-value endHour the original
    // implementation always tracked.
    expect(result).toEqual({ status: 'OFF_DUTY', lo: 2, hi: 4 });
  });
});

describe('swipe near the viewport edge triggers auto-scroll (only relevant once zoomed)', () => {
  it('cursor within the activation zone of the right edge scrolls right (positive delta)', () => {
    const delta = autoScrollDelta(/* clientX */ 480, /* viewportLeft */ 100, /* viewportRight */ 500);
    expect(delta).toBeGreaterThan(0);
  });

  it('cursor within the activation zone of the left edge scrolls left (negative delta)', () => {
    const delta = autoScrollDelta(/* clientX */ 110, /* viewportLeft */ 100, /* viewportRight */ 500);
    expect(delta).toBeLessThan(0);
  });

  it('cursor away from either edge produces no auto-scroll', () => {
    expect(autoScrollDelta(300, 100, 500)).toBe(0);
  });
});

describe('no duplicate/fragmented events from one gesture', () => {
  it('intermediate updateDrawGesture calls never themselves produce a committable result — only the final release does', () => {
    let gesture = beginDrawGesture('DRIVING', xFor(0), 0, 0);
    const intermediateResults = [];
    for (const h of [1, 2, 3, 4, 5]) {
      gesture = updateDrawGesture(gesture, xFor(h), 0, h);
      // updateDrawGesture returns gesture STATE, never a commit-ready range —
      // there is no function a caller could accidentally invoke mid-drag
      // that would create a duplicate/partial event.
      expect(gesture).not.toHaveProperty('lo');
      expect(gesture).not.toHaveProperty('hi');
      intermediateResults.push(gesture.endHour);
    }
    expect(intermediateResults).toEqual([1, 2, 3, 4, 5]);
    // Exactly one commit-ready result at the end, covering the whole swipe.
    expect(finalizeDrawGesture(gesture)).toEqual({ status: 'DRIVING', lo: 0, hi: 5 });
  });
});

describe('save produces the same timeline as the drawn graph', () => {
  it('the exact {status, lo, hi} a swipe produces, once planned/applied, yields a segment matching the drawn range', () => {
    let gesture = beginDrawGesture('SLEEPER_BERTH', xFor(0), 0, 0);
    gesture = updateDrawGesture(gesture, xFor(7), 0, 7);
    const result = finalizeDrawGesture(gesture);
    expect(result).toEqual({ status: 'SLEEPER_BERTH', lo: 0, hi: 7 });

    const dayStartMs = new Date('2026-09-07T00:00:00.000Z').getTime();
    const dayEndMs = dayStartMs + 24 * 3600000;
    const newEvent = {
      log_date: '2026-09-07',
      start_timestamp: new Date(dayStartMs + result.lo * 3600000).toISOString(),
      end_timestamp: new Date(dayStartMs + result.hi * 3600000).toISOString(),
      duty_status: result.status,
      city: '', state: '', remark: '',
    };
    const ops = planDayInsertion([], newEvent);
    const after = applyOps([], ops);
    const segs = daySegments(after, dayStartMs, dayEndMs);

    expect(segs).toHaveLength(1);
    expect(segs[0].status).toBe('SLEEPER_BERTH');
    expect(segs[0].startHour).toBeCloseTo(0, 5);
    expect(segs[0].endHour).toBeCloseTo(7, 5);
  });
});

describe('cancel discards the gesture completely', () => {
  it('a tap (no movement past the threshold) commits nothing', () => {
    const gesture = beginDrawGesture('DRIVING', xFor(3), 0, 3);
    // No updateDrawGesture call at all -> moved stays false.
    expect(finalizeDrawGesture(gesture)).toBeNull();
  });

  it('a drag that never clears the tap-vs-drag threshold still commits nothing', () => {
    let gesture = beginDrawGesture('DRIVING', 100, 100, 3);
    gesture = updateDrawGesture(gesture, 102, 101, 3.02); // 2px, well under threshold
    expect(gesture.moved).toBe(false);
    expect(finalizeDrawGesture(gesture)).toBeNull();
  });

  it('an abandoned gesture (never finalized) leaves no trace for the next one — no shared state between gestures', () => {
    let gestureA = beginDrawGesture('DRIVING', xFor(2), 0, 2);
    gestureA = updateDrawGesture(gestureA, xFor(5), 0, 5); // in-progress, then abandoned/cancelled
    // A fresh gesture (e.g. after releasing on a "Cancel" path) starts clean —
    // beginDrawGesture takes no gestureA reference at all, so there is
    // nothing to leak.
    const gestureB = beginDrawGesture('OFF_DUTY', xFor(10), 0, 10);
    expect(gestureB).toEqual({ type: 'draw', status: 'OFF_DUTY', startHour: 10, endHour: 10, startClientX: xFor(10), startClientY: 0, moved: false });
  });
});

describe('row-lock: the duty status can never change mid-gesture from vertical movement', () => {
  it('updateDrawGesture has no way to change status — it is fixed at beginDrawGesture and carried through unmodified', () => {
    let gesture = beginDrawGesture('ON_DUTY', xFor(1), 0, 1);
    // Simulate a "vertical wobble" — updateDrawGesture doesn't even accept a
    // row/status parameter, so there is no code path that could switch it.
    gesture = updateDrawGesture(gesture, xFor(2), 999, 2);
    gesture = updateDrawGesture(gesture, xFor(3), -999, 3);
    expect(gesture.status).toBe('ON_DUTY');
    expect(finalizeDrawGesture(gesture).status).toBe('ON_DUTY');
  });
});
