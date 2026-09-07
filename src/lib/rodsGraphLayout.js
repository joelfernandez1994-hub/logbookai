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
// Presentation-only sizing: how wide the fixed Off/Sleeper/Drive/On label
// column is. Reduced from the original 84px so a phone-width graph gives
// more of its available width to the actual 24-hour plotting area rather
// than the label gutter — 64px is still comfortably wide enough for the
// longest label ("Sleeper", 10px bold) plus its 6px right padding.
export const LEFT_W = 64;

export function computeGraphLayout(containerW) {
  const graphAvailW = Math.max(0, containerW - LEFT_W);
  const visibleHours = 24;
  const pxPerHour = graphAvailW / visibleHours;
  const graphW = pxPerHour * 24;
  const contentW = LEFT_W + graphW;
  return { visibleHours, pxPerHour, graphW, contentW };
}

// ---------------------------------------------------------------------------
// Responsive TEXT LABEL density on the hour ruler — presentation only. The
// grid itself (hour tick lines every hour, quarter ticks every 15 minutes)
// is always full density via computeGraphLayout's pxPerHour, regardless of
// this value; this only controls which ticks additionally get a "12A"/"3A"/
// "Noon"/... text label, so labels never overlap once the full 24-hour day
// is compressed into a phone-width screen. Returns the hour interval between
// labeled ticks (e.g. 3 -> label every 3rd hour: 12A, 3A, 6A, ...).
// ---------------------------------------------------------------------------
export function getLabelIntervalHours(containerW) {
  if (containerW <= 375) return 3;
  if (containerW <= 430) return 2;
  return 1; // existing denser (every-hour) labeling, unchanged for tablet/desktop
}
