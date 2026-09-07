// ============================================================================
// LogbookAI — REGRESSION: Edit Log Graph must fit the viewport on mobile
// without horizontal scrolling, in BOTH view and edit mode.
// ----------------------------------------------------------------------------
// History:
//   Round 1 (this same investigation): the graph overflowed horizontally on
//   mobile in VIEW mode — duty-status labels clipped, a stray horizontal
//   scrollbar, the 24-hour timeline extending past the viewport. Root cause:
//   pxPerHour was computed from the FULL container width (label column +
//   graph together) as if it were only the graph's drawing width, so
//   contentW was always LEFT_W (84px) wider than the space available to show
//   it in, at every breakpoint.
//
//   Round 1's first fix made VIEW mode always fit 24h, but kept EDIT mode
//   zoomed in (6h/12h/24h tiers, scrollable) as an "intentional editing
//   interaction." In practice that read as a regression: opening Edit Log to
//   actually make a change immediately lost the full-day view and dropped
//   back into a cramped, scrolling, desktop-canvas-in-a-phone-viewport feel.
//
// Round 2 (this file): computeGraphLayout(containerW) always fits the full
// 24-hour day into the available width, in EVERY mode — no zoom tiers, no
// horizontal scroll, ever, as the primary interaction. Touch editing works
// at whatever per-hour pixel width the full day leaves on a given screen
// (drag-to-draw plus the exact-time EventSheet form for fine adjustment),
// rather than the graph zooming in to make room for finger precision.
// ============================================================================
import { describe, it, expect } from 'vitest';
import { computeGraphLayout, LEFT_W } from './rodsGraphLayout';

describe('REGRESSION — the graph always fits the viewport, no horizontal overflow', () => {
  const widths = [320, 375, 390, 430, 768, 1024, 1440];

  it.each(widths)('at %dpx, contentW exactly equals containerW (no overflow, no scroll needed)', (w) => {
    const layout = computeGraphLayout(w);
    expect(layout.visibleHours).toBe(24);
    expect(layout.contentW).toBeCloseTo(w, 5);
  });

  it.each(widths)('at %dpx, the graph area never claims more than the space left after the label column', (w) => {
    const layout = computeGraphLayout(w);
    expect(layout.graphW).toBeCloseTo(w - LEFT_W, 5);
  });
});

describe('REGRESSION — there is no separate zoomed/scrollable mode any more', () => {
  it('computeGraphLayout takes no mode argument — the same fit-to-width result regardless of what a caller passes as a second arg', () => {
    const withoutArg = computeGraphLayout(375);
    const withExtraArg = computeGraphLayout(375, true); // extra arg silently ignored
    expect(withExtraArg).toEqual(withoutArg);
  });

  it('a phone width (375px) never produces a wider-than-viewport content area', () => {
    const layout = computeGraphLayout(375);
    expect(layout.contentW).toBeLessThanOrEqual(375 + 0.001);
  });

  it('the narrowest supported width (320px) still fits exactly, even though per-hour pixels are small', () => {
    const layout = computeGraphLayout(320);
    expect(layout.contentW).toBeCloseTo(320, 5);
    expect(layout.pxPerHour).toBeGreaterThan(0);
  });
});
