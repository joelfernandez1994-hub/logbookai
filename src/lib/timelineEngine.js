// ============================================================================
// LogbookAI — CANONICAL TIMELINE ENGINE (deterministic, no AI, no DB writes).
// ----------------------------------------------------------------------------
// THE single source of truth for building, validating, normalizing, and
// planning writes to the duty-status timeline.
//
// INVARIANTS this engine enforces:
//   1. At any instant the driver has exactly ONE duty status.
//   2. No exact-duplicate events (same start time + same status).
//   3. No overlapping segments (previous status ENDS when the next BEGINS).
//   4. A completed day's totals never exceed 24 hours.
//   5. The current day's totals never exceed elapsed time.
//   6. A future date with no real events returns all zeros (ongoing events
//      never extend into the future).
//
// EVERY feature that reads or modifies the duty-status timeline — graph,
// event list, daily totals, HOS engine, Change Duty Status, Add/Edit Event,
// Edit Log Graph, AI Assistant, Tell LogbookAI, Manual Log Assistant, future
// AI reconstruction — MUST call these functions. No feature keeps its own
// independent log-writing or log-reading logic.
// ============================================================================

const H = 3600000;
const MIN = 60000;
export const DUTY_STATUSES = ['OFF_DUTY', 'SLEEPER_BERTH', 'DRIVING', 'ON_DUTY'];

function num(iso) {
  if (iso == null) return NaN;
  if (iso instanceof Date) return iso.getTime();
  return new Date(iso).getTime();
}

// ---------------------------------------------------------------------------
// Timezone helpers (self-contained — this is the foundational layer and must
// not import hosEngine, to avoid a cycle).
// ---------------------------------------------------------------------------
function tzOffsetMs(date, timezone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = dtf.formatToParts(date);
  const map = {};
  parts.forEach(p => { if (p.type !== 'literal') map[p.type] = p.value; });
  let h = Number(map.hour);
  if (map.hour === '24') h = 0;
  const asIfUtc = Date.UTC(Number(map.year), Number(map.month) - 1, Number(map.day), h, Number(map.minute), Number(map.second));
  return asIfUtc - date.getTime();
}

export function startOfDayInTz(date, timezone) {
  const d = date instanceof Date ? date : new Date(date);
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const parts = fmt.formatToParts(d);
  const y = parts.find(p => p.type === 'year').value;
  const m = parts.find(p => p.type === 'month').value;
  const dd = parts.find(p => p.type === 'day').value;
  const utcMidnight = Date.UTC(Number(y), Number(m) - 1, Number(dd));
  const offset = tzOffsetMs(new Date(utcMidnight), timezone);
  return new Date(utcMidnight - offset);
}

// The NEXT local midnight in `timezone` strictly after the given local calendar
// date (YYYY-MM-DD). Computed by advancing one calendar day in the carrier tz
// and taking that local midnight's instant — NOT startOfDay + 24h — so DST
// transitions are correct. Used as the proposal evaluation endpoint (the
// proposed log day ends at the next local midnight, never at the device clock).
export function nextLocalMidnightInTz(dateStr, timezone) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  // UTC midnight of the next calendar date (Date.UTC rolls month/year automatically).
  const nextUtcMid = Date.UTC(y, m - 1, d + 1);
  // Convert that calendar-date's local midnight to an instant using the tz offset
  // AT that instant (correct across DST transitions).
  return new Date(nextUtcMid - tzOffsetMs(new Date(nextUtcMid), timezone));
}

// ---------------------------------------------------------------------------
// Parse a raw event into a segment with concrete Date start/end.
//   - end_timestamp present  -> end = that time
//   - ongoing (no end)        -> end = now  (NEVER extends into the future)
//   - point event (no end)    -> end = start (zero duration)
// ---------------------------------------------------------------------------
export function toSegment(e, now = new Date()) {
  if (!e || !e.start_timestamp || !e.duty_status) return null;
  const t = now instanceof Date ? now : new Date(now);
  const start = new Date(e.start_timestamp);
  let end;
  if (e.end_timestamp) end = new Date(e.end_timestamp);
  else if (e.is_ongoing) end = t;
  else end = new Date(e.start_timestamp);
  return { ...e, start, end };
}

// Sort chronologically (start asc). Tiebreak: later created_date first so the
// most recently authored event wins among same-start events.
export function sortByStart(segs) {
  return [...segs].sort((a, b) => {
    const as = a.start.getTime(), bs = b.start.getTime();
    if (as !== bs) return as - bs;
    const ca = num(a.created_date), cb = num(b.created_date);
    return (cb || 0) - (ca || 0);
  });
}

// Exact-duplicate key: same start instant + same duty status.
export function duplicateKey(e) {
  return `${num(e.start_timestamp)}|${e.duty_status}`;
}

// Remove exact duplicates (same start + status), keeping the richest record.
export function dedupeExact(rawEvents) {
  const kept = new Map();
  const order = [];
  const score = (x) =>
    (x.end_timestamp ? 1 : 0) + (x.city ? 1 : 0) + (x.state ? 1 : 0) + (x.is_current_version ? 1 : 0);
  for (const e of (rawEvents || [])) {
    if (!e || !e.start_timestamp || !e.duty_status) continue;
    const k = duplicateKey(e);
    if (!kept.has(k)) { kept.set(k, e); order.push(k); continue; }
    if (score(e) > score(kept.get(k))) kept.set(k, e);
  }
  return order.map(k => kept.get(k));
}

// Report exact-duplicate groups (does not mutate).
export function findDuplicates(rawEvents) {
  const groups = new Map();
  for (const e of (rawEvents || [])) {
    if (!e || !e.start_timestamp || !e.duty_status) continue;
    const k = duplicateKey(e);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  const dups = [];
  for (const [, list] of groups) if (list.length > 1) dups.push(list);
  return dups;
}

// ---------------------------------------------------------------------------
// Resolve overlaps. For each consecutive pair where the previous event
// genuinely started earlier (prev.start < next.start) and runs past the next
// start, truncate prev.end = next.start ("previous status ends when next
// begins"). Recorded ends that fall before the next event or now are preserved
// so validation can report the unassigned elapsed gap instead of inventing a
// continuation. Same-start different-status conflicts remain blocking.
// Returns { segments, conflicts, resolvedOverlaps, unresolvedGaps, changed }.
// ---------------------------------------------------------------------------
export function resolveOverlaps(rawEvents, now = new Date()) {
  const all = sortByStart((rawEvents || []).map(e => toSegment(e, now)).filter(Boolean));
  const conflicts = [];
  const segs = [];
  for (const cur of all) {
    const prev = segs[segs.length - 1];
    if (prev && prev.start.getTime() === cur.start.getTime()) {
      if (prev.duty_status !== cur.duty_status) {
        conflicts.push({
          start: new Date(cur.start),
          statuses: [...new Set([prev.duty_status, cur.duty_status])],
        });
      }
      continue; // newest authored record wins; conflict remains blocking
    }
    segs.push(cur);
  }

  const out = [];
  let resolvedOverlaps = 0;
  let unresolvedGaps = 0;
  let changed = false;
  for (let i = 0; i < segs.length; i++) {
    const cur = { ...segs[i], end: new Date(segs[i].end) };
    const next = segs[i + 1];
    if (cur.start >= now) continue; // future RODS never enter elapsed calculations
    const boundary = next && next.start < now ? next.start : now;
    if (cur.end > boundary) {
      cur.end = new Date(boundary);
      resolvedOverlaps++;
      changed = true;
    } else if (cur.end < boundary) {
      unresolvedGaps++;
    }
    cur.is_ongoing = !!cur.is_ongoing && boundary.getTime() === now.getTime() && cur.end.getTime() === now.getTime();
    if (cur.end > cur.start) out.push(cur);
  }
  return { segments: out, conflicts, resolvedOverlaps, unresolvedGaps, filledGaps: 0, changed };
}

// ---------------------------------------------------------------------------
// FULL NORMALIZATION: dedupe exact duplicates + resolve safe overlaps.
// This is what graph, event list, daily totals, and the HOS engine all read.
// ---------------------------------------------------------------------------
export function normalizeTimeline(rawEvents, now = new Date()) {
  const t = now instanceof Date ? now : new Date(now);
  const duplicates = findDuplicates(rawEvents);
  const deduped = dedupeExact(rawEvents);
  const res = resolveOverlaps(deduped, t);
  return {
    segments: res.segments,
    duplicates,
    conflicts: res.conflicts,
    resolvedOverlaps: res.resolvedOverlaps,
    unresolvedGaps: res.unresolvedGaps,
    filledGaps: 0,
    changed: res.changed || res.conflicts.length > 0 || duplicates.length > 0,
  };
}

// Convenience: just the normalized segment list (what most callers want).
export function normalizedSegments(rawEvents, now = new Date()) {
  return normalizeTimeline(rawEvents, now).segments;
}

// ---------------------------------------------------------------------------
// DAILY TOTALS for a date in a timezone, derived from the NORMALIZED timeline.
//   completed (past) day  -> clipped to [dayStart, dayEnd]
//   current day           -> clipped to [dayStart, now]
//   future day            -> all zeros unless a real non-ongoing event starts
//                            within it (e.g. a cross-midnight event). Ongoing
//                            events cap at `now` and never extend into future.
// ---------------------------------------------------------------------------
export function dailyTotals(rawEvents, dateStr, timezone, now = new Date()) {
  const t = now instanceof Date ? now : new Date(now);
  const [y, m, d] = dateStr.split('-').map(Number);
  const utcMid = Date.UTC(y, m - 1, d);
  const dayStart = new Date(utcMid - tzOffsetMs(new Date(utcMid), timezone));
  const dayEnd = new Date(dayStart.getTime() + 24 * H);
  const isFuture = dayStart.getTime() >= t.getTime();
  const isCurrent = dayStart.getTime() <= t.getTime() && t.getTime() < dayEnd.getTime();

  const segs = normalizedSegments(rawEvents, t);
  const tot = { OFF_DUTY: 0, SLEEPER_BERTH: 0, DRIVING: 0, ON_DUTY: 0 };
  for (const s of segs) {
    if (s.end <= dayStart || s.start >= dayEnd) continue;
    if (isFuture && s.is_ongoing) continue; // ongoing caps at now; never bleed into future
    let ss = s.start < dayStart ? dayStart : s.start;
    let ee = s.end > dayEnd ? dayEnd : s.end;
    if (isCurrent && ee > t) ee = new Date(t);
    if (ee <= ss) continue;
    if (DUTY_STATUSES.includes(s.duty_status)) tot[s.duty_status] += (ee - ss);
  }
  const totalHours = (tot.OFF_DUTY + tot.SLEEPER_BERTH + tot.DRIVING + tot.ON_DUTY) / H;
  return {
    OFF_DUTY: tot.OFF_DUTY / H,
    SLEEPER_BERTH: tot.SLEEPER_BERTH / H,
    DRIVING: tot.DRIVING / H,
    ON_DUTY: tot.ON_DUTY / H,
    totalHours,
    isFuture,
    isCurrent,
  };
}

// ---------------------------------------------------------------------------
// VALIDATE a timeline (optionally for a specific day). Returns { valid, issues }.
// `valid` is false when any blocking issue remains after normalization
// (same-start conflicts, negative durations, current-day > elapsed, total > 24h).
// ---------------------------------------------------------------------------
export function validateTimeline(rawEvents, opts = {}) {
  const { now = new Date(), dateStr, timezone } = opts;
  const t = now instanceof Date ? now : new Date(now);
  const duplicates = findDuplicates(rawEvents);
  const norm = normalizeTimeline(rawEvents, t);
  const issues = [];

  duplicates.forEach(g => issues.push({
    type: 'duplicate', severity: 'blocking',
    message: `Duplicate ${g[0].duty_status} event at ${fmtClock(g[0].start_timestamp)} (${g.length} copies).`,
    count: g.length,
  }));
  norm.conflicts.forEach(c => issues.push({
    type: 'same_start_conflict', severity: 'blocking',
    message: `Two duty statuses start at the same time (${fmtClock(c.start)}): ${c.statuses.join(' / ')}. Review before continuing.`,
    statuses: c.statuses,
  }));
  for (const e of (rawEvents || [])) {
    if (!e || !e.start_timestamp || !e.end_timestamp) continue;
    if (num(e.end_timestamp) < num(e.start_timestamp)) {
      issues.push({ type: 'negative_duration', severity: 'blocking', message: 'An event ends before it starts.' });
    }
  }

  let hasOverlap = norm.conflicts.length > 0;
  let hasElapsedGap = false;
  let hasTrailingGap = false;
  let lastCoveredMs = null;
  let totalCoveredDuration = 0;
  let isContinuousThroughNow = false;
  let expectedDuration = null;
  if (dateStr && timezone) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const utcMid = Date.UTC(y, m - 1, d);
    const dayStart = new Date(utcMid - tzOffsetMs(new Date(utcMid), timezone));
    const dayEnd = new Date(dayStart.getTime() + 24 * H);
    const isCurrent = dayStart <= t && t < dayEnd;
    const targetEnd = isCurrent ? t : dayEnd;
    expectedDuration = Math.max(0, targetEnd - dayStart);
    const clipped = norm.segments
      .filter(s => s.end > dayStart && s.start < targetEnd)
      .map(s => ({ start: new Date(Math.max(s.start, dayStart)), end: new Date(Math.min(s.end, targetEnd)), is_ongoing: !!s.is_ongoing }))
      .sort((a, b) => a.start - b.start);
    let cursor = dayStart.getTime();
    let lastOngoing = false;
    let hasInteriorGap = false;
    for (const s of clipped) {
      if (s.start.getTime() > cursor + 1000) hasInteriorGap = true;
      if (s.start.getTime() < cursor - 1000) hasOverlap = true;
      const from = Math.max(cursor, s.start.getTime());
      if (s.end.getTime() > from) totalCoveredDuration += s.end.getTime() - from;
      cursor = Math.max(cursor, s.end.getTime());
      lastOngoing = s.is_ongoing;
    }
    // A currently open-ended duty status (Live Tracking's active status) is
    // CONTINUOUS with `now` by construction — flagging a trailing gap here
    // would only be measuring how long it's been since the last re-render,
    // not a real hole in the log. Only a genuinely completed/closed last
    // segment that stops short of `targetEnd` is a coverage shortfall.
    const tailShort = !(isCurrent && lastOngoing) && cursor < targetEnd.getTime() - 1000;
    if (hasInteriorGap) {
      // A gap BETWEEN records (a historical hole inside the day) remains
      // blocking: elapsed duty time is unaccounted and HOS math cannot be
      // trusted across it.
      hasElapsedGap = true;
    } else if (tailShort) {
      if (isCurrent) {
        // MANUAL-MODE TRAILING GAP (current day, tail only): the most
        // recent COMPLETED record ends before now. HOS through that record
        // is fully calculable from verified history, so this must NOT block
        // the clocks — the old behavior invalidated the entire day for
        // being even one minute behind the current clock, which forced
        // drivers to drag their final event to the current minute before
        // any HOS value would appear. This is a recordkeeping condition,
        // not a calculation-blocking one: activity after the last record is
        // unrecorded and could contain driving/on-duty work, so CURRENT
        // availability is withheld (see hosEngine.computeHOS →
        // availability). The gap is never filled, extended, or assumed Off
        // Duty, and the issue stays visible as a warning.
        hasTrailingGap = true;
      } else {
        // A past day's trailing coverage must still reach its real day-end;
        // the completed-day 24h total check below flags it as well.
        hasElapsedGap = true;
      }
    }
    if (tailShort) lastCoveredMs = cursor;
    isContinuousThroughNow = !hasElapsedGap && !hasTrailingGap && !hasOverlap && cursor >= targetEnd.getTime() - 1000;
    if (hasElapsedGap) issues.push({ type: 'elapsed_gap', severity: 'blocking', message: 'Elapsed duty-status coverage has an unassigned gap.' });
    if (hasTrailingGap) {
      issues.push({
        type: 'trailing_gap', severity: 'warning',
        message: 'The most recent duty-status record ends before the current time. HOS is verified through that record; activity after it is unrecorded, so current availability is not established.',
        lastCoveredMs: cursor,
      });
    }
    const hours = totalCoveredDuration / H;
    if (hours > expectedDuration / H + 0.01) issues.push({ type: 'daily_total', severity: 'blocking', message: 'Covered time exceeds elapsed time.' });
    if (!isCurrent && Math.abs(hours - 24) > 0.01) issues.push({ type: 'daily_total', severity: 'blocking', message: `Completed day totals ${hours.toFixed(2)}h (expected 24h).` });
  }

  const hasDuplicateCoverage = duplicates.length > 0;
  const blocking = issues.filter(i => i.severity === 'blocking');
  return {
    valid: blocking.length === 0,
    issues,
    segments: norm.segments,
    duplicates,
    conflicts: norm.conflicts,
    hasOverlap,
    hasDuplicateCoverage,
    hasElapsedGap,
    hasTrailingGap,
    lastCoveredMs,
    totalCoveredDuration,
    isContinuousThroughNow,
    expectedDuration,
  };
}

// Can the HOS engine confidently compute on this timeline? (item 34)
export function canComputeHOS(rawEvents, now = new Date()) {
  return validateTimeline(rawEvents, { now }).valid;
}

// ---------------------------------------------------------------------------
// PARTIAL-CALCULATION ANCHOR (opt-in, used by computeHOS's allowPartial path).
// Finds the latest instant on the log day where recorded coverage is
// CONTINUOUS from local midnight through that instant — i.e. the START of the
// day's first INTERNAL (between-records) gap. HOS recalculated AS OF that
// instant is fully trustworthy (it only reads recorded history), so Today can
// show real clock values instead of blanks while everything after the gap
// stays unverified. Returns null when:
//   - there is no internal gap (a trailing unrecorded stretch is handled by
//     the verified-through path, never here),
//   - nothing is recorded before the gap (no verified stretch exists to
//     calculate from — clocks must stay unavailable rather than appear "full"),
//   - or an unresolved data conflict (duplicate / same-start / negative
//     duration) makes EVERY instant untrustworthy.
// Purely deterministic — reads recorded timestamps only, never fills or
// extends anything.
// ---------------------------------------------------------------------------
export function findPartialHosAnchor(rawEvents, now, timezone) {
  const t = now instanceof Date ? now : new Date(now);
  if (findDuplicates(rawEvents).length) return null;
  for (const e of (rawEvents || [])) {
    if (!e || !e.start_timestamp || !e.end_timestamp) continue;
    if (num(e.end_timestamp) < num(e.start_timestamp)) return null;
  }
  const norm = normalizeTimeline(rawEvents, t);
  if (norm.conflicts.length) return null;
  if (!timezone) return null;
  const dateStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(t);
  const [y, m, d] = dateStr.split('-').map(Number);
  const utcMid = Date.UTC(y, m - 1, d);
  const dayStart = new Date(utcMid - tzOffsetMs(new Date(utcMid), timezone));
  const dayEnd = new Date(dayStart.getTime() + 24 * H);
  const isCurrent = dayStart <= t && t < dayEnd;
  const targetEnd = isCurrent ? t.getTime() : dayEnd.getTime();
  const clipped = norm.segments
    .filter(s => s.end > dayStart && s.start < targetEnd)
    .map(s => ({
      start: Math.max(s.start.getTime(), dayStart.getTime()),
      end: Math.min(s.end.getTime(), targetEnd),
      is_ongoing: !!s.is_ongoing,
    }))
    .sort((a, b) => a.start - b.start);
  if (!clipped.length) return null;
  let cursor = dayStart.getTime();
  for (const s of clipped) {
    if (s.start > cursor + 1000) {
      if (cursor <= dayStart.getTime()) return null; // gap starts at day open
      return { instant: new Date(cursor), gapStart: new Date(s.start) };
    }
    cursor = Math.max(cursor, s.end);
  }
  return null; // coverage is continuous — no internal gap on this day
}

// ---------------------------------------------------------------------------
// CANONICAL INSERT — add/replace an event while keeping the timeline
// continuous and non-overlapping. Rules:
//   - reject exact duplicates (same start + status) -> { duplicate: true }
//   - the currently-ongoing event ends at the new event's start
//   - an event the new range fully contains is deleted
//   - an event the new range splits is split into [es,ns] + [ne,ee]
//   - an event overlapping only one edge is truncated
// Returns { creates:[event], updates:[{id,data}], deletes:[id], duplicate, invalid }.
// ---------------------------------------------------------------------------
export function planInsert(existingEvents, newEvent, now = new Date()) {
  const t = now instanceof Date ? now : new Date(now);
  const ns = num(newEvent.start_timestamp);
  // An ongoing event's effective end for validity/overlap math is "now" —
  // EXCEPT when the event's own start is itself after "now" (e.g. an AI
  // reconstruction that cascaded a day's times later than the real current
  // moment). Using bare `t.getTime()` there put the effective end BEFORE the
  // start, so `ne < ns` read a perfectly valid open-ended event as "ends
  // before it starts" and silently dropped it (invalid:true, no error
  // surfaced). max(ns, now) keeps today's normal case identical (start is
  // always <= now) while no longer rejecting a future-started open event.
  const ne = newEvent.end_timestamp ? num(newEvent.end_timestamp) : (newEvent.is_ongoing ? Math.max(ns, t.getTime()) : ns);
  if (!isFinite(ns) || !isFinite(ne) || ne < ns) return { creates: [], updates: [], deletes: [], duplicate: false, invalid: true };

  const dup = (existingEvents || []).some(e =>
    e && e.start_timestamp && e.duty_status === newEvent.duty_status && num(e.start_timestamp) === ns);
  if (dup) return { creates: [], updates: [], deletes: [], duplicate: true, invalid: false };

  const creates = [], updates = [], deletes = [];
  for (const ev of (existingEvents || [])) {
    if (!ev || !ev.start_timestamp) continue;
    if (ev.id && newEvent.id && ev.id === newEvent.id) continue;
    const es = num(ev.start_timestamp);
    const ee = ev.end_timestamp ? num(ev.end_timestamp) : (ev.is_ongoing ? Math.max(es, t.getTime()) : es);
    if (ee <= ns || es >= ne) continue;
    if (es >= ns && ee <= ne) { deletes.push(ev.id); continue; }
    if (es < ns && ee > ne) {
      updates.push({ id: ev.id, data: { end_timestamp: new Date(ns).toISOString(), is_ongoing: false } });
      const { id, ...rest } = ev;
      creates.push({ ...rest, start_timestamp: new Date(ne).toISOString(), end_timestamp: new Date(ee).toISOString(), is_ongoing: false, is_current_version: true });
      continue;
    }
    if (es < ns) {
      updates.push({ id: ev.id, data: { end_timestamp: new Date(ns).toISOString(), is_ongoing: false } });
    } else {
      updates.push({ id: ev.id, data: { start_timestamp: new Date(ne).toISOString() } });
    }
  }
  creates.push({
    ...newEvent,
    is_ongoing: newEvent.is_ongoing ?? !newEvent.end_timestamp,
    is_current_version: true,
  });
  return { creates, updates, deletes, duplicate: false, invalid: false };
}

// ---------------------------------------------------------------------------
// CANONICAL REPLACE RANGE — remove all events overlapping [rangeStart,
// rangeEnd] and insert the (normalized) replacement events. Used by AI
// "Redo my entire day / trip": it REPLACES the period, never stacks a second
// timeline on top. Events fully outside the range are untouched. Events that
// straddle a boundary are truncated, preserving the adjacent day's timeline.
// ---------------------------------------------------------------------------
export function planReplaceRange(existingEvents, rangeStart, rangeEnd, replacementEvents, now = new Date()) {
  const t = now instanceof Date ? now : new Date(now);
  const rs = rangeStart instanceof Date ? rangeStart.getTime() : num(rangeStart);
  const re = rangeEnd instanceof Date ? rangeEnd.getTime() : num(rangeEnd);
  const creates = [], updates = [], deletes = [];
  for (const ev of (existingEvents || [])) {
    if (!ev || !ev.start_timestamp) continue;
    const es = num(ev.start_timestamp);
    const ee = ev.end_timestamp ? num(ev.end_timestamp) : (ev.is_ongoing ? t.getTime() : es);
    if (ee <= rs || es >= re) continue;
    if (es < rs && ee > re) {
      updates.push({ id: ev.id, data: { end_timestamp: new Date(rs).toISOString(), is_ongoing: false } });
      const { id, ...rest } = ev;
      creates.push({ ...rest, start_timestamp: new Date(re).toISOString(), end_timestamp: new Date(ee).toISOString(), is_ongoing: false, is_current_version: true });
      continue;
    }
    if (es < rs) {
      updates.push({ id: ev.id, data: { end_timestamp: new Date(rs).toISOString(), is_ongoing: false } });
    } else if (ee > re) {
      updates.push({ id: ev.id, data: { start_timestamp: new Date(re).toISOString() } });
    } else {
      deletes.push(ev.id);
    }
  }
  const norm = normalizeTimeline(replacementEvents, t).segments;
  for (const s of norm) {
    const start = s.start instanceof Date ? s.start : new Date(s.start);
    const end = s.end instanceof Date ? s.end : new Date(s.end);
    const stIso = start.toISOString();
    creates.push({
      log_date: stIso.slice(0, 10),
      start_timestamp: stIso,
      end_timestamp: end ? end.toISOString() : null,
      duty_status: s.duty_status,
      city: s.city || '', state: s.state || '', remark: s.remark || '',
      tractor_number: s.tractor_number || '', trailer_numbers: s.trailer_numbers || '',
      method_of_creation: s.method_of_creation || (s.source === 'voice' ? 'Voice AI' : 'Typed AI'),
      is_ongoing: s.is_ongoing ?? !s.end_timestamp,
      is_current_version: true,
      // Carry per-timestamp provenance (explicit/inferred) through replace-day
      // creates so AI-inferred flags persist on the saved record.
      ...(s.field_provenance ? { field_provenance: s.field_provenance } : {}),
    });
  }
  return { creates, updates, deletes };
}

// ---------------------------------------------------------------------------
// REPAIR corrupted V2 records: dedupe exact duplicates, resolve safe overlaps
// by truncation, drop zero-duration artifacts. Does NOT invent statuses.
// Returns { repaired, removedDuplicates, resolvedOverlaps, conflicts } where
// `repaired` is a clean DutyStatusEvent-shaped list safe to persist.
// ---------------------------------------------------------------------------
function stripVolatile(s) {
  const { start, end, _proposed, ...rest } = s;
  return rest;
}

export function repairTimeline(rawEvents, now = new Date()) {
  const t = now instanceof Date ? now : new Date(now);
  const duplicates = findDuplicates(rawEvents);
  const norm = normalizeTimeline(rawEvents, t);
  const repaired = norm.segments.map(s => {
    const start = s.start instanceof Date ? s.start : new Date(s.start);
    const end = s.end instanceof Date ? s.end : new Date(s.end);
    return {
      ...stripVolatile(s),
      start_timestamp: start.toISOString(),
      end_timestamp: (s.is_ongoing && !s.end_timestamp) ? null : end.toISOString(),
      is_ongoing: !!s.is_ongoing && !s.end_timestamp,
      is_current_version: true,
    };
  });
  return {
    repaired,
    removedDuplicates: duplicates.reduce((n, g) => n + g.length - 1, 0),
    resolvedOverlaps: norm.resolvedOverlaps,
    unresolvedGaps: norm.unresolvedGaps,
    filledGaps: 0,
    conflicts: norm.conflicts,
  };
}

// ---------------------------------------------------------------------------
// FORMAT helpers
// ---------------------------------------------------------------------------
function fmtClock(d) {
  if (!d) return '--';
  return new Date(d).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

export function fmtHours(h) {
  if (h == null || isNaN(h)) return '0.00h';
  return `${h.toFixed(2)}h`;
}