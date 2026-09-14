// ============================================================================
// REGRESSION — Edit Log Graph tablet touch-draw bug.
// ----------------------------------------------------------------------------
// See editLogChrome.js's header comment for the full root-cause writeup.
// Short version: Today.jsx picked the Edit Log Graph's chrome (full-screen
// touch editor vs. centered Radix Dialog) using useIsMobile()'s <768px width
// check alone. An iPad is almost always >=768px wide but is still a
// touch-primary device, so it fell into the Dialog branch — whose Radix
// scroll-lock (react-remove-scroll, a real dependency of
// @radix-ui/react-dialog) can swallow a touch drag before RodsGraphEditor's
// pointer handlers ever see it. Phones never hit this because the full-screen
// chrome has no Dialog at all.
// ============================================================================
import { describe, it, expect } from 'vitest';
import { shouldUseFullScreenEditGraph } from './editLogChrome';

describe('shouldUseFullScreenEditGraph', () => {
  it('phone width -> full-screen chrome, regardless of touch capability (unchanged behavior)', () => {
    expect(shouldUseFullScreenEditGraph({ isMobileWidth: true, isTouchCapable: true })).toBe(true);
    expect(shouldUseFullScreenEditGraph({ isMobileWidth: true, isTouchCapable: false })).toBe(true);
  });

  it('tablet width + touch capable -> full-screen chrome (THE FIX: previously fell through to the Dialog)', () => {
    expect(shouldUseFullScreenEditGraph({ isMobileWidth: false, isTouchCapable: true })).toBe(true);
  });

  it('desktop width + no touch capability -> keeps the existing Dialog, unaffected by this fix', () => {
    expect(shouldUseFullScreenEditGraph({ isMobileWidth: false, isTouchCapable: false })).toBe(false);
  });

  it('is a pure boolean OR with no other inputs or device-specific branching — no separate tablet implementation exists to diverge', () => {
    const cases = [
      [true, true], [true, false], [false, true], [false, false],
    ];
    for (const [isMobileWidth, isTouchCapable] of cases) {
      expect(shouldUseFullScreenEditGraph({ isMobileWidth, isTouchCapable }))
        .toBe(isMobileWidth || isTouchCapable);
    }
  });
});
