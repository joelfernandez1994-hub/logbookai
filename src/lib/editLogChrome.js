// ============================================================================
// LogbookAI — which chrome Today.jsx's Edit Log Graph opens in (pure, no
// DOM/React), extracted the same way rodsGraphLayout.js/rodsGraphGesture.js
// are: dependency-free so it's unit-testable without jsdom.
// ----------------------------------------------------------------------------
// BUG THIS FIXES (tablet + zoom + touch draw broken):
//
// Today.jsx offers two Edit Log Graph chromes: a full-screen fixed overlay
// (no Radix Dialog involved at all) and a centered Radix `<Dialog>`. Which
// one a driver gets used to depend only on useIsMobile()'s <768px viewport
// check. That check answers "is this a small screen", not "is this a touch
// device" — an iPad is almost always >=768px wide, so it fell on the "not
// mobile" side and got routed into the Dialog.
//
// Radix's `<Dialog>` wraps its content in `react-remove-scroll` (a real
// dependency of @radix-ui/react-dialog, confirmed in node_modules) to lock
// body scroll while open. On iOS/iPadOS that lock is implemented as a
// document-level, non-passive `touchmove` listener that calls
// `event.preventDefault()` on gestures it doesn't recognize as legitimate
// nested scrolling. `RodsGraphEditor`'s drag-to-draw layer sets
// `touch-action: none` so the BROWSER's own native gesture recognizer leaves
// touch handling to our pointer events — but that CSS property has no effect
// on a manually-attached, non-passive JS listener at the document level, so
// remove-scroll's lock can still swallow the touchmove sequence mid-drag.
//
// That listener is only ever mounted while a Radix Dialog is open — the
// mobile full-screen overlay is a plain `<div>`, not a Dialog, so it was
// never subject to this at all. That's the entire reason mobile worked and
// tablet didn't, despite both using the exact same shared RodsGraphEditor
// and gesture module (rodsGraphGesture.js) underneath: the touch-drawing
// code was never broken or device-specific, only the container it got
// rendered into was.
//
// A mouse on desktop is unaffected either way, since `touchmove` never fires
// for mouse input — hence "desktop keeps the Dialog" was never the bug.
//
// FIX: route by touch capability (`pointer: coarse`, see useIsCoarsePointer
// in src/hooks/use-mobile.jsx), not by viewport width alone, so any
// touch-primary device — phone AND tablet — gets the Dialog-free full-screen
// chrome that was already correct, while a real desktop mouse keeps the
// existing centered Dialog. No new "tablet" branch/component is introduced;
// tablets simply take the same branch phones already did.
// ============================================================================
export function shouldUseFullScreenEditGraph({ isMobileWidth, isTouchCapable }) {
  return !!isMobileWidth || !!isTouchCapable;
}
