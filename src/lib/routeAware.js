// ============================================================================
// LogbookAI — SHARED route-aware conflict detection.
// ----------------------------------------------------------------------------
// Single source of truth for route/time conflict logic used by BOTH
// ProposalReview (blocking warning before Apply) and the canonical Logs
// timeline (notice during certification). Both surfaces call the same
// inspectProposalRoutes + evaluateRouteReasonableness pipeline from
// proposalValidation, so they never calculate a conflict differently.
//
// Mileage is routed road distance; travel time is the truck-realistic derate
//   required_truck_time = max(provider_hours, route_miles / planningMph(profile))
// A conflict surfaces ONLY when a driving duration is shorter than the route
// allows (minus a documented tolerance) — a slower drive is never flagged.
// Explicit driver-entered times are never rewritten.
// ============================================================================

import { inspectProposalRoutes, fetchRoute, DEFAULT_SPEED_PROFILE } from './proposalValidation';
import { dateKeyInTz } from './hosEngine';

// Events belonging to the given log day in the driver's terminal tz. Inlined
// here (rather than imported from tripSync) to avoid an eager base44Client
// import that references `window` and breaks the Node test environment; the
// logic is identical to tripSync.dayEvents.
function dayEvents(events, dateStr, tz) {
  return (events || [])
    .filter(e => e.start_timestamp)
    .map(e => ({ ...e, _start: new Date(e.start_timestamp) }))
    .filter(e => dateKeyInTz(e._start, tz) === dateStr)
    .sort((a, b) => a._start - b._start);
}

// Conflict notices for the canonical (saved) log of a single day. Reuses the
// exact same per-leg routing + derate + conflict logic ProposalReview uses for
// proposed events, so the two surfaces always agree.
export async function detectTimelineRouteConflicts(events, { dateStr, tz, profileId = DEFAULT_SPEED_PROFILE, now = new Date(), routingProvider = fetchRoute } = {}) {
  const day = dayEvents(events, dateStr, tz);
  if (!day.some(e => e.duty_status === 'DRIVING')) return [];
  const legs = await inspectProposalRoutes(day, { routingProvider, speedProfile: profileId, now });
  return legs
    .filter(leg => leg.evaluation?.conflict)
    .map(leg => ({
      origin: leg.origin,
      destination: leg.destination,
      miles: leg.evaluation?.miles,
      requiredHours: leg.evaluation?.requiredTruckTime,
      proposedHours: leg.evaluation?.requestedDrivingHours,
      message: leg.evaluation?.note,
      // Expose provenance so the notice can show a "Fix route timing" button
      // only when the conflicted driving end was AI-inferred (movable). Absent
      // on legacy logs (no field_provenance) -> not inferred -> not fixable.
      eventIndex: leg.eventIndex,
      endInferred: leg.event?.field_provenance?.end_time === 'inferred',
    }));
}