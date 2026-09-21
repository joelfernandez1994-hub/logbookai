// ============================================================================
// LogbookAI — DRIVER-STATED MILEAGE vs MAP ROUTE (deterministic, no AI).
// ----------------------------------------------------------------------------
// A driver may say how far they drove ("I drove 230 miles from Miami to
// Orlando"). That number is the DRIVER'S fact: it is kept as the event's
// mileage (source "driver_stated") and is NEVER overwritten by the map's
// number. It is only COMPARED to the routed road distance so a large
// discrepancy is surfaced as a REVIEW warning (never a block, never a rewrite).
//
// Truck routes, detours, yard moves and odometer mileage legitimately differ
// from a computed road route, so small differences are allowed:
//   |stated - route| <= max(MIN_TOL_MI, TOL_PCT * route)   -> no warning
// (25 mi or 20% of the route, whichever is larger.)
// ============================================================================

export const STATED_MILEAGE_MIN_TOL_MI = 25;
export const STATED_MILEAGE_TOL_PCT = 0.20;

const MILES_RE = /(\d{1,3}(?:,\d{3})+|\d{1,4})(?:\.(\d+))?\s*(?:-\s*)?(?:statute\s+)?(?:miles?|mi)\b(?!\/)/gi;

// Every mileage figure the driver stated, in narrative order. Speeds ("65
// mph", "65 miles per hour") are excluded.
export function extractStatedMileages(narrative) {
  const text = String(narrative || '');
  const out = [];
  for (const m of text.matchAll(MILES_RE)) {
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 14).toLowerCase();
    if (/^\s*(?:per\s+hour|an\s+hour|\/\s*h)/.test(after)) continue; // "65 miles per hour"
    const whole = m[1].replace(/,/g, '');
    const value = Number(m[2] ? `${whole}.${m[2]}` : whole);
    if (!Number.isFinite(value) || value <= 0) continue;
    const before = text.slice(Math.max(0, m.index - 12), m.index).toLowerCase();
    out.push({ miles: value, approximate: /\b(?:about|around|like|roughly|approximately|approx\.?|almost|nearly|~)\s*$/.test(before) });
  }
  return out;
}

export function compareStatedToRoute(statedMiles, routeMiles) {
  const stated = Number(statedMiles), route = Number(routeMiles);
  if (!Number.isFinite(stated) || !Number.isFinite(route) || route <= 0.5) return { known: false };
  const diff = stated - route;
  const tolerance = Math.max(STATED_MILEAGE_MIN_TOL_MI, STATED_MILEAGE_TOL_PCT * route);
  return {
    known: true, stated, route, diff, diffPct: diff / route, tolerance,
    mismatch: Math.abs(diff) > tolerance,
    direction: diff > 0 ? 'over' : 'under',
  };
}

// Pair stated mileages with the completed, route-evaluated Driving legs.
// Only pairs when the count is unambiguous: N stated figures for N evaluable
// legs (in order), or exactly one figure for exactly one leg. Anything else
// (a total for a multi-leg trip, figures with no route) is not compared —
// never guessing which leg a number belongs to.
export function pairStatedMileageWithLegs(legs, narrative) {
  const stated = extractStatedMileages(narrative);
  const evaluable = (legs || []).filter((l) => l && l.route && Number(l.route.miles) > 0.5 && l.evaluation?.known !== false);
  if (!stated.length || !evaluable.length) return [];
  if (stated.length !== evaluable.length) return [];
  return evaluable.map((leg, i) => ({ leg, stated: stated[i] }));
}

// Review warnings (severity "review", never blocking) for pairs whose stated
// mileage materially disagrees with the routed distance.
export function statedMileageWarnings(legs, narrative) {
  const warnings = [];
  for (const { leg, stated } of pairStatedMileageWithLegs(legs, narrative)) {
    const cmp = compareStatedToRoute(stated.miles, leg.route.miles);
    if (!cmp.known || !cmp.mismatch) continue;
    const route = Math.round(cmp.route);
    warnings.push({
      type: 'stated_mileage_mismatch',
      severity: 'review',
      title: 'STATED MILEAGE DIFFERS FROM MAP ROUTE',
      message: `You said ${stated.approximate ? 'about ' : ''}${Math.round(cmp.stated)} mi for ${leg.origin || 'origin'} → ${leg.destination || 'destination'}, but the road route is ~${route} mi (${cmp.direction === 'over' ? '+' : ''}${Math.round(cmp.diff)} mi, ${Math.round(Math.abs(cmp.diffPct) * 100)}% ${cmp.direction}). Truck routes and detours can differ, so your figure is kept as entered — confirm it is correct.`,
      statedMiles: cmp.stated,
      routeMiles: cmp.route,
      diffMiles: cmp.diff,
      eventIndex: leg.eventIndex,
    });
  }
  return warnings;
}

// Apply the driver's stated mileage to the matching events IN PLACE of the
// route figure (route figure preserved separately as route_miles). Returns a
// new events array; never mutates the input.
export function applyStatedMileage(events, legs, narrative) {
  const out = (events || []).map((e) => ({ ...e }));
  for (const { leg, stated } of pairStatedMileageWithLegs(legs, narrative)) {
    const i = leg.eventIndex;
    if (i == null || !out[i]) continue;
    out[i] = {
      ...out[i],
      route_miles: Number(leg.route.miles),
      mileage: stated.miles,
      mileage_source: 'driver_stated',
    };
  }
  return out;
}
