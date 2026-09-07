// ============================================================================
// LogbookAI — AI-layer client helpers (deterministic, no AI, no DB writes).
// ----------------------------------------------------------------------------
// These helpers sit between the OpenAI-backed backend response and the
// canonical timeline writer. They validate / normalize the structured intent
// the backend returns and decide how the UI must present and apply it.
//
// Nothing here calls an LLM or writes to the database. OpenAI only interprets;
// the canonical writer (timelineWriter.js) is the only thing that persists.
// ============================================================================

import { startOfDayInTz } from './hosEngine';

export const DUTY_STATUSES = ['OFF_DUTY', 'SLEEPER_BERTH', 'DRIVING', 'ON_DUTY'];
const INTENTS = ['add_events', 'edit_events', 'delete_events', 'replace_day', 'question', 'hos_question', 'clarification'];

export function normalizeStatus(s) {
  if (!s) return '';
  const u = String(s).toUpperCase();
  return u === 'SLEEPER' ? 'SLEEPER_BERTH' : u;
}

// Is this intent a question that must be answered deterministically (no Apply)?
export function isQuestionIntent(intent) {
  return intent === 'question' || intent === 'hos_question';
}

// Should the UI offer an Apply button for this proposal?
export function shouldOfferApply(proposal) {
  if (!proposal) return false;
  if (isQuestionIntent(proposal.intent)) return false;
  if (proposal.refuses_fabrication || proposal.requires_clarification) return false;
  if (proposal.explicit_guard?.blocking) return false;
  return Array.isArray(proposal.proposed_events) && proposal.proposed_events.length > 0;
}

const GUARDED_FIELDS = ['start_time', 'end_time', 'status', 'city', 'state'];

function clockFromLocal(value) {
  const match = String(value || '').match(/T(\d{2}):(\d{2})/);
  return match ? `${match[1]}:${match[2]}` : '';
}

function adjustmentMatches(event, field, expected) {
  return (event.adjustments || []).some(a => a.field === field && String(a.original_stated_value || '').toLowerCase().includes(String(expected || '').toLowerCase()));
}

function clockToMinutes(hhmm) {
  const m = String(hhmm || '').match(/^(\d{2}):(\d{2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// Every clock value that appears as ANY event's start or end in the proposed
// timeline — the CANONICAL set of boundaries the proposal actually contains.
// A stated driver fact is "preserved" if its value is present here at all,
// regardless of which specific event/field carries it or how that field is
// provenance-labeled. This is what makes a SHARED boundary work correctly
// ("12:00" simultaneously closing one event and opening the next is ONE fact,
// not two separate ones each requiring their own 'explicit' tag) — the guard
// cares whether the VALUE survived into the timeline, not which field "owns"
// the provenance label for it.
function canonicalClockBoundaries(events) {
  const set = new Set();
  for (const event of events) {
    const s = clockFromLocal(event.start_time_local || event.start_timestamp);
    const e = clockFromLocal(event.end_time_local || event.end_timestamp);
    if (s) set.add(s);
    if (e) set.add(e);
  }
  return set;
}

// Smallest distance (minutes) from any of `candidates` to any real boundary.
// Used only for an APPROXIMATE fact's tolerance check — an exact fact must
// match a boundary outright (see below), never by "close enough".
function nearestBoundaryDeltaMin(candidates, boundaryMinutes) {
  let min = Infinity;
  for (const c of candidates) {
    const cm = clockToMinutes(c);
    if (cm == null) continue;
    for (const bm of boundaryMinutes) min = Math.min(min, Math.abs(cm - bm));
  }
  return min;
}
const APPROX_TOLERANCE_MIN = 30;

export function detectExplicitFactAlterations(events = [], deterministicFacts = {}) {
  const alteredExplicitFacts = [];
  const droppedExplicitEvents = [];
  const visibleAdjustments = [];

  events.forEach((event, eventIndex) => {
    const provenance = event.field_provenance || {};
    const current = {
      start_time: event.start_time_local || event.start_timestamp,
      end_time: event.end_time_local || event.end_timestamp,
      status: event.duty_status,
      city: event.city,
      state: event.state,
    };
    for (const adjustment of (event.adjustments || [])) {
      visibleAdjustments.push({ ...adjustment, eventIndex });
      if (!GUARDED_FIELDS.includes(adjustment.field) || !adjustment.original_stated_value || !adjustment.adjusted_value) {
        alteredExplicitFacts.push({ eventIndex, field: adjustment.field || 'unknown', reason: 'Incomplete visible adjustment marker.' });
      }
    }
    for (const field of GUARDED_FIELDS) {
      if (provenance[field] !== 'explicit') continue;
      const markers = (event.adjustments || []).filter(a => a.field === field);
      if (markers.length && !markers.some(a => String(a.adjusted_value) === String(current[field]))) {
        alteredExplicitFacts.push({ eventIndex, field, reason: 'The adjustment marker does not match the proposed value.' });
      }
    }
  });

  // TIME FACTS — matched at the CANONICAL BOUNDARY level (see
  // canonicalClockBoundaries above), not per-event/per-field. A fact is
  // preserved when its value (or, for a bare hour with no stated AM/PM,
  // EITHER meridiem reading — the driver themselves didn't disambiguate, so
  // the guard doesn't require the AI to have guessed the same one) appears
  // anywhere in the proposal's real start/end boundaries. An APPROXIMATE
  // fact ("around 8:20") that doesn't land exactly is still checked within a
  // tolerance window and, even outside it, is downgraded to a review-level
  // note rather than a hard block — the driver themselves signaled it was an
  // estimate. An EXACT fact ("at 8:20") must match outright or it blocks,
  // exactly as before — this path is never weakened.
  const boundaries = canonicalClockBoundaries(events);
  const boundaryMinutes = [...boundaries].map(clockToMinutes).filter((n) => n != null);
  const approximateMismatches = [];
  for (const fact of (deterministicFacts.times || [])) {
    const candidates = Array.isArray(fact.candidates) && fact.candidates.length ? fact.candidates : [fact.normalized];
    const exactMatch = candidates.some((c) => boundaries.has(c))
      || events.some((event) => adjustmentMatches(event, 'start_time', fact.raw) || adjustmentMatches(event, 'end_time', fact.raw));
    if (exactMatch) continue;
    if (fact.approximate) {
      const delta = nearestBoundaryDeltaMin(candidates, boundaryMinutes);
      if (delta <= APPROX_TOLERANCE_MIN) continue; // close enough to the driver's own estimate
      approximateMismatches.push({ type: 'time_approximate', value: fact.raw, reason: `Approximate time "${fact.raw}" is not reflected anywhere close in the proposal — please verify.` });
      continue; // review-level only — the driver themselves said this was approximate
    }
    droppedExplicitEvents.push({ type: 'time', value: fact.raw, reason: 'Explicit clock time was dropped, changed silently, or tagged inferred.' });
  }
  for (const fact of (deterministicFacts.locations || [])) {
    const preserved = events.some(event => {
      const same = String(event.city || '').trim().toLowerCase() === String(fact.city).trim().toLowerCase()
        && String(event.state || '').trim().toUpperCase() === String(fact.state).trim().toUpperCase();
      return (same && event.field_provenance?.city === 'explicit' && event.field_provenance?.state === 'explicit')
        || (adjustmentMatches(event, 'city', fact.city) && adjustmentMatches(event, 'state', fact.state));
    });
    if (!preserved) droppedExplicitEvents.push({ type: 'location', value: fact.raw, reason: 'Explicit location was dropped, changed silently, or tagged inferred.' });
  }
  // Status facts are matched by TYPE COVERAGE, not per-mention count. The
  // backend extracts one fact per literal word occurrence ("driving",
  // "drove", "on duty", ...), but ordinary narration routinely restates the
  // same activity in different words within one sentence ("...and started
  // driving. I drove from Homestead to Fort Pierce..." describes ONE leg,
  // yet contributes two "DRIVING" word-mentions). Per-mention 1:1 matching
  // therefore blocks completely ordinary full-day narratives. What this
  // guard actually needs to catch is the AI silently converting or erasing
  // an ENTIRE status the driver described (e.g. turning all driving into
  // off-duty to hide a violation) — which "is there at least one explicit
  // event of this status?" still catches, without the false-positive rate.
  const explicitStatusTypes = new Set(
    events.filter(event => event.field_provenance?.status === 'explicit').map(event => event.duty_status)
  );
  const statusFactsByType = new Map();
  for (const fact of (deterministicFacts.statuses || [])) {
    if (!statusFactsByType.has(fact.status)) statusFactsByType.set(fact.status, []);
    statusFactsByType.get(fact.status).push(fact);
  }
  for (const [status, statusFacts] of statusFactsByType) {
    const covered = explicitStatusTypes.has(status)
      || statusFacts.some(fact => events.some(event => adjustmentMatches(event, 'status', fact.raw)));
    if (!covered) {
      droppedExplicitEvents.push({ type: 'status', value: statusFacts[0].raw, reason: 'Explicit duty status was dropped, changed silently, or tagged inferred.' });
    }
  }

  return {
    blocking: alteredExplicitFacts.length > 0 || droppedExplicitEvents.length > 0,
    alteredExplicitFacts,
    droppedExplicitEvents,
    visibleAdjustments,
    // Never blocking on their own — an approximate driver time that landed
    // outside the tolerance window is surfaced for review, not treated as a
    // dropped fact (the driver themselves said it was an estimate).
    approximateMismatches,
  };
}

// The day range [dayStart, dayEnd) a replace_day proposal replaces.
export function replaceDayRange(targetDate, tz) {
  const date = targetDate || new Date().toISOString().slice(0, 10);
  const dayStart = startOfDayInTz(new Date(date + 'T12:00:00'), tz);
  const dayEnd = new Date(dayStart.getTime() + 24 * 3600000);
  return { dayStart, dayEnd };
}

// ---------------------------------------------------------------------------
// REPLACE_DAY EXISTING-EVENT SCOPING.
// ----------------------------------------------------------------------------
// A replace_day proposal reconstructs an ENTIRE day from the driver's
// narrative alone — it must never be validated/displayed as if the day's
// PRE-EXISTING records (including a live/current-status row Today's quick-
// status selector created or carried forward, e.g. from the carrier's home
// terminal default) are still separately "there," or a full-day rewrite
// starting somewhere else entirely gets bogus overlap/location warnings
// against a stale row it is about to replace.
//
// This returns only the events OUTSIDE the replaced day — the ones a
// replace_day proposal must still respect (yesterday's timeline, tomorrow's).
// An event that STARTS within the target day is treated as part of the day
// being replaced EVEN IF it is still open/ongoing (no end_timestamp) — an
// open "current status" row is exactly the case rule 4 in the ticket calls
// out: it must never leak into the reconstructed timeline as if it were an
// external fact to reconcile against. An event that only STARTED before the
// target day but is still ongoing INTO it is likewise excluded (it will be
// truncated/handled by the replace-range writer at Apply time, same as any
// other cross-boundary event — see planReplaceRange in timelineWriter.js,
// unchanged here) rather than surfacing as a same-day conflict in a proposal
// that is about to replace that day anyway.
//
// For any OTHER intent (add_events, edit_events, delete_events, etc.) this
// is never called — existing/live-status context remains fully available,
// exactly as it already is, since only a full-day reconstruction implies the
// day's existing records are being superseded.
export function existingOutsideReplacedDay(existing, targetDate, tz) {
  const { dayStart, dayEnd } = replaceDayRange(targetDate, tz);
  return (existing || []).filter((e) => {
    if (!e || !e.start_timestamp) return true; // malformed — not this function's concern, leave it alone
    const start = new Date(e.start_timestamp);
    if (start >= dayStart && start < dayEnd) return false; // starts within the replaced day — excluded, even if still open
    const end = e.end_timestamp ? new Date(e.end_timestamp) : new Date();
    return end <= dayStart || start >= dayEnd;
  });
}

// Validate + normalize an interpret response from the backend. Returns
// { valid, errors, normalized }. Defensively coerces SLEEPER→SLEEPER_BERTH,
// start_time→start_timestamp, end_time→end_timestamp so the UI/writer always
// receive one canonical shape even if the backend mapping drifts.
export function validateInterpretResult(data) {
  const errors = [];
  if (!data || typeof data !== 'object') return { valid: false, errors: ['No response.'], normalized: null };

  const intent = data.intent && INTENTS.includes(data.intent) ? data.intent : 'add_events';
  if (data.intent && !INTENTS.includes(data.intent)) errors.push(`Unknown intent "${data.intent}"`);

  const proposed = Array.isArray(data.proposed_events) ? data.proposed_events : [];
  const normalizedEvents = proposed.map((p, i) => {
    const start = p.start_timestamp || p.start_time || '';
    const end = p.end_timestamp != null ? p.end_timestamp : (p.end_time != null ? p.end_time : null);
    const status = normalizeStatus(p.duty_status || p.status);
    if (!start) errors.push(`Event ${i + 1} is missing a start time.`);
    if (!DUTY_STATUSES.includes(status)) errors.push(`Event ${i + 1} has an invalid duty status "${status}".`);
    return {
      date: p.date || data.target_date || (start ? start.slice(0, 10) : ''),
      start_timestamp: start,
      end_timestamp: end || null,
      start_time_local: p.start_time_local || p.start_time || '',
      end_time_local: p.end_time_local != null ? p.end_time_local : (p.end_time != null ? p.end_time : null),
      duty_status: status,
      city: p.city || '',
      state: p.state || '',
      activity_type: p.activity_type || p.activity || '',
      remark: p.remark || p.activity_type || p.activity || '',
      ambiguous_fields: p.ambiguous_fields || [],
      field_provenance: p.field_provenance || {},
      adjustments: Array.isArray(p.adjustments) ? p.adjustments : [],
      source: p.source || 'typed',
      // Present only for intent 'edit_events' — the position (into the SAME
      // events array sent to manualLogAssistant) of the existing event this
      // proposal replaces. null/absent means the AI could not confidently
      // identify one; see resolveEditTargets(), which callers MUST use
      // before applying an edit — never insert an unresolved edit as new.
      edit_target_index: Number.isInteger(p.edit_target_index) ? p.edit_target_index : null,
    };
  });

  const explicitGuard = detectExplicitFactAlterations(normalizedEvents, data.deterministic_explicit_facts || {});
  const normalized = {
    intent,
    target_date: data.target_date || '',
    requires_clarification: !!data.requires_clarification,
    clarification_question: data.clarification_question || '',
    interpretation: data.interpretation || data.summary || '',
    summary: data.summary || data.interpretation || '',
    proposed_events: normalizedEvents,
    clarifications: Array.isArray(data.clarifications) ? data.clarifications : [],
    location_confirmations: Array.isArray(data.location_confirmations) ? data.location_confirmations : [],
    deterministic_explicit_facts: data.deterministic_explicit_facts || {},
    original_input: data.original_input || '',
    explicit_guard: explicitGuard,
    pretrip_ask: !!data.pretrip_ask,
    refuses_fabrication: !!data.refuses_fabrication,
    // Only meaningful for intent 'delete_events' — positions into the SAME
    // events array sent to manualLogAssistant. See resolveEditTargets().
    delete_target_indices: Array.isArray(data.delete_target_indices)
      ? data.delete_target_indices.filter((i) => Number.isInteger(i))
      : [],
  };

  return { valid: errors.length === 0, errors, normalized };
}

// ---------------------------------------------------------------------------
// EDIT-BY-REFERENCE TARGET RESOLUTION.
// ----------------------------------------------------------------------------
// The AI never edits/deletes anything directly — it only points at a
// position in the SAME `events` array the client sent it (see
// manualLogAssistant/entry.ts's indexed eventSummary). This resolves those
// indices back to the real logged events (with real ids) so the caller can
// route the change through the canonical editEvent()/deleteEventById()
// writer. An edit/delete whose target cannot be resolved (index missing,
// null, or out of range) is NEVER silently applied as a new insert — it is
// returned as "unresolved" so the caller blocks Apply and asks the driver
// instead. `events` MUST be the exact same array (same order) that was sent
// to manualLogAssistant for this proposal, or the indices will not line up.
// ---------------------------------------------------------------------------
export function resolveEditTargets(events, normalized) {
  const list = events || [];
  const at = (idx) => (Number.isInteger(idx) && idx >= 0 && idx < list.length) ? list[idx] : null;

  if (normalized?.intent === 'delete_events') {
    const all = (normalized.delete_target_indices || []).map((index) => ({ index, event: at(index) }));
    return {
      resolvedEdits: [], unresolvedEdits: [],
      resolvedDeletes: all.filter((r) => r.event),
      unresolvedDeletes: all.filter((r) => !r.event),
    };
  }
  if (normalized?.intent === 'edit_events') {
    const all = (normalized.proposed_events || []).map((proposed) => ({ proposed, target: at(proposed.edit_target_index) }));
    return {
      resolvedEdits: all.filter((r) => r.target),
      unresolvedEdits: all.filter((r) => !r.target),
      resolvedDeletes: [], unresolvedDeletes: [],
    };
  }
  return { resolvedEdits: [], unresolvedEdits: [], resolvedDeletes: [], unresolvedDeletes: [] };
}