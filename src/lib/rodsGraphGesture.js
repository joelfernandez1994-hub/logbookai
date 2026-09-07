// ============================================================================
// LogbookAI — Edit Log Graph continuous swipe-drawing gesture (pure, no DOM).
// ----------------------------------------------------------------------------
// Extracted so "press a duty-status row, drag continuously across the
// timeline, release" is unit-testable without simulating real pointer
// events on a rendered component (this app's vitest setup has no jsdom).
// RodsGraphEditor.jsx's onPointerDown/onPointerMove/onPointerUp are thin
// wrappers around these functions — same external behavior, same
// event-writing path (planDayInsertion -> applyOps -> applyTimelineOps via
// the EventSheet/ProposedChangeDialog review step, unchanged). Nothing here
// touches the DOM, HOS, or timeline math — it only accumulates hour-of-day
// floats and snaps them to the same canonical grid every other edit path
// uses (snapHour, from rodsEditor.js).
// ============================================================================
import { snapHour } from './rodsEditor';

const MOVE_THRESHOLD_X = 4;
const MOVE_THRESHOLD_Y = 8;

// Pointer clientX -> hour-of-day float, clamped to [0, maxHour]. Pure
// coordinate math; `rowsLeft` is the rows container's left edge in the same
// coordinate space as clientX (its getBoundingClientRect().left).
export function xToHour(clientX, rowsLeft, pxPerHour, maxHour = 24) {
  if (!pxPerHour) return 0;
  return Math.max(0, Math.min(maxHour, (clientX - rowsLeft) / pxPerHour));
}

// Start a new draw gesture. The duty status is LOCKED to whichever row the
// touch began on and is never re-derived from vertical position during the
// drag — the safest behavior per spec: an accidental vertical wobble mid-
// swipe can never switch which duty status is being drawn. Only one
// deliberate action (a fresh touch-down on a different row) can change it.
export function beginDrawGesture(status, clientX, clientY, hour) {
  return { type: 'draw', status, startHour: hour, endHour: hour, startClientX: clientX, startClientY: clientY, moved: false };
}

// One pointer-move update. Returns a NEW gesture object (never mutates the
// input) with `endHour` advanced to the current position. `moved` latches
// true once the finger crosses the tap-vs-drag threshold and stays true for
// the rest of the gesture (even if the finger drifts back near the start),
// so a real continuous edit already in progress is never mistaken for a tap.
// Crossing any number of hour boundaries in between is just a larger
// endHour — there is no per-hour state to fragment.
export function updateDrawGesture(gesture, clientX, clientY, hour) {
  const dx = Math.abs(clientX - gesture.startClientX);
  const dy = Math.abs(clientY - gesture.startClientY);
  const moved = gesture.moved || dx > MOVE_THRESHOLD_X || dy > MOVE_THRESHOLD_Y;
  return { ...gesture, endHour: hour, moved };
}

// End of gesture -> the ONE canonical {status, lo, hi} range to commit,
// snapped to the same 1-minute grid every other edit path uses. Returns
// null for a tap (never moved) or a zero/negative-length result — "nothing
// to create," which is exactly what a cancelled/abandoned gesture needs:
// since these functions are pure and side-effect-free, simply not calling
// this (or discarding its result) IS "cancel discards the gesture
// completely" — no cleanup, no partial writes, nothing was ever created.
// Always returns AT MOST one range per gesture no matter how many
// intermediate updateDrawGesture calls happened — a swipe across the whole
// day is one call to this function, not dozens.
export function finalizeDrawGesture(gesture) {
  if (!gesture || !gesture.moved) return null;
  const lo = snapHour(Math.min(gesture.startHour, gesture.endHour), 1);
  const hi = snapHour(Math.max(gesture.startHour, gesture.endHour), 1);
  if (hi - lo < 1 / 60) return null;
  return { status: gesture.status, lo, hi };
}

// Auto-scroll-while-dragging-near-edge — only meaningful when the graph is
// zoomed in (horizontally scrollable); in the default full-day view there is
// nothing to scroll and callers simply won't invoke this. Pure math: given
// the pointer's clientX and the scrollable viewport's left/right edges,
// returns the scrollLeft delta to apply this tick (0 = not near an edge).
// `edge`/`factor` match the original auto-scroll tuning (48px activation
// zone, 0.4 ease per animation-frame tick).
export function autoScrollDelta(clientX, viewportLeft, viewportRight, edge = 48, factor = 0.4) {
  const rightDist = viewportRight - clientX;
  const leftDist = clientX - viewportLeft;
  if (rightDist < edge) return (edge - rightDist) * factor;
  if (leftDist < edge) return -(edge - leftDist) * factor;
  return 0;
}
