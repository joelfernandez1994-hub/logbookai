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
// begins"). Same-start different-status conflicts are flagged but NOT
// auto-resolved (we never invent which status owned that instant).
// Returns { segments, conflicts, resolvedOverlaps, changed }.
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
  let filledGaps = 0;
  let changed = false;
  for (let i = 0; i < segs.length; i++) {
    const cur = { ...segs[i], end: new Date(segs[i].end) };
    const next = segs[i + 1];
    if (cur.start >= now) continue; // future RODS never enter elapsed calculations
    const naturalEnd = next && next.start < now ? next.start : now;
    if (cur.end > naturalEnd) resolvedOverlaps++;
    if (cur.end < naturalEnd) filledGaps++;
    if (cur.end.getTime() !== naturalEnd.getTime()) changed = true;
    cur.end = new Date(naturalEnd);
    cur.is_ongoing = !next || next.start >= now;
    if (cur.end > cur.start) out.push(cur);
  }
  return { segments: out, conflicts, resolvedOverlaps, filledGaps, changed };
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
    filledGaps: res.filledGaps,
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
      .map(s => ({ start: new Date(Math.max(s.start, dayStart)), end: new Date(Math.min(s.end, targetEnd)) }))
      .sort((a, b) => a.start - b.start);
    let cursor = dayStart.getTime();
    for (const s of clipped) {
      if (s.start.getTime() > cursor + 1000) hasElapsedGap = true;
      if (s.start.getTime() < cursor - 1000) hasOverlap = true;
      const from = Math.max(cursor, s.start.getTime());
      if (s.end.getTime() > from) totalCoveredDuration += s.end.getTime() - from;
      cursor = Math.max(cursor, s.end.getTime());
    }
    if (cursor < targetEnd.getTime() - 1000) hasElapsedGap = true;
    isContinuousThroughNow = !hasElapsedGap && !hasOverlap && cursor >= targetEnd.getTime() - 1000;
    if (hasElapsedGap) issues.push({ type: 'elapsed_gap', severity: 'blocking', message: 'Elapsed duty-status coverage has an unassigned gap.' });
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
  const ne = newEvent.end_timestamp ? num(newEvent.end_timestamp) : (newEvent.is_ongoing ? t.getTime() : ns);
  if (!isFinite(ns) || !isFinite(ne) || ne < ns) return { creates: [], updates: [], deletes: [], duplicate: false, invalid: true };

  const dup = (existingEvents || []).some(e =>
    e && e.start_timestamp && e.duty_status === newEvent.duty_status && num(e.start_timestamp) === ns);
  if (dup) return { creates: [], updates: [], deletes: [], duplicate: true, invalid: false };

  const creates = [], updates = [], deletes = [];
  for (const ev of (existingEvents || [])) {
    if (!ev || !ev.start_timestamp) continue;
    if (ev.id && newEvent.id && ev.id === newEvent.id) continue;
    const es = num(ev.start_timestamp);
    const ee = ev.end_timestamp ? num(ev.end_timestamp) : (ev.is_ongoing ? t.getTime() : es);
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
    filledGaps: norm.filledGaps,
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