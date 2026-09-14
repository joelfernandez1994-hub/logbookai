import * as React from "react"

const MOBILE_BREAKPOINT = 768

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState(undefined)

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    }
    mql.addEventListener("change", onChange)
    setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    return () => mql.removeEventListener("change", onChange);
  }, [])

  return !!isMobile
}

// Reports whether this device has touch input at all — true on iPhone AND
// iPad, false on a real mouse/trackpad-only desktop. Unlike useIsMobile()
// above, this is a touch-capability signal, not a viewport-width one: an
// iPad is very often >=768px wide (so useIsMobile() alone reports "not
// mobile" for it), but it's still a touch device; anything that decides
// between touch-gesture chrome and mouse-oriented chrome (e.g. Today.jsx's
// Edit Log Graph editor) needs this, not useIsMobile(), or tablets get
// routed into the wrong chrome. See src/lib/editLogChrome.js for the
// decision this feeds.
//
// Deliberately does NOT rely on the CSS `pointer: coarse` media feature
// alone — iPadOS Safari's default "Request Desktop Website" mode spoofs
// pointer/hover media features to report `pointer: fine`/`hover: hover`
// (i.e. "this is a Mac") on a real iPad, specifically so desktop sites
// render as desktop sites. Trusting that alone silently made this hook
// return false on a stock iPad — the exact device this was added for — and
// shipped a no-op fix. `navigator.maxTouchPoints` is a hardware-capability
// API, not a site-compatibility spoof, so iPadOS reports it truthfully
// (typically 5) even while the media query lies; this checks both and
// trusts whichever says "touch capable."
export function useIsTouchCapable() {
  const [isTouch, setIsTouch] = React.useState(false)

  React.useEffect(() => {
    if (typeof window === "undefined") return
    const hasTouchPoints =
      (typeof navigator !== "undefined" && navigator.maxTouchPoints > 0) ||
      "ontouchstart" in window
    const mql = window.matchMedia ? window.matchMedia("(pointer: coarse)") : null
    const onChange = () => setIsTouch(hasTouchPoints || !!mql?.matches)
    mql?.addEventListener("change", onChange)
    onChange()
    return () => mql?.removeEventListener("change", onChange)
  }, [])

  return isTouch
}
