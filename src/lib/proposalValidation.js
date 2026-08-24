// ============================================================================
// LogbookAI — MANDATORY PROPOSAL VALIDATION PIPELINE (deterministic, no AI).
// ----------------------------------------------------------------------------
// Runs the same checks for AI-proposed events, manual adds, and manual edits:
//   merge → chronological overlap/gap → geographic continuity → pre-trip
//   → route distance/travel-time reasonableness → deterministic HOS engine
//   → 30-minute break → 11h / 14h / cycle → split-sleeper → 34h restart
//   → warnings/questions → (driver review) → Confirm & Apply
//
// Route reasonableness uses a REAL road route (from the tripEstimate backend)
// when a routingProvider is supplied; the pure evaluator below is testable with
// a fixed route fixture. Nothing here writes to the database or calls an LLM.
// Routing information is a REASONABLENESS CHECK ONLY — it never mutates actual
// history (past RODS, receipts, or breaks). AI cannot bypass these checks.
// ============================================================================

import {
  computeHOS, runComplianceCheck, normalizeEvents, compute30MinBreak,
  dateKeyInTz,
} from './hosEngine';
import { mergeProposedEvents, collectViolations, distanceReasonableness } from './logAssistant';
import { startOfDayInTz } from './timelineEngine';

const H = 3600000;
const MIN = 60000;
const BREAK_GAP_MS = 8 * H;  // 8 cumulative driving hours before a 30-min break
const BREAK_REQ_MS = 30 * MIN;

// ---------------------------------------------------------------------------
// TRIP PLANNING SPEED PROFILE
// Planning/reasonableness only — NOT evidence of actual vehicle movement.
// ---------------------------------------------------------------------------
export const SPEED_PROFILES = {
  conservative: { id: 'conservative', label: 'Conservative Truck Estimate' },
  55: { id: '55', label: '55 mph average', mph: 55 },
  60: { id: '60', label: '60 mph average', mph: 60 },
  65: { id: '65', label: '65 mph average', mph: 65 },
  provider: { id: 'provider', label: 'Routing Provider ETA' },
};
export const DEFAULT_SPEED_PROFILE = 'conservative';

export function speedProfileLabel(id) {
  return (SPEED_PROFILES[id] || SPEED_PROFILES.conservative).label;
}

// Realistic truck planning time. Conservative = routing base ETA with a
// planning buffer for urban congestion / fuel & inspection stops / metro
// slowdown, floored at a 62 mph open-road average. Fixed-mph profiles divide
// miles by the chosen speed. "Routing Provider ETA" returns the base ETA.
export function truckEtaHours(route, profileId = DEFAULT_SPEED_PROFILE) {
  if (!route || route.miles == null) return null;
  const base = typeof route.hours === 'number' ? route.hours : null;
  const p = SPEED_PROFILES[profileId] || SPEED_PROFILES.conservative;
  if (p.mph) return route.miles / p.mph;
  if (p.id === 'provider') return base;
  const buffered = base != null ? base * 1.08 : null;
  const floor = route.miles / 62;
  return buffered != null ? Math.max(buffered, floor) : floor;
}

// Pure evaluator: given a road route {miles, hours} and the requested driving
// hours, decide whether the requested driving time is reasonable for a truck.
export function evaluateRouteReasonableness(route, requestedDrivingHours, profileId = DEFAULT_SPEED_PROFILE) {
  if (!route || route.miles == null) return { known: false };
  const baseEta = typeof route.hours === 'number' ? route.hours : null;
  const truck = truckEtaHours(route, profileId);
  const conflict = requestedDrivingHours != null && truck != null && requestedDrivingHours < truck * 0.92;
  return {
    known: true,
    miles: Math.round(route.miles),
    baseEtaHours: baseEta,
    truckEtaHours: truck,
    requestedDrivingHours: requestedDrivingHours,
    planningProfile: profileId,
    planningProfileLabel: speedProfileLabel(profileId),
    conflict,
    note: conflict
      ? `Road route ~${Math.round(route.miles)} mi · base routing ETA ~${baseEta != null ? baseEta.toFixed(1) : '?'} h · realistic truck travel ~${truck.toFixed(1)} h. Requested ${requestedDrivingHours} h of driving is not consistent with the route.`
      : `Road route ~${Math.round(route.miles)} mi · realistic truck travel ~${truck.toFixed(1)} h. Requested driving time is plausible.`,
  };
}

// Production routing provider: calls the existing tripEstimate backend
// (which uses a routing/web-context LLM for real road miles/ETA).
export async function fetchRoute(origin, destination) {
  if (!origin || !destination) return null;
  const { base44 } = await import('@/api/base44Client');
  const res = await base44.functions.invoke('tripEstimate', { origin, destination });
  const d = res?.data || res;
  if (!d || d.error) return null;
  return { miles: d.miles, hours: d.hours, notes: d.notes, isTruckRoute: d.is_truck_route };
}

// ---------------------------------------------------------------------------
// CHRONOLOGICAL OVERLAP / GAP
// ---------------------------------------------------------------------------
function evEnd(e, now) {
  if (e.end_timestamp) return new Date(e.end_timestamp);
  if (e.is_ongoing) return now;
  return new Date(e.start_timestamp);
}

export function findOverlaps(merged, now = new Date()) {
  const sorted = [...merged].filter(e => e.start_timestamp).sort((a, b) => new Date(a.start_timestamp) - new Date(b.start_timestamp));
  const out = [];
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1], b = sorted[i];
    const ae = evEnd(a, now);
    const bs = new Date(b.start_timestamp);
    if (ae > bs) {
      out.push({
        type: 'overlap', severity: 'blocking', title: 'OVERLAPPING EVENTS',
        message: `An event ending at ${fmtClock(ae)} overlaps an event starting at ${fmtClock(bs)}. Review the times.`,
        aStart: new Date(a.start_timestamp), bStart: bs,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// GEOGRAPHIC CONTINUITY (location / time conflict) — deterministic.
// Uses known city-center coordinates; flags impossible jumps (e.g. Albany, NY
// → Miami, FL in 4 hours). Does NOT auto-fabricate movement between locations.
// ---------------------------------------------------------------------------
export function normalizeLocationPart(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function sameLocation(aCity, aState, bCity, bState) {
  return normalizeLocationPart(aCity) === normalizeLocationPart(bCity)
    && normalizeLocationPart(aState) === normalizeLocationPart(bState);
}

export function formatLocation(city, state) {
  return [String(city || '').trim(), String(state || '').trim().toUpperCase()].filter(Boolean).join(', ');
}

export function locationTimeConflict(prevEvent, event, now = new Date()) {
  if (!prevEvent || !event) return null;
  if (!prevEvent.city || !event.city) return null;
  if (sameLocation(prevEvent.city, prevEvent.state, event.city, event.state)) return null;
  const prevEnd = evEnd(prevEvent, now);
  const start = new Date(event.start_timestamp);
  if (!prevEnd || !start) return null;
  const gap = start - prevEnd;
  if (gap <= 0) return null; // back-to-back or overlapping — handled by overlap check
  const r = distanceReasonableness(prevEvent.city, prevEvent.state, event.city, event.state, gap);
  if (r.known && r.conflict) {
    return {
      type: 'location_time_conflict', severity: 'blocking', title: 'LOCATION / TIME CONFLICT',
      message: `Your previous log places you in ${prevEvent.city}, ${prevEvent.state}, but this event begins in ${event.city}, ${event.state} ${fmtGap(gap)} later. The travel time between these locations is not consistent with the current timeline.`,
      from: { city: prevEvent.city, state: prevEvent.state },
      to: { city: event.city, state: event.state },
      gapMs: gap, miles: r.miles, avgSpeed: r.avgSpeed,
      hint: 'Review the date, time, city/state, or add the missing event(s) that connect these locations.',
    };
  }
  return null;
}

export function findLocationConflicts(merged, now = new Date()) {
  const sorted = [...merged].filter(e => e.start_timestamp && e.city).sort((a, b) => new Date(a.start_timestamp) - new Date(b.start_timestamp));
  const out = [];
  for (let i = 1; i < sorted.length; i++) {
    const c = locationTimeConflict(sorted[i - 1], sorted[i], now);
    if (c) out.push(c);
  }
  return out;
}

// ---------------------------------------------------------------------------
// PRE-TRIP REQUIREMENT — a Driving period that begins a new work period after
// a qualifying long rest (>= 10h Off/Sleeper or a 34h restart) with no ON_DUTY
// pre-trip recorded since that rest. Returns a clarification, NOT an event.
// ---------------------------------------------------------------------------
export function needsPreTrip(merged, now = new Date()) {
  const sorted = [...merged].filter(e => e.start_timestamp).sort((a, b) => new Date(a.start_timestamp) - new Date(b.start_timestamp));
  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i];
    if (e.duty_status !== 'DRIVING') continue;
    let restEnd = null;
    for (let j = 0; j < i; j++) {
      const p = sorted[j];
      if (p.duty_status === 'OFF_DUTY' || p.duty_status === 'SLEEPER_BERTH') {
        const pe = evEnd(p, now);
        const dur = pe - new Date(p.start_timestamp);
        if (dur >= 10 * H) restEnd = pe;
      }
    }
    if (!restEnd) continue;
    const hasPre = sorted.slice(0, i).some(p =>
      p.duty_status === 'ON_DUTY' &&
      /pre.?trip/i.test(p.remark || p.activity_type || '') &&
      new Date(p.start_timestamp) >= restEnd
    );
    if (!hasPre) return { required: true, drivingStart: new Date(e.start_timestamp), restEnd, drivingEvent: e };
    return { required: false };
  }
  return { required: false };
}

// Build a pre-trip ON_DUTY event from driver-confirmed details. Never claims a
// fixed federally-required duration.
export function buildPreTripEvent({ date, start_timestamp, duration_min, city, state, source = 'manual' }) {
  const start = new Date(start_timestamp);
  const end = new Date(start.getTime() + (duration_min || 15) * MIN);
  return {
    date: date || dateKeyInTz(start, 'UTC'),
    start_timestamp: start.toISOString(),
    end_timestamp: end.toISOString(),
    duty_status: 'ON_DUTY',
    activity_type: 'Pre-Trip',
    remark: 'Pre-Trip Inspection',
    city: city || '', state: state || '',
    source, confidence: 'high', ambiguous_fields: [],
  };
}

// ---------------------------------------------------------------------------
// 30-MINUTE BREAK — mandatory before a proposed log can be confirmed.
// For FUTURE/PLANNED: recommend a qualifying non-driving stop before the 8h
// threshold (labeled PLANNED — NOT YET LOGGED). For PAST: flag and ask whether
// a real stop occurred; never fabricate a break to remove the violation.
// ---------------------------------------------------------------------------
export function breakStatus(merged, now = new Date()) {
  const segments = normalizeEvents(merged, now);
  const br = compute30MinBreak(segments, now);
  return {
    required: br.breakRequired,
    satisfied: br.satisfied,
    drivingAccumulatedMs: br.drivingAccumulatedMs,
    remainingBeforeBreakMs: br.remainingBeforeBreakMs,
    thresholdMs: BREAK_GAP_MS,
  };
}

// Recommend a 30-minute qualifying stop to insert before the 8h cumulative
// driving threshold. Returns a proposed event (PLANNED — NOT YET LOGGED) or null.
export function recommendBreakInsertion(proposed, now = new Date()) {
  const sorted = [...(proposed || [])].filter(p => p.start_timestamp).sort((a, b) => new Date(a.start_timestamp) - new Date(b.start_timestamp));
  let acc = 0; let lastBreakEnd = null;
  for (const p of sorted) {
    if (p.duty_status === 'DRIVING') {
      const s = new Date(p.start_timestamp);
      const e = p.end_timestamp ? new Date(p.end_timestamp) : now;
      const since = lastBreakEnd ? Math.max(0, s - lastBreakEnd) : 0;
      const block = (e - s) + Math.min(since, 0); // within proposed contiguous driving
      acc += (e - s);
      if (acc >= BREAK_GAP_MS) {
        const breakAt = new Date(s.getTime() + (BREAK_GAP_MS - (acc - (e - s))));
        const start = new Date(Math.min(breakAt.getTime(), e.getTime()));
        return {
          date: dateKeyInTz(start, 'UTC'),
          start_timestamp: start.toISOString(),
          end_timestamp: new Date(start.getTime() + 30 * MIN).toISOString(),
          duty_status: 'ON_DUTY',
          activity_type: 'Break',
          remark: '30-Minute Break (planned)',
          city: p.city || '', state: p.state || '',
          source: 'planned', planned: true,
        };
      }
    } else if (p.duty_status === 'ON_DUTY' || p.duty_status === 'OFF_DUTY' || p.duty_status === 'SLEEPER_BERTH') {
      const s = new Date(p.start_timestamp);
      const e = p.end_timestamp ? new Date(p.end_timestamp) : now;
      if ((e - s) >= BREAK_REQ_MS) { acc = 0; lastBreakEnd = e; }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// MANDATORY PROPOSAL VALIDATION PIPELINE (sync portion). Route reasonableness
// is added by the caller via validateProposalWithRoute (async) when a routing
// provider is available; both return the same warning shape.
// ---------------------------------------------------------------------------
export function validateProposal(existing, proposed, opts = {}) {
  const { cycleType = '70_8', tz = 'UTC', now = new Date(), isFuture = null } = opts;
  const t = now instanceof Date ? now : new Date(now);
  const merged = mergeProposedEvents(existing, proposed, t);

  const warnings = [];
  warnings.push(...findOverlaps(merged, t));
  warnings.push(...findLocationConflicts(merged, t));

  const pretrip = needsPreTrip(merged, t);
  if (pretrip.required) {
    warnings.push({
      type: 'pretrip', severity: 'blocking', title: 'PRE-TRIP CHECK',
      message: 'You are starting a Driving period. Did you perform your pre-trip vehicle inspection before driving?',
      options: ['Yes — Add Pre-Trip', 'Already recorded / satisfied', 'Go Back'],
      drivingStart: pretrip.drivingStart,
    });
  }

  // evaluation time = latest of now / last proposed end
  let evalNow = new Date(t);
  for (const p of (proposed || [])) {
    if (p.end_timestamp) { const e = new Date(p.end_timestamp); if (e > evalNow) evalNow = new Date(e); }
  }
  const hos = computeHOS(merged, cycleType, tz, evalNow, { historyComplete: true });
  const issues = runComplianceCheck(merged, cycleType, tz, evalNow, { historyComplete: true });
  const violations = collectViolations(hos, issues);

  const br = breakStatus(merged, evalNow);
  const future = isFuture != null ? isFuture : ((proposed || [])[0]?.start_timestamp ? new Date((proposed || [])[0].start_timestamp) > t : false);
  if (br.required) {
    warnings.push({
      type: 'break30', severity: 'blocking', title: '30-MINUTE BREAK REQUIRED',
      message: future
        ? 'This plan exceeds 8 cumulative hours of Driving without a qualifying 30-minute interruption. Add a planned qualifying stop (Off Duty, Sleeper Berth, or On Duty — Fuel/meal/rest) before the threshold. Labeled PLANNED — NOT YET LOGGED.'
        : 'Your actual timeline shows more than 8 cumulative hours of Driving without a qualifying 30-minute interruption. Did a real stop or break occur that was omitted? If so, enter the actual event. LogbookAI will not fabricate a break to remove the violation.',
      isFuture: future,
      drivingAccumulatedMs: br.drivingAccumulatedMs,
      remainingBeforeBreakMs: br.remainingBeforeBreakMs,
    });
  }

  return { merged, warnings, violations, hos, break: br, pretrip, evalNow, isFuture: future };
}

// Add async route-reasonableness results for every proposed driving segment.
// Does NOT mutate history.
export async function validateProposalWithRoute(existing, proposed, opts = {}) {
  const base = validateProposal(existing, proposed, opts);
  const { routingProvider = fetchRoute, speedProfile = DEFAULT_SPEED_PROFILE, now = new Date() } = opts;
  const t = now instanceof Date ? now : new Date(now);
  const routeWarn = await addRouteWarning(proposed, { routingProvider, speedProfile, now: t, isFuture: base.isFuture });
  if (routeWarn) base.warnings.push(routeWarn);
  return base;
}

export function computeProposalTotals(proposedEvents, dateStr, timezone) {
  const dayStart = startOfDayInTz(new Date(`${dateStr}T12:00:00Z`), timezone);
  const dayEnd = new Date(dayStart.getTime() + 24 * H);
  const totalsMs = { OFF_DUTY: 0, SLEEPER_BERTH: 0, DRIVING: 0, ON_DUTY: 0 };
  for (const event of (proposedEvents || [])) {
    if (!Object.prototype.hasOwnProperty.call(totalsMs, event.duty_status) || !event.start_timestamp || !event.end_timestamp) continue;
    const start = new Date(event.start_timestamp);
    const end = new Date(event.end_timestamp);
    const clippedStart = start < dayStart ? dayStart : start;
    const clippedEnd = end > dayEnd ? dayEnd : end;
    if (clippedEnd > clippedStart) totalsMs[event.duty_status] += clippedEnd - clippedStart;
  }
  const result = Object.fromEntries(Object.entries(totalsMs).map(([status, ms]) => [status, ms / H]));
  return { ...result, totalHours: Object.values(totalsMs).reduce((sum, ms) => sum + ms, 0) / H };
}

function fallbackMph(profileId) {
  const profile = SPEED_PROFILES[profileId] || SPEED_PROFILES.conservative;
  if (profile.mph) return profile.mph;
  return profile.id === 'provider' ? 50 : 55;
}

export function getDrivingLegs(proposed, now = new Date()) {
  const source = proposed || [];
  const sorted = source.filter(event => event.start_timestamp)
    .sort((a, b) => new Date(a.start_timestamp) - new Date(b.start_timestamp));
  return sorted.map((event, index) => {
    if (event.duty_status !== 'DRIVING') return null;
    const destinationEvent = sorted[index + 1];
    const end = event.end_timestamp ? new Date(event.end_timestamp) : now;
    return {
      event,
      eventIndex: source.indexOf(event),
      origin: { city: String(event.city || '').trim(), state: String(event.state || '').trim().toUpperCase() },
      destination: { city: String(destinationEvent?.city || '').trim(), state: String(destinationEvent?.state || '').trim().toUpperCase() },
      drivingHours: Math.max(0, (end - new Date(event.start_timestamp)) / H),
    };
  }).filter(Boolean);
}

export async function inspectProposalRoutes(proposed, { routingProvider = fetchRoute, speedProfile = DEFAULT_SPEED_PROFILE, now = new Date() } = {}) {
  const legs = getDrivingLegs(proposed, now);
  return Promise.all(legs.map(async (leg) => {
    const origin = formatLocation(leg.origin.city, leg.origin.state);
    const destination = formatLocation(leg.destination.city, leg.destination.state);
    if (!origin || !destination) return { ...leg, origin, destination, route: null, evaluation: { known: false }, error: 'Missing route endpoint' };
    if (sameLocation(leg.origin.city, leg.origin.state, leg.destination.city, leg.destination.state)) {
      return {
        ...leg, origin, destination, route: { miles: 0, hours: 0 },
        evaluation: { known: true, conflict: leg.drivingHours > 0, miles: 0, requestedDrivingHours: leg.drivingHours, note: `A ${leg.drivingHours.toFixed(1)} h driving segment cannot begin and end at the same location.` },
      };
    }
    let route = null;
    try { route = await routingProvider(origin, destination); } catch (e) { route = null; }
    const evaluation = evaluateRouteReasonableness(route, leg.drivingHours, speedProfile);
    if (evaluation.known && Number(route?.miles) <= 0.5 && leg.drivingHours > 0.25) {
      evaluation.conflict = true;
      evaluation.note = `Road route is approximately 0 mi, which is not consistent with ${leg.drivingHours.toFixed(1)} h of driving.`;
    }
    return { ...leg, origin, destination, route, evaluation };
  }));
}

export async function enrichProposalMileage(proposed, opts = {}) {
  const legs = await inspectProposalRoutes(proposed, opts);
  const speed = fallbackMph(opts.speedProfile || DEFAULT_SPEED_PROFILE);
  const events = (proposed || []).map(event => ({ ...event }));
  for (const leg of legs) {
    const routeMiles = Number(leg.route?.miles);
    const hasRoadMiles = Number.isFinite(routeMiles) && routeMiles > 0.5;
    events[leg.eventIndex] = {
      ...events[leg.eventIndex],
      mileage: hasRoadMiles ? routeMiles : leg.drivingHours * speed,
      mileage_source: hasRoadMiles ? 'route' : 'estimate',
      route_origin: leg.origin,
      route_destination: leg.destination,
    };
  }
  return {
    events,
    legs,
    totalMiles: events.reduce((sum, event) => sum + (event.duty_status === 'DRIVING' && Number.isFinite(Number(event.mileage)) ? Number(event.mileage) : 0), 0),
  };
}

export async function addRouteWarning(proposed, { routingProvider = fetchRoute, speedProfile = DEFAULT_SPEED_PROFILE, now = new Date(), isFuture = true, legs: providedLegs = null } = {}) {
  const legs = providedLegs || await inspectProposalRoutes(proposed, { routingProvider, speedProfile, now });
  if (!legs.length) return null;
  const conflicts = legs.filter(leg => leg.evaluation?.conflict);
  const details = legs.map(leg => `${leg.origin || 'Unknown'} → ${leg.destination || 'Unknown'}: ${leg.evaluation?.known ? leg.evaluation.note : 'Road route unavailable; mileage will be labeled as an estimate.'}`);
  return {
    type: 'route_reasonableness',
    severity: conflicts.length && isFuture ? 'blocking' : 'review',
    title: conflicts.length ? (isFuture ? 'ROUTE / TRAVEL-TIME CONFLICT' : 'TRAVEL-TIME CONFLICT — REVIEW REQUIRED') : 'ROUTE VALIDATION',
    message: details.join(' '),
    isFuture,
    legs,
    note: conflicts.length
      ? (isFuture ? 'Adjust the plan or route endpoints before applying.' : 'Routing is a reasonableness check only. Review factual times and locations.')
      : 'Every proposed driving segment was checked against its road route.',
  };
}

// ---------------------------------------------------------------------------
// FORMAT helpers
// ---------------------------------------------------------------------------
function fmtClock(d) {
  if (!d) return '--';
  return new Date(d).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}
function fmtGap(ms) {
  const h = ms / H;
  if (h < 1) return `${Math.round(ms / MIN)} min`;
  return `${h.toFixed(1)} h`;
}

// ---------------------------------------------------------------------------
// Convenience: is a warning blocking (must resolve before Confirm & Apply)?
// ---------------------------------------------------------------------------
export function isBlocking(w) {
  return w?.severity === 'blocking';
}
export function hasBlocking(warnings = []) {
  return warnings.some(isBlocking);
}