// ============================================================================
// LogbookAI — DRIVER-CLAIMED AGRICULTURAL EXEMPTION RECORDS (49 CFR 395.1(k))
// Deterministic clock-availability layer. NO HOS engine changes.
// ----------------------------------------------------------------------------
// A claim is a driver-asserted record ("Driver-claimed — not verified") that an
// interval of the timeline was operated under 395.1(k)(1) (agricultural
// commodity, 150 air-miles from the source, during the state's planting/
// harvesting period) or 395.1(k)(4) (livestock, within 150 air-miles from the
// final destination of the livestock, in effect since Nov 15 2021).
//
// WHAT THE UNRESOLVED REGULATORY QUESTION IS:
// Whether (and how) time inside a qualifying agricultural-exempt interval
// affects the 14-hour window when a driver transitions into and out of the
// exempt operation is NOT authoritatively resolved in current FMCSA/eCFR
// sources. Until it is, NO exemption-adjusted HOS math may be produced.
// Therefore:
//
//   * Any clock whose calculation history a claim interval with recorded WORK
//     (Driving or On-Duty) overlaps is marked UNAVAILABLE — shown as "--",
//     never estimated, never zero.
//   * A claim that overlaps only rest time cannot change an 11h/14h count
//     (rest is not counted either way) and does not by itself unavail clocks.
//   * A later qualifying reset that establishes an independent basis (e.g. a
//     full 10-hour rest completing after the last claim boundary) makes a
//     clock independently determinable again → the numeric value returns.
//   * Ending a claim records an auditable boundary; it does NOT restore a
//     clock whose history the claim still reaches (the claim record is
//     retained and keeps being evaluated).
//   * Toggling agricultural support off in Settings preserves all claims and
//     their limitations; it only stops NEW claim entry. Evaluation below never
//     reads the settings toggle for that reason.
// ============================================================================

import { normalizeEvents, buildRestBlocks, startOfDayInTz } from './hosEngine';

const H = 3600000;
const DAY = 24 * H;
const WORK_STATUSES = ['DRIVING', 'ON_DUTY'];
const SPLIT_MIN_MS = 2 * H;
const QUAL_REST_MS = 10 * H;
const RESTART_MS = 34 * H;

export const AGRICULTURAL_DISABLED_NOTICE =
  'Agricultural HOS calculations are disabled pending authoritative resolution of the 14-hour transition rules (49 CFR 395.1(k)). Affected values are unavailable — not estimated and not zero.';

export function agriculturalSupportEnabled(profile) {
  return !!(profile && profile.agricultural_support_enabled);
}

export function basisLabel(basis) {
  return basis === 'livestock_final_destination_395_1_k_4'
    ? 'Livestock final destination (395.1(k)(4))'
    : 'Agricultural commodity (395.1(k)(1))';
}

// Auditable interval of each claim. An open (in-progress) claim runs to `now`;
// an ended claim keeps its stored end boundary.
export function claimIntervals(claims, now = new Date()) {
  const t = now instanceof Date ? now : new Date(now);
  return (claims || [])
    .filter(c => c && c.start_timestamp)
    .map(c => ({
      claim: c,
      start: new Date(c.start_timestamp),
      end: c.end_timestamp ? new Date(c.end_timestamp) : (c.ended_at ? new Date(c.ended_at) : new Date(t)),
    }))
    .filter(i => i.end.getTime() > i.start.getTime());
}

function overlapsMs(s1, e1, s2, e2) {
  return s1 < e2 && s2 < e1;
}

function ids(intervals) {
  return intervals.map(i => i.claim.id);
}

function clockEntry(unavailable, reason, claimIds) {
  return { unavailable: !!unavailable, reason: unavailable ? reason : '', claimIds: claimIds || [] };
}

export const CLOCK_LABELS = {
  driving: '11-hour driving limit',
  window14: '14-hour driving window',
  break30: '30-minute break clock',
  cycle: '60/70-hour cycle',
  restart: '34-hour restart',
  split: 'Split-sleeper projection',
};

// Read-only mirror of compute30MinBreak's own anchor (end of the last >=10h
// rest) so break availability matches the engine's accumulation span without
// modifying the engine.
function breakAnchorMs(segments, now) {
  const blocks = buildRestBlocks(segments);
  let anchor = null;
  for (const b of blocks) {
    if (b.duration >= QUAL_REST_MS && b.end.getTime() <= now.getTime()) anchor = b.end.getTime();
  }
  if (anchor != null) return anchor;
  return segments.length ? segments.reduce((m, s) => Math.min(m, s.start.getTime()), Infinity) : null;
}

// ---------------------------------------------------------------------------
// THE SHARED CLOCK-AVAILABILITY DETERMINATION — the single source every
// surface (Today, Logs, Can I Drive?, AI answers, Inspection, exports) uses.
// ---------------------------------------------------------------------------
export function evaluateAgriculturalClocks({ claims, events, hos, cycleType, tz, now = new Date() }) {
  const t = now instanceof Date ? now : new Date(now);
  const none = { agAffected: false, anyUnavailable: false, notice: '', clocks: null, claims: [] };
  const list = (claims || []).filter(Boolean);
  if (!list.length) return none;
  const intervals = claimIntervals(list, t);
  if (!intervals.length) return { ...none, claims: list };
  const segments = normalizeEvents(events || [], t);
  const applicable = !!(hos && hos.calculable && hos.validity && hos.validity.valid);
  const nowMs = t.getTime();
  const clocks = {};

  // True when a work segment of the given status lies BOTH inside the claim
  // interval AND inside the [spanStart, spanEnd] dependency window.
  const workHit = (interval, spanStart, spanEnd, statuses) =>
    segments.some(s =>
      statuses.includes(s.duty_status) &&
      s.start.getTime() < spanEnd && s.end.getTime() > spanStart &&
      s.start.getTime() < interval.end.getTime() && s.end.getTime() > interval.start.getTime());

  // 11-hour / 14-hour: dependency span = [governing reference, now]. A claim
  // with work time inside it makes both clocks indeterminate (the transition
  // semantics are unresolved). A claim that ended before the governing
  // reference never reaches this span → the clocks stay numeric.
  const refMs = applicable && hos.governing?.referenceTime ? new Date(hos.governing.referenceTime).getTime() : null;
  const hits1114 = (applicable && refMs != null)
    ? intervals.filter(i => workHit(i, refMs, nowMs, WORK_STATUSES))
    : [];
  const r1114 = 'A driver-claimed agricultural interval overlaps this clock\'s calculation history. Agricultural HOS calculations are disabled pending resolution of the 14-hour transition rules.';
  clocks.driving = clockEntry(hits1114.length > 0, r1114, ids(hits1114));
  clocks.window14 = clockEntry(hits1114.length > 0, r1114, ids(hits1114));

  // 30-minute break: accumulation of DRIVING since the last qualifying >=10h
  // rest. Whether driving during a claimed exempt interval counts toward the
  // 8-hour accumulation is unresolved → unavailable when reached.
  const anchor = breakAnchorMs(segments, t);
  const hitsBreak = anchor != null
    ? intervals.filter(i => workHit(i, Math.min(anchor, nowMs), nowMs, ['DRIVING']))
    : [];
  clocks.break30 = clockEntry(hitsBreak.length > 0, r1114, ids(hitsBreak));

  // 60/70-hour cycle: dependency span = the cycle lookback window. Whether
  // work inside a claimed exempt interval counts toward the cycle is part of
  // the disabled calculation → unavailable when reached.
  const days = cycleType === '60_7' ? 7 : 8;
  const windowStart = startOfDayInTz(t, tz || 'America/Chicago').getTime() - (days - 1) * DAY;
  const hitsCycle = intervals.filter(i => workHit(i, windowStart, nowMs, WORK_STATUSES));
  clocks.cycle = clockEntry(hitsCycle.length > 0, 'A driver-claimed agricultural interval overlaps the cycle lookback window. Agricultural HOS calculations are disabled pending resolution of the 14-hour transition rules.', ids(hitsCycle));

  // 34-hour restart: only affected when a claim interval overlaps the rest
  // block the restart display depends on (an ongoing rest or the qualifying
  // completed one) — a factual conflict, shown unavailable.
  const restBlocks = buildRestBlocks(segments);
  const inProgress = restBlocks.length && restBlocks[restBlocks.length - 1].end.getTime() >= nowMs
    ? restBlocks[restBlocks.length - 1] : null;
  let completed34 = null;
  for (const b of restBlocks) {
    if (b.duration >= RESTART_MS && b.end.getTime() <= nowMs) completed34 = b;
  }
  const hitsRestart = intervals.filter(i =>
    (inProgress && overlapsMs(i.start.getTime(), i.end.getTime(), inProgress.start.getTime(), inProgress.end.getTime())) ||
    (completed34 && overlapsMs(i.start.getTime(), i.end.getTime(), completed34.start.getTime(), completed34.end.getTime())));
  clocks.restart = clockEntry(hitsRestart.length > 0, 'A driver-claimed agricultural interval overlaps the rest period this restart depends on.', ids(hitsRestart));

  // Split-sleeper: informational projections suppressed when a claim overlaps
  // any rest history that could serve as a pairing member.
  const splitMembers = restBlocks.filter(b => b.duration >= SPLIT_MIN_MS && b.duration < QUAL_REST_MS);
  const hitsSplit = intervals.filter(i =>
    splitMembers.some(b => overlapsMs(i.start.getTime(), i.end.getTime(), b.start.getTime(), b.end.getTime())));
  clocks.split = clockEntry(hitsSplit.length > 0, 'A driver-claimed agricultural interval overlaps split-sleeper rest history; pairing projections are not shown.', ids(hitsSplit));

  const anyUnavailable = clocks.driving.unavailable || clocks.window14.unavailable ||
    clocks.break30.unavailable || clocks.cycle.unavailable || clocks.restart.unavailable;

  return {
    agAffected: true,
    anyUnavailable,
    notice: anyUnavailable ? AGRICULTURAL_DISABLED_NOTICE : '',
    clocks,
    claims: list,
  };
}

// ---------------------------------------------------------------------------
// Apply the availability result to a computeHOS() output WITHOUT recomputing
// anything: affected clocks are marked agriculturalUnavailable and gated off,
// unaffected clocks keep the engine's untouched numeric values.
// ---------------------------------------------------------------------------
export function applyAgriculturalAvailability(hos, evalResult) {
  if (!hos || !evalResult || !evalResult.anyUnavailable) return hos;
  const out = { ...hos };
  if (!hos.calculable) return out;
  const c = evalResult.clocks || {};
  const mark = (base, entry) => entry && entry.unavailable
    ? { ...base, applicable: false, agriculturalUnavailable: true, agriculturalUnavailableReason: entry.reason }
    : base;
  out.driving = mark(hos.driving, c.driving);
  out.window14 = mark(hos.window14, c.window14);
  if (c.break30?.unavailable) {
    out.break30 = { ...hos.break30, agriculturalUnavailable: true, agriculturalUnavailableReason: c.break30.reason };
  }
  if (c.cycle?.unavailable) {
    out.cycle = {
      ...hos.cycle,
      agriculturalUnavailable: true,
      agriculturalUnavailableReason: c.cycle.reason,
      cycleRemainingHours: null,
      cycleUsedHours: null,
      returningTomorrowHours: null,
    };
  }
  if (c.restart?.unavailable) {
    out.restart = { ...hos.restart, agriculturalUnavailable: true, agriculturalUnavailableReason: c.restart.reason };
  }
  if (c.split?.unavailable && out.split) {
    out.split = { ...out.split, agriculturalUnavailable: true, note: c.split.reason };
  }
  return out;
}

// "Can I drive?" summary used by whatCanIDo, the assistant, and the
// compliance verdict: availability is UNDETERMINED whenever a required clock
// is unavailable — never a yes/no answer, never a numeric remaining value.
export function availabilityUndeterminedSummary(evalResult) {
  const parts = [];
  for (const [key, entry] of Object.entries(evalResult?.clocks || {})) {
    if (entry.unavailable && key !== 'split') {
      parts.push(`${CLOCK_LABELS[key]}: unavailable (driver-claimed agricultural interval).`);
    }
  }
  return `Availability undetermined. A driver-claimed agricultural interval affects HOS clock history. ${AGRICULTURAL_DISABLED_NOTICE} ${parts.join(' ')}`.trim();
}

// Claims whose interval touches the given local log date (used by the banner,
// Logs, Inspection, and the PDF export).
export function claimsOnDate(claims, dateStr, tz) {
  if (!dateStr) return [];
  const dayStart = startOfDayInTz(new Date(dateStr + 'T12:00:00'), tz || 'America/Chicago');
  const dayEnd = new Date(dayStart.getTime() + DAY);
  return claimIntervals(claims, new Date())
    .filter(i => overlapsMs(i.start.getTime(), i.end.getTime(), dayStart.getTime(), dayEnd.getTime()))
    .map(i => i.claim);
}