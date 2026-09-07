// ============================================================================
// LogbookAI — REGRESSION: Edit Log Graph must fit the viewport on mobile
// without horizontal scrolling, in VIEW mode.
// ----------------------------------------------------------------------------
// Reported bug: on mobile the "Edit Log Graph" modal (RodsGraphEditor,
// shared by Today.jsx and Logs.jsx) overflowed horizontally — duty-status
// labels clipped, a stray horizontal scrollbar appeared inside the modal,
// and the 24-hour timeline extended past the visible viewport.
//
// Root cause (two compounding bugs in the old geometry math):
//   1. pxPerHour was computed as `containerW / visibleHours` — using the
//      FULL container width (label column + graph together) as if it were
//      only the graph's width. contentW was then built as
//      `LEFT_W (84px) + graphW`, which is therefore always LEFT_W px WIDER
//      than the container that has to display it, at every breakpoint,
//      including the "24 visible hours" tier — a systemic overflow that was
//      merely small/unnoticed on desktop and severe on a narrow phone.
//   2. VIEW mode (the default, non-interactive state the "Edit Log Graph"
//      modal opens into) used the SAME zoomed-in tier logic as EDIT mode
//      (6h visible under 520px container width), forcing a 4x-wider-than-
//      necessary scrollable strip just to LOOK at the day, even though
//      nothing is draggable/tappable outside edit mode at all.
//
// Fix: computeGraphLayout(containerW, editMode) — a pure, standalone
// function (no DOM/React) so it's testable at exact device widths:
//   - VIEW mode (editMode=false) always fits the full 24h day into
//     (containerW - LEFT_W), so contentW === containerW exactly: no
//     horizontal scroll is ever required just to view the day.
//   - EDIT mode is the one "intentional editing interaction" allowed to
//     zoom in (down to a 28px/hour floor so a 15-minute stop stays a real
//     touch target) and therefore legitimately scroll — this is unchanged
//     behavior for the actual drawing/dragging interaction, on purpose.
// ============================================================================
import { describe, it, expect } from 'vitest';
import { computeGraphLayout } from './rodsGraphLayout';

const LEFT_W = 84;

describe('REGRESSION — VIEW mode always fits the viewport, no horizontal overflow', () => {
  const widths = [320, 375, 390, 430, 768, 1024, 1440];

  it.each(widths)('at %dpx, contentW exactly equals containerW (no overflow, no scroll needed)', (w) => {
    const layout = computeGraphLayout(w, false);
    expect(layout.visibleHours).toBe(24);
    expect(layout.contentW).toBeCloseTo(w, 5);
  });

  it.each(widths)('at %dpx, the graph area never claims more than the space left after the label column', (w) => {
    const layout = computeGraphLayout(w, false);
    expect(layout.graphW).toBeCloseTo(w - LEFT_W, 5);
  });
});

describe('control — EDIT mode is the allowed exception: it may zoom in and scroll', () => {
  it('at a phone width (375px), edit mode legitimately produces a wider-than-viewport scroll strip', () => {
    const layout = computeGraphLayout(375, true);
    expect(layout.visibleHours).toBe(6); // zoomed in for touch precision
    expect(layout.contentW).toBeGreaterThan(375); // intentionally scrollable
  });

  it('pxPerHour never drops below the minimum tappable-target floor, even on the narrowest supported width', () => {
    const layout = computeGraphLayout(320, true);
    expect(layout.pxPerHour).toBeGreaterThanOrEqual(28);
  });

  it('at a large desktop width, edit mode still fits all 24 hours (no unnecessary zoom when there is room)', () => {
    const layout = computeGraphLayout(1024, true);
    expect(layout.visibleHours).toBe(24);
    expect(layout.contentW).toBeCloseTo(1024, 5);
  });
});

describe('control — switching modes on the SAME width changes zoom, not the shared component', () => {
  it('view -> edit on an identical 390px container goes from full-day-fit to zoomed/scrollable', () => {
    const view = computeGraphLayout(390, false);
    const edit = computeGraphLayout(390, true);
    expect(view.contentW).toBeCloseTo(390, 5);
    expect(edit.contentW).toBeGreaterThan(view.contentW);
  });
});
