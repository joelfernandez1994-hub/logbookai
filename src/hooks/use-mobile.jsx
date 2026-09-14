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

// Reports whether the PRIMARY pointing device is touch (CSS `pointer: coarse`)
// rather than a mouse/trackpad (`pointer: fine`). True on iPhone AND iPad,
// false on desktop — unlike useIsMobile() above, this is a touch-capability
// signal, not a viewport-width one. An iPad is very often >=768px wide (so
// useIsMobile() alone reports "not mobile" for it), but it's still a
// touch-primary device; anything that decides between touch-gesture chrome
// and mouse-oriented chrome (e.g. Today.jsx's Edit Log Graph editor) needs
// this, not useIsMobile(), or tablets get routed into the wrong chrome. See
// src/lib/editLogChrome.js for the decision this feeds.
export function useIsCoarsePointer() {
  const [isCoarse, setIsCoarse] = React.useState(false)

  React.useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return
    const mql = window.matchMedia("(pointer: coarse)")
    const onChange = () => setIsCoarse(mql.matches)
    mql.addEventListener("change", onChange)
    onChange()
    return () => mql.removeEventListener("change", onChange)
  }, [])

  return isCoarse
}
