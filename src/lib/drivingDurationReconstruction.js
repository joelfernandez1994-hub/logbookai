// ============================================================================
// LogbookAI — ROUTE-AWARE DRIVING DURATION RECONSTRUCTION (deterministic).
// ----------------------------------------------------------------------------
// For AI-generated proposals, replace INFERRED Driving durations (the driver
// did not state an arrival time) with routed truck-realistic travel time, and
// cascade-shift subsequent inferred events to match. Explicit driver-provided
// timestamps are NEVER moved. Routed mileage is NEVER reduced to fit an old
// inferred timestamp — only the inferred duration grows/shrinks to match the
// route. Runs at proposal time only (before ProposalReview), so already-applied
// AI logs are not retroactively rewritten.
//
// No AI, no DB writes, no routing calls of its own: it consumes the routed
// legs already produced by enrichProposalMileage/inspectProposalRoutes.
//
// Provenance source: the field_provenance flags (start_time/end_time =
// 'explicit' | 'inferred') emitted by manualLogAssistant and carried through
// aiLayer.js. A timestamp with no flag (e.g. deterministic-parser events) is
// treated as explicit/unknown and never shifted.
// ============================================================================

const H = 3600000;
const MIN = 60000;
// A gap between the route-derived end of an inferred block and the next explicit
// anchor larger than this is surfaced for review. Smaller gaps are rounding.
const GAP_THRESHOLD_MS = 5 * MIN;

function isInferred(provenance, field) {
  return provenance?.[field] === 'inferred';
}

function fmtClock(iso) {
  try {
    return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  } catch {
    return '--';
  }
}

function fmtLoc(ev) {
  return [ev.city, ev.state].filter(Boolean).join(', ') || 'this location';
}

function buildGapConflict(anchorEv, gapMs) {
  const mins = Math.round(gapMs / MIN);
  return {
    type: 'route_time_gap',
    severity: 'review',
    title: 'ROUTE / TIME GAP — REVIEW',
    message:
      `Route-based driving ended ${mins} min before your next logged event ` +
      `(${fmtLoc(anchorEv)} at ${fmtClock(anchorEv.start_timestamp)}). ` +
      `There may be unrecorded time between them — review the times or add the missing event.`,
  };
}

// A route-extended Driving block can push a following event's INFERRED start past
// that event's own EXPLICIT end (live C14: "fueled for 15 minutes" came back with
// start inferred / end explicit). Explicit ends never move, so shifting the start
// past it would create an event that ends before it starts. When that would
// happen the reconstruction that caused the shift is NOT applied: the AI's
// original inferred times are kept, the route check still flags the leg on its
// own, and this review note explains why the times were left alone.
function buildAnchorConflict(sources, anchorEv) {
  const legs = sources.map((leg) => (leg?.origin && leg?.destination ? `${leg.origin} → ${leg.destination}` : 'a driving leg')).join(', ');
  const hrs = sources.map((leg) => leg?.evaluation?.requiredTruckTime).filter((h) => typeof h === 'number');
  const need = hrs.length ? ` (realistic truck time ~${hrs.reduce((a, b) => a + b, 0).toFixed(1)} h)` : '';
  return {
    type: 'route_time_anchor',
    severity: 'review',
    title: 'ROUTE TIME CONFLICTS WITH A STATED TIME — REVIEW',
    message:
      `Routing ${legs}${need} would run past the stated end of ${fmtLoc(anchorEv)} at ${fmtClock(anchorEv.end_timestamp)}. ` +
      'Your stated time was kept and the driving time was NOT stretched to fit the route — review the times or add the missing stop.',
  };
}

// events: proposed events (already mileage-enriched), each carrying
//   field_provenance.{start_time,end_time} ∈ {'explicit','inferred'}.
// legs:   the routed legs from enrichProposalMileage — each has eventIndex and
//   evaluation.requiredTruckTime (hours) when routing succeeded.
// Returns { events, conflicts }:
//   events     — a new array with inferred Driving durations replaced and
//                subsequent inferred events cascade-shifted.
//   conflicts  — review-level route/time gaps before explicit anchors.
export function reconstructDrivingDurations(events, legs, opts = {}) {
  // Each pass either completes, or reports the Driving legs whose reconstruction
  // pushed an inferred start past an explicit end. Those legs are then skipped
  // (their AI-inferred duration kept) and the pass re-run. At most one skip per
  // Driving event, so this always terminates.
  const skip = new Set();
  const skipped = [];
  for (let guard = 0; guard <= (events || []).length; guard++) {
    const pass = reconstructPass(events, legs, opts, skip);
    if (!pass.collision) return { events: pass.events, conflicts: [...pass.conflicts, ...skipped] };
    for (const i of pass.collision.sources) skip.add(i);
    skipped.push(buildAnchorConflict(pass.collision.sources.map((i) => (legs || []).find((l) => l?.eventIndex === i)), pass.collision.anchor));
  }
  const last = reconstructPass(events, legs, opts, skip);
  return { events: last.events, conflicts: [...last.conflicts, ...skipped] };
}

function reconstructPass(events, legs, opts, skip) {
  const out = (events || []).map((e) => ({ ...e }));
  if (!out.length) return { events: out, conflicts: [], collision: null };

  const legByIndex = new Map();
  for (const leg of legs || []) {
    if (leg?.eventIndex != null) legByIndex.set(leg.eventIndex, leg);
  }

  // Chronological order, retaining original array indices.
  const order = out
    .map((e, i) => ({ e, i }))
    .filter((x) => x.e.start_timestamp)
    .sort((a, b) => new Date(a.e.start_timestamp) - new Date(b.e.start_timestamp));

  const conflicts = [];
  let shiftMs = 0;            // accumulated shift applied to inferred events
  let lastBlockEndMs = null;  // end of the most recent shifted/reconstructed event
  let blockSources = [];      // Driving events whose reconstruction feeds the current shift

  for (const { e: ev, i } of order) {
    const prov = ev.field_provenance || {};
    const startInferred = isInferred(prov, 'start_time');
    const endInferred = isInferred(prov, 'end_time');

    const s0 = new Date(ev.start_timestamp).getTime();
    const e0 = ev.end_timestamp ? new Date(ev.end_timestamp).getTime() : null;

    // --- START -----------------------------------------------------------------
    let newStart;
    if (startInferred) {
      newStart = s0 + shiftMs;
    } else {
      // Explicit/unknown start anchors the timeline. If a prior inferred block
      // was shifted, surface any gap before this anchor (overlaps are already
      // caught by findOverlaps). Then the incoming shift stops here.
      if (shiftMs !== 0 && lastBlockEndMs != null) {
        const gap = s0 - lastBlockEndMs;
        if (gap > GAP_THRESHOLD_MS) conflicts.push(buildGapConflict(ev, gap));
      }
      newStart = s0;
      shiftMs = 0;
      blockSources = [];
    }
    ev.start_timestamp = new Date(newStart).toISOString();

    // --- END -------------------------------------------------------------------
    // Reconstruct an inferred Driving end from routed truck time. Mileage is
    // never touched here — only the inferred duration changes.
    if (ev.duty_status === 'DRIVING' && endInferred && e0 != null && !skip.has(i)) {
      const leg = legByIndex.get(i);
      const requiredHours = leg?.evaluation?.requiredTruckTime;
      if (typeof requiredHours === 'number' && Number.isFinite(requiredHours) && requiredHours > 0) {
        const routedEnd = newStart + requiredHours * H;
        const baseEnd = e0 + shiftMs;           // end as it would be after incoming shift only
        const additionalMs = routedEnd - baseEnd; // = requiredHours*H − originalDuration
        ev.end_timestamp = new Date(routedEnd).toISOString();
        ev._route_derived_duration = true;
        ev.ambiguous_fields = Array.from(
          new Set([...(ev.ambiguous_fields || []), 'end_timestamp'])
        );
        shiftMs += additionalMs;               // propagate the growth/shrink forward
        if (additionalMs !== 0) blockSources.push(i);
        lastBlockEndMs = routedEnd;
        continue;
      }
      // No usable route: leave the AI's inferred duration unchanged (the route
      // warning already labels mileage as an estimate). Still shift the end by
      // any incoming shift so the block stays contiguous.
    }

    if (endInferred && e0 != null) {
      const newEnd = e0 + shiftMs;
      ev.end_timestamp = new Date(newEnd).toISOString();
      lastBlockEndMs = newEnd;
    } else if (e0 != null) {
      // Explicit end — do not move it.
      lastBlockEndMs = e0;
    } else {
      // Ongoing (no end) — leave open.
      lastBlockEndMs = newStart;
    }

    // The shift must never carry an inferred start to/past this event's own
    // (unmoved) explicit end — that would create an end-before-start event.
    if (e0 != null && e0 > s0 && new Date(ev.end_timestamp).getTime() <= newStart && blockSources.length) {
      return { events: out, conflicts, collision: { sources: [...blockSources], anchor: { ...ev, start_timestamp: new Date(s0).toISOString(), end_timestamp: new Date(e0).toISOString() } } };
    }

    // An explicit end anchors the timeline and ends the shifting block.
    if (!endInferred && e0 != null) {
      shiftMs = 0;
      lastBlockEndMs = null;
      blockSources = [];
    }
  }

  return { events: out, conflicts, collision: null };
}