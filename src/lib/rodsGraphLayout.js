// ============================================================================
// LogbookAI — Edit Log Graph geometry (pure, no DOM/React).
// ----------------------------------------------------------------------------
// Kept in its own dependency-free module (rather than inline in
// RodsGraphEditor.jsx) specifically so it's unit-testable at exact device
// widths without importing the component tree — RodsGraphEditor.jsx pulls in
// UI primitives that touch `window` at module scope, which this app's plain
// (non-jsdom) vitest environment can't provide.
//
// The graph ALWAYS fits the full 24-hour day inside the available width, in
// both view and edit mode — it must never require horizontal scrolling to
// see the day OR to edit it. An earlier revision of this fix let edit mode
// zoom in and scroll (framed as an "intentional editing interaction"), but
// that's exactly the behavior that felt like a regression in practice: a
// driver opening Edit Log to make a change would immediately lose the
// full-day view and land back in the cramped, scrolling, desktop-canvas-in-
// a-phone-viewport feel this fix exists to eliminate. Per explicit direction,
// horizontal scrolling is never the primary solution here, in either mode —
// touch editing (drag-to-draw plus the exact-time EventSheet form for fine
// adjustment) has to work at whatever per-hour pixel width the full day
// leaves on a given screen, not the other way around.
//
// `containerW` is the FULL available width (label column + graph together,
// i.e. the outer scroll container's clientWidth) — pxPerHour must be derived
// from the width left over AFTER the fixed-width label column, not from
// containerW itself, or the graph's content width silently overflows its own
// container by LEFT_W (the original bug this module fixed: the old code
// computed pxPerHour = containerW / visibleHours, then added LEFT_W back on
// top when building contentW, so contentW was always LEFT_W px wider than
// the space actually available to show it in).
// ============================================================================
export const LEFT_W = 84;

export function computeGraphLayout(containerW) {
  const graphAvailW = Math.max(0, containerW - LEFT_W);
  const visibleHours = 24;
  const pxPerHour = graphAvailW / visibleHours;
  const graphW = pxPerHour * 24;
  const contentW = LEFT_W + graphW;
  return { visibleHours, pxPerHour, graphW, contentW };
}
