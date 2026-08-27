// ============================================================================
// LogbookAI — "Fix route timing" builder (deterministic, no AI, no DB writes).
// ----------------------------------------------------------------------------
// Shared by the canonical Logs RouteTimeConflictNotice AND the ProposalReview
// route-warning card. Reuses the EXISTING inspectProposalRoutes +
// reconstructDrivingDurations + detectTimelineRouteConflicts engines — there is
// NO second reconstruction algorithm for saved logs. Saved DutyStatusEvent
// records already carry field_provenance + start_timestamp/end_timestamp in the
// same shape the reconstruction engine expects, so the saved↔proposal-time
// adaptation is identity: the day's events are passed straight through.
//
// buildRouteTimingFix() runs the whole correction IN MEMORY and returns the
// before/after + remaining warnings for review. Nothing here persists — the
// caller persists the approved correction via timelineWriter.
// ============================================================================

import { inspectProposalRoutes, fetchRoute, DEFAULT_SPEED_PROFILE } from './proposalValidation';
import { detectTimelineRouteConflicts } from './routeAware';
import { reconstructDrivingDurations } from './drivingDurationReconstruction';
import { dateKeyInTz } from './hosEngine';

function dayEventsFor(events, dateStr, tz) {
  return (events || [])
    .filter((e) => e && e.start_timestamp && dateKeyInTz(new Date(e.start_timestamp), tz) === dateStr)
    .sort((a, b) => new Date(a.start_timestamp) - new Date(b.start_timestamp));
}

// Is at least one conflicted driving leg fixable (its end is AI-inferred)?
// Used by the notice/button to decide whether to show "Fix route timing".
export function hasFixableInferredLeg(legs) {
  return (legs || []).some(
    (leg) => leg?.evaluation?.conflict && leg?.event?.field_provenance?.end_time === 'inferred'
  );
}

// Build the full in-memory correction for a single day. Returns:
//   fixable            — at least one conflicted Driving leg has an inferred end
//   dayEvents          — the original day's events (before)
//   corrected          — the reconstructed day's events (after), timestamps only
//   changes            — per-event before/after diff (only events that moved)
//   remainingConflicts — route/time conflicts still present after the fix
//   gapConflicts       — route_time_gap conflicts from reconstruction; if any,
//                       manual review is required and no correction is forced
//   legs               — the routed legs (reused, no second routing engine)
export async function buildRouteTimingFix(events, { dateStr, tz, speedProfile = DEFAULT_SPEED_PROFILE, now = new Date(), routingProvider = fetchRoute } = {}) {
  const t = now instanceof Date ? now : new Date(now);
  const dayEvents = dayEventsFor(events, dateStr, tz);

  if (!dayEvents.some((e) => e.duty_status === 'DRIVING')) {
    return { fixable: false, reason: 'no-driving', dayEvents, corrected: dayEvents, changes: [], remainingConflicts: [], gapConflicts: [], legs: [] };
  }

  const legs = await inspectProposalRoutes(dayEvents, { routingProvider, speedProfile, now: t });
  const fixable = hasFixableInferredLeg(legs);
  if (!fixable) {
    return { fixable: false, reason: 'no-inferred', dayEvents, corrected: dayEvents, changes: [], remainingConflicts: [], gapConflicts: [], legs };
  }

  // Reconstruct in memory: replace inferred Driving ends with routed
  // truck-realistic travel time, cascade-shift subsequent inferred events,
  // and stop at the first explicit anchor. Explicit/unknown times never move.
  const { events: corrected, conflicts: reconstructionConflicts } = reconstructDrivingDurations(dayEvents, legs, { now: t });

  // Re-validate the corrected day against the route engine + structural checks.
  const remainingConflicts = await detectTimelineRouteConflicts(corrected, { dateStr, tz, profileId: speedProfile, now: t, routingProvider });
  const gapConflicts = (reconstructionConflicts || []).filter((c) => c.type === 'route_time_gap');

  const byId = new Map(dayEvents.map((e) => [e.id, e]));
  const changes = [];
  for (const ev of corrected) {
    if (!ev.id) continue;
    const before = byId.get(ev.id);
    if (!before) continue;
    const startChanged = (ev.start_timestamp || null) !== (before.start_timestamp || null);
    const endChanged = (ev.end_timestamp || null) !== (before.end_timestamp || null);
    if (!startChanged && !endChanged) continue;
    changes.push({
      id: ev.id,
      duty_status: ev.duty_status,
      city: ev.city,
      state: ev.state,
      beforeStart: before.start_timestamp,
      beforeEnd: before.end_timestamp,
      afterStart: ev.start_timestamp,
      afterEnd: ev.end_timestamp,
      startInferred: before.field_provenance?.start_time === 'inferred',
      endInferred: before.field_provenance?.end_time === 'inferred',
    });
  }

  return { fixable: true, dayEvents, corrected, changes, remainingConflicts, gapConflicts, legs };
}