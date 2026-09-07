// ============================================================================
// LogbookAI — CANDIDATE-TIMELINE NORMALIZATION (deterministic, no AI).
// ----------------------------------------------------------------------------
// Runs BEFORE overlap/location/route/HOS/movement validation, on the merged
// (existing + proposed) chronological candidate timeline. Cleans up obvious,
// non-authoritative boundary artifacts so the overlap validator only ever
// fires on a GENUINE contradiction — never weakened, just fed a sane input.
//
// Rules (see the live Midwest regression for the exact motivating case):
//   1. Sort by start timestamp.
//   2. An event with NO end at all (still open/ongoing) is closed at the
//      next event's start when a later event exists.
//   3. An INFERRED/DEFAULTED end that runs past a later event's start is
//      truncated to that later event's start (never past it — rule 7).
//   4. An EXPLICIT start/end is never moved, for any reason.
//   5. Two EXPLICIT facts that genuinely conflict (an explicit end after a
//      later explicit start) are left exactly as stated, and reported as a
//      single, clearly-attributed blocking conflict instead of the generic
//      overlap validator's arbitrary-pair noise.
//   6. Only the last event in the sorted candidate list may remain open.
//   7. Truncation only ever targets the IMMEDIATE next event — an inferred
//      block can never be stretched across more than one later boundary.
//
// "Explicit" here means: an AI-proposed event's field_provenance marks that
// exact field 'explicit'; an existing already-persisted DutyStatusEvent's
// START is always a fact (it happened), and its END is a fact only when the
// record is actually closed (has end_timestamp and is not is_ongoing) — an
// open existing record has no stated end at all, so rule 2 applies to it,
// not rule 5. This lets a stale/forgotten "current status" that predates a
// full-day rewrite get closed automatically, while a genuine two-explicit-
// fact contradiction still surfaces for the driver instead of being hidden.
// ============================================================================

function isExplicitStart(event) {
  const fp = event?.field_provenance;
  if (fp && typeof fp === 'object' && fp.start_time) return fp.start_time === 'explicit';
  return true; // an existing persisted record's start is a stated fact
}

function isExplicitEnd(event) {
  if (event?.end_timestamp == null) return false; // open/ongoing — never explicit
  const fp = event?.field_provenance;
  if (fp && typeof fp === 'object' && fp.end_time) return fp.end_time === 'explicit';
  return !event?.is_ongoing; // an existing, actually-closed record is a stated fact
}

function fmtClock(ms) {
  return new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function describeShort(e) {
  const label = e.activity_type || e.remark || (e.duty_status || '').replace('_', ' ');
  const loc = [e.city, e.state].filter(Boolean).join(', ');
  return [label, loc].filter(Boolean).join(' — ') || 'this event';
}

// events: any chronological candidate list (typically the ALREADY-MERGED
// existing+proposed timeline). Returns { events, conflicts }:
//   events    — a new array, chronologically sorted, with inferred/open
//               boundaries cleaned up per the rules above.
//   conflicts — blocking warnings for genuine explicit-vs-explicit
//               contradictions (rule 5). Never silently resolved.
export function normalizeCandidateTimeline(events, opts = {}) {
  const sorted = (events || [])
    .filter((e) => e && e.start_timestamp)
    .map((e) => ({ ...e }))
    .sort((a, b) => new Date(a.start_timestamp) - new Date(b.start_timestamp));

  const conflicts = [];

  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i];
    const next = sorted[i + 1];
    if (!next) continue; // rule 6 — only the last candidate may stay open

    const nextStartMs = new Date(next.start_timestamp).getTime();
    const curEndMs = cur.end_timestamp ? new Date(cur.end_timestamp).getTime() : null;

    if (curEndMs == null) {
      // Rule 2 — no end at all, and a later event exists: close it there.
      cur.end_timestamp = new Date(nextStartMs).toISOString();
      cur.is_ongoing = false;
      cur._normalized = { ...(cur._normalized || {}), closedAt: 'next_event_start' };
      continue;
    }

    if (curEndMs <= nextStartMs) continue; // no overlap — nothing to do

    if (isExplicitEnd(cur) && isExplicitStart(next)) {
      // Rule 4/5 — both boundaries are stated facts. Never move either one;
      // surface ONE precise blocking conflict instead of letting the generic
      // overlap check report an arbitrary, confusingly-attributed pair.
      conflicts.push({
        type: 'explicit_boundary_conflict',
        severity: 'blocking',
        title: 'CONFLICTING EXPLICIT TIMES',
        message: `${describeShort(cur)} is stated to end at ${fmtClock(curEndMs)}, but ${describeShort(next)} is stated to start at ${fmtClock(nextStartMs)} — before it. Both times are preserved as given; review which is correct before confirming.`,
        eventA: cur,
        eventB: next,
      });
      continue;
    }

    // Rule 3/7 — an inferred/defaulted end truncated to the IMMEDIATE next
    // event's start only (never further), leaving the next event untouched.
    cur.end_timestamp = new Date(nextStartMs).toISOString();
    cur.is_ongoing = false;
    cur._normalized = { ...(cur._normalized || {}), truncatedAt: 'next_event_start' };
  }

  return { events: sorted, conflicts };
}
