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
  dateKeyInTz, hasSufficientCycleHistory, fmtDur,
  computeContiguousGoverningReset,
} from './hosEngine';
import { mergeProposedEvents, collectViolations, distanceReasonableness } from './logAssistant';
import { startOfDayInTz, normalizeTimeline, nextLocalMidnightInTz } from './timelineEngine';
import { describedMovementCoverage } from './narrativeMovements';
import { findAmbiguousCityIssues } from './ambiguousLocations';
import { applyStatedMileage } from './statedMileage';
import { normalizeCandidateTimeline } from './timelineNormalization';
import { cleanLocationText } from './locationPlaceholders';

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

// Planning-profile speed ceiling (mph). Mirrors planningMph in complianceStop
// but kept local here to avoid a circular import (complianceStop imports
// SPEED_PROFILES from this module). The profile caps the effective average
// speed used for travel-time derating.
export function profileMph(profileId = DEFAULT_SPEED_PROFILE) {
  const p = SPEED_PROFILES[profileId] || SPEED_PROFILES.conservative;
  if (p.mph) return p.mph;
  return p.id === 'provider' ? 50 : 55; // conservative -> 55 mph ceiling
}

// Route-aware truck-realistic travel time (hours) — the PRIMARY travel-time
// source whenever a real road route is available:
//   required_truck_time = max(provider_hours, route_miles / planningMph(profile))
// The profile caps effective speed, so a 70 mph freeway route is derated to the
// profile ceiling; a surface-street route already slower than the ceiling keeps
// the provider's duration. Mileage always comes from routed road distance,
// never from this time. truckEtaHours is kept as the export name for callers.
export function requiredTruckTime(route, profileId = DEFAULT_SPEED_PROFILE) {
  if (!route || route.miles == null) return null;
  const providerHours = typeof route.hours === 'number' ? route.hours : null;
  const profileHours = route.miles / profileMph(profileId);
  return providerHours != null ? Math.max(providerHours, profileHours) : profileHours;
}
export const truckEtaHours = requiredTruckTime;

// Deterministic tolerance for the route/time conflict. A proposed driving
// duration is only "impossibly fast" when it is shorter than the truck-realistic
// time by MORE than this tolerance, so rounding and minor routing noise do not
// false-flag plausible legs. We use the larger of 5 minutes (0.0833 h) or 5% of
// the required time — short legs get a fixed minute margin, longer routes a
// proportional one. A driver taking LONGER than the estimate is never flagged.
const ROUTE_TIME_TOL_MIN = 5 / 60;   // 5 minutes in hours
const ROUTE_TIME_TOL_PCT = 0.05;     // 5%
export function routeTimeTolerance(requiredHours) {
  if (requiredHours == null || !Number.isFinite(requiredHours)) return 0;
  return Math.max(ROUTE_TIME_TOL_MIN, ROUTE_TIME_TOL_PCT * requiredHours);
}

// Pure evaluator: given a road route {miles, hours} and the requested driving
// hours, decide whether the requested driving time is reasonable for a truck.
// CONFLICT DIRECTION (corrected): a conflict exists only when the proposed/
// inferred driving duration is SHORTER than the route realistically requires
// (minus tolerance) — i.e. the truck cannot physically cover the route that
// fast. A driver taking longer (traffic, stops) is NOT a conflict.
export function evaluateRouteReasonableness(route, requestedDrivingHours, profileId = DEFAULT_SPEED_PROFILE) {
  if (!route || route.miles == null) return { known: false };
  const baseEta = typeof route.hours === 'number' ? route.hours : null;
  const required = requiredTruckTime(route, profileId);
  const tolerance = routeTimeTolerance(required);
  const conflict = requestedDrivingHours != null && required != null && requestedDrivingHours < (required - tolerance);
  return {
    known: true,
    miles: Math.round(route.miles),
    baseEtaHours: baseEta,
    truckEtaHours: required,
    requiredTruckTime: required,
    toleranceHours: tolerance,
    requestedDrivingHours: requestedDrivingHours,
    planningProfile: profileId,
    planningProfileLabel: speedProfileLabel(profileId),
    conflict,
    note: conflict
      ? `Road route ~${Math.round(route.miles)} mi · realistic truck time ~${required.toFixed(1)} h (capped at ${profileMph(profileId)} mph). Proposed ${Number(requestedDrivingHours).toFixed(1)} h of driving is shorter than the route realistically requires.`
      : `Road route ~${Math.round(route.miles)} mi · realistic truck time ~${required.toFixed(1)} h. Proposed driving time is plausible.`,
  };
}

// Production routing provider: calls the existing tripEstimate backend
// (OSRM/Nominatim) for real road miles/ETA. Results are cached in-memory so
// repeated validation (ProposalReview + Logs timeline) does not re-bill
// routing credits. Failures are NOT cached — a transient outage retries on the
// next validation rather than poisoning the session.
const routeCache = new Map();
export function clearRouteCache() { routeCache.clear(); }

export async function fetchRoute(origin, destination) {
  if (!origin || !destination) return null;
  const key = `${origin}||${destination}`;
  if (routeCache.has(key)) return routeCache.get(key);
  const { base44 } = await import('@/api/base44Client');
  let res;
  try {
    res = await base44.functions.invoke('tripEstimate', { origin, destination });
  } catch (e) {
    return null; // do not cache failures
  }
  const d = res?.data || res;
  if (!d || d.error) return null; // do not cache failures
  const route = { miles: d.miles, hours: d.hours, notes: d.notes, isTruckRoute: d.is_truck_route };
  routeCache.set(key, route);
  return route;
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
      type: 'location_time_conflict', severity: 'review', title: 'LOCATION / TIME CONFLICT',
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
  const { cycleType = '70_8', tz = 'UTC', now = new Date(), isFuture = null, enteredPriorHistory = false } = opts;
  const t = now instanceof Date ? now : new Date(now);
  const rawMerged = mergeProposedEvents(existing, proposed, t);
  // NORMALIZE the candidate timeline before any downstream check runs: close
  // any still-open event (e.g. a stale existing "current status" the driver
  // never closed out) against the next event's start, and truncate an
  // inferred/defaulted end that runs past a later boundary. This never moves
  // an explicit fact — a genuine explicit-vs-explicit contradiction is
  // reported as its own blocking conflict instead of silently resolved, and
  // instead of the generic overlap check's arbitrary, confusing pairing.
  const { events: merged, conflicts: boundaryConflicts } = normalizeCandidateTimeline(rawMerged, { now: t });

  const warnings = [];
  warnings.push(...boundaryConflicts);
  const explicitGuard = opts.explicitGuard || null;
  // GATE 1 (structural): altered/dropped explicit driver facts remain BLOCKING —
  // they change the legal record. Visible adjustments are review-only (never
  // block) so the driver can confirm an inferred/adjusted proposal in one tap.
  if (explicitGuard?.blocking) {
    warnings.push({
      type: 'explicit_fact_guard', severity: 'blocking', title: 'EXPLICIT DRIVER FACT CHANGED OR MISSING',
      // Each issue's actual flagged value is always included, not just the
      // generic reason sentence — several issues sharing the same reason
      // text (e.g. multiple dropped times) must never render as that one
      // sentence repeated with no indication of WHICH values are the problem.
      message: [...(explicitGuard.alteredExplicitFacts || []), ...(explicitGuard.droppedExplicitEvents || [])]
        .map(issue => `${issue.reason || `${issue.field || issue.type}: review required`}${issue.value ? ` ("${issue.value}")` : ''}`).join(' '),
    });
  }
  for (const adjustment of (explicitGuard?.visibleAdjustments || [])) {
    warnings.push({
      type: 'explicit_adjustment', severity: 'review', title: 'DRIVER FACT ADJUSTED — REVIEW',
      message: `${adjustment.field}: adjusted from ${adjustment.original_stated_value} to ${adjustment.adjusted_value}. ${adjustment.reason || ''}`.trim(),
      eventIndex: adjustment.eventIndex,
    });
  }
  // Approximate driver times that landed outside the tolerance window are a
  // review note, never a blocker — the driver themselves signaled an estimate.
  for (const mismatch of (explicitGuard?.approximateMismatches || [])) {
    warnings.push({
      type: 'time_approximate_review', severity: 'review', title: 'APPROXIMATE TIME — REVIEW',
      message: mismatch.reason,
    });
  }
  // Fabricated / unspecified driving starts and unrequested rest / pre-trip
  // events — AI proposals only (gated on the explicit guard, which only an AI
  // proposal carries), recomputed on the proposal as edited so a driver who
  // fixes the start time in Edit Proposal immediately unlocks Apply.
  if (explicitGuard) {
    warnings.push(...findFabricatedTimestampIssues(proposed, opts.narrative || ''));
  }
  // Described-movement gate: if the driver explicitly described a driving
  // movement (A→B) the proposal omits, block Apply until the missing Driving
  // event is added. Never invents driving from a bare city difference — only
  // blocks when the narrative/provenance actually described the movement.
  if (opts.narrative) {
    warnings.push(...describedMovementCoverage(proposed, opts.narrative, opts.provenance || {}));
  }
  // Ambiguous-city gate: a city that exists in several states with no state
  // given/supported is never silently resolved — the driver picks the state.
  // Otherwise the log, mileage and route-time check would all describe
  // whichever place the geocoder happened to rank first.
  for (const issue of findAmbiguousCityIssues(proposed, existing, opts.narrative || '')) {
    warnings.push({
      type: 'ambiguous_city', severity: 'blocking', title: 'WHICH STATE?',
      message: `${issue.reason} Edit the proposal and set the correct city/state before confirming — LogbookAI will not guess.`,
      eventIndex: issue.eventIndex,
      city: issue.city,
    });
  }
  // A pair already reported as an explicit-vs-explicit boundary conflict
  // above is deliberately left un-truncated (rule 4/5) so the driver sees
  // exactly what's wrong — suppress the generic overlap check's duplicate,
  // less-specific report of that SAME pair (never suppress a different one).
  const boundaryConflictStarts = new Set(
    boundaryConflicts.map((c) => `${c.eventA?.start_timestamp}|${c.eventB?.start_timestamp}`)
  );
  warnings.push(...findOverlaps(merged, t).filter(
    (w) => !boundaryConflictStarts.has(`${w.aStart?.toISOString?.()}|${w.bStart?.toISOString?.()}`)
  ));
  warnings.push(...findLocationConflicts(merged, t));

  const pretrip = needsPreTrip(merged, t);
  if (pretrip.required) {
    warnings.push({
      type: 'pretrip', severity: 'review', title: 'PRE-TRIP CHECK',
      message: 'You are starting a Driving period. Did you perform your pre-trip vehicle inspection before driving?',
      options: ['Yes — Add Pre-Trip', 'Already recorded / satisfied', 'Go Back'],
      drivingStart: pretrip.drivingStart,
    });
  }

  // DST-correct proposal evaluation endpoint. The proposed log day ends at the
  // NEXT local midnight in the carrier timezone after the proposal log date —
  // never at the device clock. evalNow = min(that day-end, deviceNow). A past
  // proposal day evaluates at its day-end; the current day at now (capped at
  // day-end). This prevents the cross-day 50h+ 14h-window artifact at the eval
  // boundary. (deviceNow = opts.now, which the caller sets to max(now, last
  // proposed end) so future-plan projection is preserved within the day.)
  const firstPropStart = (proposed || [])[0]?.start_timestamp;
  const proposalLogDate = firstPropStart ? dateKeyInTz(new Date(firstPropStart), tz) : dateKeyInTz(t, tz);
  const dayEnd = nextLocalMidnightInTz(proposalLogDate, tz);
  const evalNow = new Date(Math.min(dayEnd.getTime(), t.getTime()));

  const historyComplete = hasSufficientCycleHistory(merged, cycleType, enteredPriorHistory, tz, evalNow);

  // Contiguous backward-walk governing anchor for the 14h/11h clocks
  // (proposal-only restriction). Walk BACKWARD from the first proposed Driving
  // event through the chronologically contiguous normalized merged timeline;
  // stop at the first unresolved gap / same-start conflict / continuity
  // boundary (~1s tolerance). Most-recent valid split-sleeper pair wins, else
  // the most recent single ≥10h reset, else 'unverified' (never reaching
  // through a discontinuity to an older reset). Cycle keeps full history.
  const norm = normalizeTimeline(merged, evalNow);
  const firstProposedDriveMs = (proposed || [])
    .filter(p => p.duty_status === 'DRIVING' && p.start_timestamp)
    .map(p => new Date(p.start_timestamp).getTime())
    .reduce((min, x) => (min == null || x < min ? x : min), null);
  const contiguousGov = (firstProposedDriveMs != null && Number.isFinite(firstProposedDriveMs))
    ? computeContiguousGoverningReset(norm.segments, new Date(firstProposedDriveMs), evalNow, norm.conflicts)
    : null;
  const govOpts = contiguousGov && contiguousGov.unverified
    ? { windowUnverified: true, windowUnverifiedReason: contiguousGov.reason }
    : (contiguousGov ? { governingOverride: contiguousGov } : {});

  const hos = computeHOS(merged, cycleType, tz, evalNow, { historyComplete, ...govOpts });
  const issues = runComplianceCheck(merged, cycleType, tz, evalNow, { historyComplete, ...govOpts });
  const violations = collectViolations(hos, issues);

  // Surface canonical structural-validation failures (gaps, same-start
  // conflicts, negative durations, daily-total violations) already detected
  // by validateTimeline inside computeHOS as BLOCKING warnings, so the existing
  // two-gate Apply lock catches them. The "--" HOS display is NOT itself a
  // blocker — the canonical structural invalidity is.
  if (!hos.calculable && hos.validity?.issues?.length) {
    for (const issue of hos.validity.issues) {
      if (issue.severity !== 'blocking') continue;
      // Coverage gaps (elapsed_gap / daily shortfalls) are review-level, never
      // blocking: a missing stretch of the day does not invalidate the entries
      // that ARE logged — the driver saves what they have and the gap stays
      // visible on the saved log for correction. Structural contradictions
      // (duplicates, same-start conflicts, negative durations) stay blocking.
      const isCoverageGap = issue.type === 'elapsed_gap' || issue.type === 'daily_total';
      warnings.push({
        type: issue.type || 'structural',
        severity: isCoverageGap ? 'review' : 'blocking',
        title: 'TIMELINE STRUCTURE',
        message: issue.message,
        ...(isCoverageGap ? { hint: 'You can still add these events. The gap stays on the saved log so you can fill it in later.' } : {}),
      });
    }
  }

  const br = breakStatus(merged, evalNow);
  const future = isFuture != null ? isFuture : ((proposed || [])[0]?.start_timestamp ? new Date((proposed || [])[0].start_timestamp) > t : false);
  if (br.required) {
    warnings.push({
      type: 'break30', severity: 'review', title: '30-MINUTE BREAK REQUIRED',
      message: future
        ? 'This plan exceeds 8 cumulative hours of Driving without a qualifying 30-minute interruption. Add a planned qualifying stop (Off Duty, Sleeper Berth, or On Duty — Fuel/meal/rest) before the threshold. Labeled PLANNED — NOT YET LOGGED.'
        : 'Your actual timeline shows more than 8 cumulative hours of Driving without a qualifying 30-minute interruption. Did a real stop or break occur that was omitted? If so, enter the actual event. LogbookAI will not fabricate a break to remove the violation.',
      isFuture: future,
      drivingAccumulatedMs: br.drivingAccumulatedMs,
      remainingBeforeBreakMs: br.remainingBeforeBreakMs,
    });
  }

  // Contiguous-walk review notices (never blocking): (1) when the rest period
  // immediately before driving had an inferred start but a qualifying anchor
  // was found contiguously further back, flag the inferred start; (2) when no
  // qualifying split or ≥10h anchor was reached contiguously, surface the
  // 14h/11h unverified state so the driver knows the clocks are not confirmed.
  if (contiguousGov && contiguousGov.inferredRestNote && !contiguousGov.unverified) {
    warnings.push({
      type: 'inferred_rest_start', severity: 'review', title: 'INFERRED REST START',
      message: contiguousGov.inferredRestNote,
    });
  }
  if (contiguousGov && contiguousGov.unverified && hos.calculable) {
    warnings.push({
      type: 'rest_history_unverified', severity: 'review', title: 'HOS REST HISTORY UNVERIFIED',
      message: 'The rest history immediately before your driving could not be verified contiguously (a gap or conflict in the timeline). The 14-hour window and 11-hour driving clocks are shown as unverified until the timeline is continuous back to a qualifying reset or split-sleeper pair.',
    });
  }

  // Future-dated ACTUAL event (review only): the Tell flow records what
  // already happened, so a proposed start in the future usually means a
  // past-tense statement ("went to bed at 10 pm", said in the morning) was
  // resolved to TONIGHT instead of last night. Only when the caller did not
  // explicitly mark this a plan (isFuture opt unset).
  const FUTURE_TOL_MS = 10 * 60000;
  if (isFuture == null) {
    const firstFuture = (proposed || []).find((p) => p && p.start_timestamp && new Date(p.start_timestamp).getTime() > t.getTime() + FUTURE_TOL_MS);
    if (firstFuture) {
      warnings.push({
        type: 'future_event', severity: 'review', title: 'FUTURE-DATED EVENT',
        message: `An event starts at ${fmtClock(new Date(firstFuture.start_timestamp))}, which is still in the future. LogbookAI logs what already happened — if you meant earlier (e.g. last night), edit the time before confirming.`,
      });
    }
  }

  return { merged, warnings, violations, hos, break: br, pretrip, evalNow, isFuture: future, historyComplete, contiguousGov };
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

export function computeProposalTotals(proposedEvents, dateStr, timezone, evaluationBoundary = new Date()) {
  const dayStart = startOfDayInTz(new Date(`${dateStr}T12:00:00Z`), timezone);
  const dayEnd = new Date(dayStart.getTime() + 24 * H);
  const evaluationEnd = evaluationBoundary instanceof Date ? evaluationBoundary : new Date(evaluationBoundary);
  const totalsMs = { OFF_DUTY: 0, SLEEPER_BERTH: 0, DRIVING: 0, ON_DUTY: 0 };
  for (const event of (proposedEvents || [])) {
    if (!Object.prototype.hasOwnProperty.call(totalsMs, event.duty_status) || !event.start_timestamp) continue;
    const start = new Date(event.start_timestamp);
    const isRestOfDay = /rest of (?:the )?day/i.test(`${event.activity_type || ''} ${event.remark || ''}`);
    const openEnd = isRestOfDay ? dayEnd : (evaluationEnd < dayEnd ? evaluationEnd : dayEnd);
    const end = event.end_timestamp ? new Date(event.end_timestamp) : openEnd;
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

// A location is usable as a leg endpoint when it has a non-empty trimmed city.
// State is carried through but not required to be non-empty.
function usableLocation(ev) {
  return !!ev && cleanLocationText(ev.city) !== '';
}
function locOf(ev) {
  return { city: String(ev?.city || '').trim(), state: String(ev?.state || '').trim().toUpperCase() };
}

// Derive the route leg for a Driving event from its NON-DRIVING neighbors:
//   origin      = nearest preceding event (status != DRIVING) with a usable city/state
//   destination = nearest following  event (status != DRIVING) with a usable city/state
// The Driving event's own city/state is only a fallback when the relevant
// neighbor is genuinely unavailable. This is robust to the AI convention of
// storing the destination (not the origin) on the Driving event, and to the
// origin-on-Driving convention. Consecutive Driving events with no usable
// non-driving event between them do NOT chain — each Driving falls back to its
// own city for the missing side, surfacing ambiguity rather than fabricating
// movement.
export function getDrivingLegs(proposed, now = new Date()) {
  const source = proposed || [];
  const sorted = source.filter(event => event.start_timestamp)
    .sort((a, b) => new Date(a.start_timestamp) - new Date(b.start_timestamp));
  return sorted.map((event, index) => {
    if (event.duty_status !== 'DRIVING') return null;
    const destinationEvent = sorted[index + 1];
    const isOngoing = !event.end_timestamp;
    const end = event.end_timestamp ? new Date(event.end_timestamp) : now;

    let origin = null;
    for (let i = index - 1; i >= 0; i--) {
      if (sorted[i].duty_status === 'DRIVING') continue;
      if (usableLocation(sorted[i])) { origin = locOf(sorted[i]); break; }
    }
    if (!origin) origin = locOf(event);

    // destinationKnown is true only when a REAL following non-driving event
    // supplied the destination. When it falls back to the Driving event's own
    // city (no genuine destination described), route/travel-time physics
    // cannot be evaluated — that fallback is metadata inheritance, not a
    // reported arrival point.
    let destination = null;
    let destinationKnown = false;
    for (let i = index + 1; i < sorted.length; i++) {
      if (sorted[i].duty_status === 'DRIVING') continue;
      if (usableLocation(sorted[i])) { destination = locOf(sorted[i]); destinationKnown = true; break; }
    }
    // No following non-driving event names the arrival: fall back to the
    // destination the driver stated FOR THIS LEG (AI destination_city/state).
    // A following event always wins, so existing behavior is unchanged.
    if (!destination && cleanLocationText(event.destination_city) !== '') {
      destination = locOf({ city: event.destination_city, state: event.destination_state });
      destinationKnown = true;
    }
    if (!destination) destination = locOf(event);

    return {
      event,
      eventIndex: source.indexOf(event),
      origin,
      destination,
      destinationKnown,
      isOngoing,
      drivingHours: Math.max(0, (end - new Date(event.start_timestamp)) / H),
      nextExplicitStartMs: destinationEvent?.start_timestamp ? new Date(destinationEvent.start_timestamp).getTime() : null,
    };
  }).filter(Boolean);
}

export async function inspectProposalRoutes(proposed, { routingProvider = fetchRoute, speedProfile = DEFAULT_SPEED_PROFILE, now = new Date() } = {}) {
  const legs = getDrivingLegs(proposed, now);
  return Promise.all(legs.map(async (leg) => {
    const origin = formatLocation(leg.origin.city, leg.origin.state);
    const destination = formatLocation(leg.destination.city, leg.destination.state);
    // Route/travel-time physics only apply to a COMPLETED leg with a real,
    // distinct destination. Skip entirely when: the Driving event is still
    // ongoing (no arrival has happened yet to validate); or no genuine
    // destination was described (destinationKnown is false, so "destination"
    // is only the Driving event's own start city inherited by fallback) —
    // otherwise a bare "then I started driving" with no destination gets
    // manufactured into a same-city "conflict" against elapsed/now time.
    if (leg.isOngoing || !leg.destinationKnown) {
      return { ...leg, origin, destination, route: null, evaluation: { known: false } };
    }
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
    // Inferred-arrival case: the driving leg has no explicit end, so its
    // arrival is inferred as start + required_truck_time. If the next explicit
    // event begins before that inferred arrival (beyond tolerance), the route
    // cannot physically complete before the next known fact — a conflict.
    // Explicit driver-entered times are never rewritten; this only surfaces.
    if (evaluation.known && !leg.event.end_timestamp && leg.nextExplicitStartMs != null && evaluation.requiredTruckTime != null) {
      const startMs = new Date(leg.event.start_timestamp).getTime();
      const inferredArrivalMs = startMs + evaluation.requiredTruckTime * H;
      const tolMs = routeTimeTolerance(evaluation.requiredTruckTime) * H;
      if (leg.nextExplicitStartMs < inferredArrivalMs - tolMs) {
        evaluation.conflict = true;
        evaluation.note = `Road route ~${evaluation.miles} mi · realistic truck time ~${evaluation.requiredTruckTime.toFixed(1)} h. The inferred arrival would fall after the next logged event — review the times or add the missing stop.`;
      }
    }
    return { ...leg, origin, destination, route, evaluation };
  }));
}

// MILEAGE RULE: a speed x elapsed-driving-time ESTIMATE is only ever a
// reasonable stand-in for a real road route when a real origin AND a real
// destination are both known and the leg has actually completed — i.e. the
// routing service itself failed/was unavailable for a trip that DID happen.
// An ONGOING Driving event (no end yet) or a DESTINATIONLESS one (no genuine
// following non-driving event supplied an arrival city — see getDrivingLegs)
// has no endpoint LogbookAI actually knows. "elapsed time x assumed mph" for
// that case is not an estimate of anything real — it is fabricated mileage
// for a trip whose destination is unknown. Mileage stays unknown until a
// real destination exists (route-estimated), an actual odometer reading
// exists, or the driver enters it manually.
function canEstimateMileage(leg) {
  return !!(leg.destinationKnown && !leg.isOngoing);
}

export async function enrichProposalMileage(proposed, opts = {}) {
  const legs = await inspectProposalRoutes(proposed, opts);
  const speed = fallbackMph(opts.speedProfile || DEFAULT_SPEED_PROFILE);
  let events = (proposed || []).map(event => ({ ...event }));
  for (const leg of legs) {
    const routeMiles = Number(leg.route?.miles);
    const hasRoadMiles = Number.isFinite(routeMiles) && routeMiles > 0.5;
    const canEstimate = canEstimateMileage(leg);
    events[leg.eventIndex] = {
      ...events[leg.eventIndex],
      mileage: hasRoadMiles ? routeMiles : (canEstimate ? leg.drivingHours * speed : null),
      mileage_source: hasRoadMiles ? 'route' : (canEstimate ? 'estimate' : 'unknown'),
      route_origin: leg.origin,
      route_destination: leg.destination,
    };
  }
  // A mileage figure the DRIVER stated ("I drove 230 miles from Miami to
  // Orlando") is kept as the event's mileage — never overwritten by the map's
  // number. It is only compared to the route (see statedMileageWarnings).
  if (opts.narrative) events = applyStatedMileage(events, legs, opts.narrative);
  return {
    events,
    legs,
    totalMiles: events.reduce((sum, event) => sum + (event.duty_status === 'DRIVING' && event.mileage != null && Number.isFinite(Number(event.mileage)) ? Number(event.mileage) : 0), 0),
  };
}

// A conflicting leg is only a HARD blocker when the AI may have guessed one of
// the two endpoint times (start or end marked "inferred", or provenance not
// recorded at all — treated conservatively as not-yet-confirmed). When the
// DRIVER explicitly stated BOTH the start and end time, LogbookAI must never
// hard-block or silently move that fact just because route physics find it
// unusual — the route estimate is a plausibility check, not the authoritative
// record of how long the trip actually took. Those legs instead require an
// explicit driver acknowledgment (see ProposalReview.jsx) before Apply unlocks.
function isFullyExplicitLeg(leg) {
  const fp = leg?.event?.field_provenance;
  return fp?.start_time === 'explicit' && fp?.end_time === 'explicit';
}

export async function addRouteWarning(proposed, { routingProvider = fetchRoute, speedProfile = DEFAULT_SPEED_PROFILE, now = new Date(), isFuture = true, legs: providedLegs = null } = {}) {
  const legs = providedLegs || await inspectProposalRoutes(proposed, { routingProvider, speedProfile, now });
  if (!legs.length) return null;
  // An ongoing or destinationless leg was intentionally skipped by
  // inspectProposalRoutes (evaluation.known === false, no error) — there is no
  // completed trip to validate yet, so it never contributes a route warning.
  // A genuine lookup failure (leg.error set, e.g. an unrecognized city) still
  // surfaces below.
  const evaluableLegs = legs.filter(leg => leg.evaluation?.known !== false || leg.error);
  if (!evaluableLegs.length) return null;
  const conflicts = evaluableLegs.filter(leg => leg.evaluation?.conflict);
  // Split conflicts by provenance: fully-explicit legs get a review-and-
  // acknowledge treatment; anything involving an inferred endpoint stays a
  // hard blocker (the AI may have guessed wrong — "Fix route timing" or a
  // manual edit is the correct remedy there, never a silent driver-fact change).
  const blockingConflicts = conflicts.filter(leg => !isFullyExplicitLeg(leg));
  const explicitConflictLegs = conflicts.filter(isFullyExplicitLeg);
  const details = evaluableLegs.map(leg => `${leg.origin || 'Unknown'} → ${leg.destination || 'Unknown'}: ${leg.evaluation?.known ? leg.evaluation.note : 'Road route unavailable; mileage will be labeled as an estimate.'}`);
  const title = blockingConflicts.length ? 'ROUTE / TRAVEL-TIME CONFLICT — REVIEW'
    : explicitConflictLegs.length ? 'ROUTE TIMING LOOKS UNUSUAL'
      : 'ROUTE VALIDATION';
  // A conflict-free validation is INFORMATIONAL, not a warning: every proposed
  // driving segment checked out against its road route. severity 'success'
  // keeps ProposalReview from counting it as an amber review item (or
  // persisting it as a saved review note) while the card itself still shows
  // the driver exactly what was checked.
  return {
    type: 'route_reasonableness',
    severity: blockingConflicts.length ? 'blocking' : (explicitConflictLegs.length ? 'review' : 'success'),
    isInformational: !blockingConflicts.length && !explicitConflictLegs.length,
    title,
    message: details.join(' '),
    isFuture,
    legs,
    blockingConflicts,
    explicitConflictLegs,
    requiresAcknowledgment: explicitConflictLegs.length > 0,
    note: blockingConflicts.length
      ? 'Routing is a reasonableness check only. Review the factual times and locations, then confirm if correct. Estimated mileage is clearly labeled.'
      : explicitConflictLegs.length
        ? 'These times were provided by you. Route calculations are a plausibility check, not an authoritative record of exactly how long the trip took.'
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
// FABRICATED / UNSPECIFIED DRIVING START + UNREQUESTED REST / PRE-TRIP EVENTS.
// ----------------------------------------------------------------------------
// The AI may only propose a driving start time the driver stated or a clearly
// labeled inference can establish. Three deterministic failures must never
// reach the saved log:
//   1. MIDNIGHT PLACEHOLDER — a DRIVING start at exactly 12:00 AM the driver
//      never stated (no midnight/12 AM wording in the narrative) is only a
//      placeholder for a missing start time. Blocked until the driver states
//      the actual start — in the narrative (clarification reply) or by editing
//      the event here (which marks it driver-confirmed).
//   2. UNLABELED FABRICATION — when the narrative states NO times at all, a
//      DRIVING start that is not provenance-tagged "inferred" (claimed
//      explicit, or no provenance at all) is an invented time. Blocked.
//   3. UNREQUESTED REST / PRE-TRIP — an OFF_DUTY/SLEEPER_BERTH event (or a
//      pre-trip) the driver never described is fabricated activity. Blocked
//      unless the narrative mentions rest/pre-trip or the driver added the
//      event themselves.
// Runs ONLY for AI proposals (gated on the explicit guard, which only an AI
// proposal carries) — manual timeline edits are the driver's own words and are
// never second-guessed here. Recomputed on the proposal AS EDITED, so a driver
// who fixes the start time in Edit Proposal immediately unlocks Apply.
// ---------------------------------------------------------------------------
const FAB_STATED_TIME_RE = /\b\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)\b|\b\d{1,2}:\d{2}\b|\bmidnight\b/i;
const FAB_STATED_MIDNIGHT_RE = /\b(?:midnight|12\s*a\.?m\.?|00:00)\b/i;
const FAB_REST_WORDING_RE = /\b(?:off[ -]?duty|fuera de servicio|sleeper|litera|dormitorio|slept|sleep(?:ing)?|rest(?:ed|ing)?|descans\w*|to bed|in bed|overnight|day off|10[- ]hour|34[- ]hour|reset|vacation|holiday|home time)\b/i;
const FAB_PRETRIP_WORDING_RE = /\bpre[- ]?trip\b|inspecci[oó]n previa/i;
const clockWallOf = (v) => {
  const m = String(v || '').match(/T(\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : '';
};

export function findFabricatedTimestampIssues(proposed, narrative = '') {
  const issues = [];
  const text = String(narrative || '');
  const driverStatedAnyTime = FAB_STATED_TIME_RE.test(text);
  const driverStatedMidnight = FAB_STATED_MIDNIGHT_RE.test(text);
  const restWording = FAB_REST_WORDING_RE.test(text);
  const pretripWording = FAB_PRETRIP_WORDING_RE.test(text);
  for (const [eventIndex, event] of (proposed || []).entries()) {
    if (!event || !event.start_timestamp) continue;
    // The driver's own explicit entry (edited here in review, or added by hand)
    // is by definition driver-confirmed — never flagged.
    if (event.driver_confirmed_times || event.driver_confirmed_status) continue;
    if (event.source === 'manual' || event.method_of_creation === 'Manual') continue;
    const provenance = event.field_provenance || {};
    const clock = clockWallOf(event.start_time_local || event.start_timestamp);
    if (event.duty_status === 'DRIVING' && clock === '00:00' && !driverStatedMidnight) {
      issues.push({
        type: 'fabricated_midnight_start', severity: 'blocking', title: 'DRIVING START TIME NOT SPECIFIED',
        message: 'You did not state when this driving started, so 12:00 AM is only a placeholder. Tell LogbookAI the actual start time, or edit the event below and set it — it cannot be saved as-is.',
        eventIndex,
      });
      continue;
    }
    if (event.duty_status === 'DRIVING' && !driverStatedAnyTime && provenance.start_time !== 'inferred') {
      issues.push({
        type: 'fabricated_start_time', severity: 'blocking', title: 'DRIVING START TIME NOT SPECIFIED',
        message: 'You did not state a start time, and this proposal does not clearly mark where its start time came from. Provide the actual start time before saving.',
        eventIndex,
      });
    }
    if ((event.duty_status === 'OFF_DUTY' || event.duty_status === 'SLEEPER_BERTH') && !restWording) {
      issues.push({
        type: 'unrequested_rest_event', severity: 'blocking', title: 'UNREQUESTED OFF-DUTY / SLEEPER EVENT',
        message: 'You never described any off-duty or sleeper time, but the proposal includes one. Edit the proposal to remove or correct it, or re-ask LogbookAI without it.',
        eventIndex,
      });
    }
    if (event.duty_status === 'ON_DUTY' && /pre[- ]?trip/i.test(`${event.activity_type || ''} ${event.remark || ''}`) && !pretripWording) {
      issues.push({
        type: 'unrequested_pretrip', severity: 'blocking', title: 'UNREQUESTED PRE-TRIP EVENT',
        message: 'You did not mention a pre-trip inspection, but the proposal includes one. Remove it or confirm you actually did it before saving.',
        eventIndex,
      });
    }
  }
  return issues;
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

// ---------------------------------------------------------------------------
// THREE-STATE HOS DISPLAY (canonical, testable).
// Mirrors Today / Compliance / What-Can-I-Do / Trip: real values when the
// timeline is calculable, real 0 (with the deterministic violation shown
// separately by the caller) when a clock is genuinely exhausted, and "--"
// when HOS is unavailable/unverified. Never presents the engine's
// uncalculable placeholder 0 as confirmed exhaustion.
//   state ∈ {'unavailable','unverified','real','exhausted'}
// ---------------------------------------------------------------------------
export function deriveHosDisplay(hos, historyComplete) {
  const calculable = !!(hos?.calculable && hos?.validity?.valid);
  const unavailable = { value: '--', note: 'HOS unavailable—review timeline', state: 'unavailable' };
  if (!calculable) {
    return { calculable: false, driving: unavailable, window14: unavailable, break: unavailable, cycle: unavailable };
  }
  const driving = (() => {
    if (hos.driving?.unverified) return { value: '--', note: hos.driving.unverifiedReason || 'Unverified — rest history before driving is not contiguous', state: 'unverified' };
    const rem = hos.driving.drivingRemainingMs;
    if (!hos.driving.applicable) return { value: fmtDur(rem), note: 'No tour started yet', state: 'real' };
    if (rem <= 0) return { value: fmtDur(0), note: 'Exhausted — 11-hr limit', state: 'exhausted' };
    return { value: fmtDur(rem), note: '11-hr limit', state: 'real' };
  })();
  const window14 = (() => {
    if (hos.window14?.unverified) return { value: '--', note: hos.window14.unverifiedReason || 'Unverified — rest history before driving is not contiguous', state: 'unverified' };
    const rem = hos.window14.remainingMs;
    if (!hos.window14.applicable) return { value: fmtDur(rem), note: 'No tour started yet', state: 'real' };
    if (rem <= 0) return { value: fmtDur(0), note: 'Window closed', state: 'exhausted' };
    return { value: fmtDur(rem), note: '14-hr window', state: 'real' };
  })();
  const breakStatus = (() => {
    const br = hos.break30 || {};
    return { value: br.satisfied ? 'Satisfied' : (br.breakRequired ? 'Required' : 'Not yet'), note: '', state: 'real' };
  })();
  const cycle = (() => {
    if (!historyComplete) return { value: '--', note: 'Cycle unverified — prior history incomplete', state: 'unverified' };
    const rem = hos.cycle.cycleRemainingHours;
    if (rem <= 0) return { value: '0.0 hr', note: `${hos.cycle.cycleUsedHours.toFixed(1)} used`, state: 'exhausted' };
    return { value: `${rem.toFixed(1)} hr`, note: `${hos.cycle.cycleUsedHours.toFixed(1)} used`, state: 'real' };
  })();
  return { calculable: true, driving, window14, break: breakStatus, cycle };
}