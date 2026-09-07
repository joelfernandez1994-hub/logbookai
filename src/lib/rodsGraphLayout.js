// ============================================================================
// LogbookAI — Edit Log Graph geometry (pure, no DOM/React).
// ----------------------------------------------------------------------------
// Kept in its own dependency-free module (rather than inline in
// RodsGraphEditor.jsx) specifically so it's unit-testable at exact device
// widths without importing the component tree — RodsGraphEditor.jsx pulls in
// UI primitives that touch `window` at module scope, which this app's plain
// (non-jsdom) vitest environment can't provide.
//
// VIEW mode always fits the full 24-hour day inside the available width —
// the graph must never require horizontal scrolling just to be looked at.
// EDIT mode is the one "intentional editing interaction" allowed to zoom in
// and scroll: drawing/dragging a duty-status segment needs enough pixels per
// hour that a 15-minute stop is still a real, grabbable touch target, which
// isn't possible for the whole day at once on a phone-width screen.
//
// `containerW` is the FULL available width (label column + graph together,
// i.e. the outer scroll container's clientWidth) — pxPerHour must be derived
// from the width left over AFTER the fixed-width label column, not from
// containerW itself, or the graph's content width silently overflows its own
// container by LEFT_W on every breakpoint (the actual cause of a reported
// mobile overflow/clipped-labels/stray-scrollbar bug: the old code computed
// pxPerHour = containerW / visibleHours, then added LEFT_W back on top when
// building contentW, so contentW was always LEFT_W px wider than the space
// actually available to show it in).
// ============================================================================
export const LEFT_W = 84;
const MIN_PX_PER_HOUR = 28; // floor so a 15-min segment (~7px) still has a tappable edge

export function computeGraphLayout(containerW, editMode) {
  const graphAvailW = Math.max(0, containerW - LEFT_W);
  const visibleHours = !editMode ? 24 : (containerW >= 820 ? 24 : containerW >= 520 ? 12 : 6);
  const pxPerHour = editMode
    ? Math.max(MIN_PX_PER_HOUR, graphAvailW / visibleHours)
    : graphAvailW / 24;
  const graphW = pxPerHour * 24;
  const contentW = LEFT_W + graphW;
  return { visibleHours, pxPerHour, graphW, contentW };
}
