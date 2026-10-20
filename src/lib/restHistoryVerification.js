// ============================================================================
// LogbookAI — REST HISTORY VERIFICATION (deterministic recomputation).
// ----------------------------------------------------------------------------
// A saved "HOS REST HISTORY UNVERIFIED" review note is a snapshot taken at
// save time. This module recomputes — from the driver's FULL persisted
// timeline — whether a qualifying reset (≥10h Off Duty/Sleeper, or a valid
// split-sleeper pair) anchors the 11h/14h clocks contiguously as of a given
// moment. Verified → the stale saved note is suppressed (DISPLAY ONLY; the
// stored note is preserved). Unverified → the clocks stay '--' and the exact
// unresolved interval is surfaced with a correction action. Nothing here
// writes to the database, fills gaps, or invents Off Duty time.
//
// The verified/unverified verdict itself comes from computeGoverningReset —
// the SAME anchor logic the live engine (Today, Compliance, Trip Planner,
// proposal review) already uses — so identical persisted history yields one
// consistent answer on every surface. Classifications it distinguishes:
// valid cross-midnight rest, actual gaps, overlaps/conflicts, insufficient
// rest, and absent history.
// ============================================================================

import { normalizeTimeline, startOfDayInTz } from './timelineEngine';
import { computeGoverningReset, dateKeyInTz } from './hosEngine';

// Mirrors reachableRegion / buildRestBlocksWithSleeper contiguity tolerance —
// sub-minute date-boundary seams (e.g. a 1-second gap at local midnight) are
// NOT missing time and must never block verification.
const CONTIG_TOL_MS = 60000;

export const REST_HISTORY_NOTE_TYPE = 'rest_history_unverified';
export const REST_HISTORY_NOTE_TITLE = 'HOS REST HISTORY UNVERIFIED';

export function isRestHistoryNote(note) {
  return !!note && (note.type === REST_HISTORY_NOTE_TYPE || note.title === REST_HISTORY_NOTE_TITLE);
}

// A saved rest-history note is STALE (suppress from display) only when the
// deterministic recomputation now verifies a qualifying reset. Notes are
// never deleted — a later timeline change re-runs verification and they
// reappear naturally if the rest stops verifying again.
export function isStaleRestHistoryNote(note, verification) {
  return isRestHistoryNote(note) && !!verification && verification.verified === true;
}

const iso = (d) => (d instanceof Date ? d : new Date(d));

// ---------------------------------------------------------------------------
// verifyRestHistory(events, { tz, asOf }) →
//   { verified, status, kind, classification, anchor, anchorInterval,
//     unresolvedRange, reason }
// status: 'verified' | 'unverified' | 'no_driving'
// classification: 'cross_midnight_rest' | 'qualifying_rest' | 'absent_history'
//               | 'gap' | 'overlap' | 'insufficient_rest'
// ---------------------------------------------------------------------------
export function verifyRestHistory(events, { tz = 'UTC', asOf = new Date() } = {}) {
  const t = asOf instanceof Date ? asOf : new Date(asOf);
  const { segments, conflicts } = normalizeTimeline(events, t);
  const sorted = [...segments].sort((a, b) => a.start.getTime() - b.start.getTime());

  let driveIdx = -1;
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].duty_status === 'DRIVING' && sorted[i].start.getTime() <= t.getTime()) driveIdx = i;
  }
  // No driving at/before the evaluation point: the 11h/14h clocks are not in
  // play, so there is no rest history to verify — treated as verified so a
  // saved note on such a day does not linger.
  if (driveIdx === -1) {
    return { verified: true, status: 'no_driving', kind: null, classification: 'absent_history', anchor: null, anchorInterval: null, unresolvedRange: null, reason: '' };
  }

  // Same-start conflicts are blocking in validateTimeline — the clocks are
  // unavailable on every surface regardless of any anchor, so a contradictory
  // timeline is never reported as verified.
  if (conflicts.length > 0) {
    const c = conflicts[0];
    return {
      verified: false, status: 'unverified', kind: null, classification: 'overlap',
      anchor: null, anchorInterval: null,
      unresolvedRange: { start: iso(c.start), end: iso(c.start) },
      reason: 'The timeline contains overlapping/same-start events that must be corrected before rest history can be verified.',
    };
  }

  const governing = computeGoverningReset(segments, t);
  if (governing && governing.unverified) {
    // Locate the exact discontinuity the backward walk stopped at, so the
    // driver sees the precise interval that prevents verification.
    let boundary = null;
    for (let i = driveIdx; i > 0; i--) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      if (Math.abs(prev.end.getTime() - cur.start.getTime()) <= CONTIG_TOL_MS) continue;
      boundary = { start: prev.end, end: cur.start };
      break;
    }
    return {
      verified: false, status: 'unverified', kind: null,
      classification: boundary ? 'gap' : 'insufficient_rest',
      anchor: null, anchorInterval: null,
      unresolvedRange: boundary ? { start: iso(boundary.start), end: iso(boundary.end) } : null,
      reason: governing.reason || 'No qualifying reset could be verified contiguously.',
    };
  }

  const type = governing?.type || 'none';
  if (type === 'full') {
    const block = governing.block;
    const crossMidnight = !!block && dateKeyInTz(block.start, tz) !== dateKeyInTz(block.end, tz);
    return {
      verified: true, status: 'verified', kind: 'full_reset',
      classification: crossMidnight ? 'cross_midnight_rest' : 'qualifying_rest',
      anchor: iso(governing.referenceTime),
      anchorInterval: block ? { start: iso(block.start), end: iso(block.end) } : null,
      unresolvedRange: null, reason: '',
    };
  }
  if (type === 'split') {
    return {
      verified: true, status: 'verified', kind: 'split_sleeper', classification: 'qualifying_rest',
      anchor: iso(governing.referenceTime), anchorInterval: null, unresolvedRange: null, reason: '',
    };
  }
  if (type === 'implied') {
    // Brand-new record whose very first entry is a leading rest run — the
    // engine implies the anchor from it rather than reporting unverified.
    return {
      verified: true, status: 'verified', kind: 'implied_first_record', classification: 'absent_history',
      anchor: iso(governing.referenceTime), anchorInterval: null, unresolvedRange: null, reason: '',
    };
  }
  // type 'none': the record contains no qualifying rest before the driving —
  // nothing earlier exists to contradict it either, and the engine does not
  // gate these clocks (they show "No tour started yet").
  return {
    verified: true, status: 'verified', kind: null, classification: 'absent_history',
    anchor: null, anchorInterval: null, unresolvedRange: null, reason: '',
  };
}

// ---------------------------------------------------------------------------
// DISPLAY helper: "Oct 18, 4:00 AM – 10:00 AM" in the log timezone.
// ---------------------------------------------------------------------------
export function formatUnresolvedRange(range, tz) {
  if (!range?.start || !range?.end) return '';
  const f = (d) => new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: tz });
  return `${f(range.start)} – ${f(range.end)}`;
}

// Day-strip convenience: one shared per-day issue check so every surface that
// renders a day marker classifies it the same way.
export function dayHasRestHistoryIssue(events, { tz, asOf }) {
  return !verifyRestHistory(events, { tz, asOf }).verified;
}