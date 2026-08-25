// ============================================================================
// LogbookAI — DISPLAY-ONLY TIMELINE COALESCING ADAPTER
// ----------------------------------------------------------------------------
// Purely visual: fuses contiguous same-status segments (produced by the
// canonical normalizedSegments) into one continuous segment so the graph,
// event list, and visual summaries show one bar instead of several duplicate
// bars when a driver previously re-selected the already-active status.
//
// This module NEVER feeds the HOS engine, getDailyGrid, computeHOS, or any
// compliance/calculation path. All HOS/timeline math continues to read the
// canonical normalizedSegments from timelineEngine.js. The underlying
// DutyStatusEvent rows remain in the database untouched and remain available
// to audit/version history. No DB migration is performed.
// ============================================================================

import { normalizedSegments, dailyTotals as canonicalDailyTotals } from './timelineEngine';

const H = 3600000;
// 60s contiguity tolerance — matches the tolerance used elsewhere in the
// canonical engine. For exactly-contiguous duplicates (prev.end == next.start,
// which is what the Part A root-cause fix prevents going forward) the merge is
// strictly duration-preserving.
const COALESCE_TOLERANCE_MS = 60000;

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

// Prefer the earliest segment's non-empty value; fall back to the other.
function richest(a, b) {
  if (a && !b) return a;
  if (b && !a) return b;
  return a || b;
}

// ---------------------------------------------------------------------------
// coalescedSegments — display-only fusion of adjacent same-status segments.
// Wraps the unchanged normalizedSegments. Two consecutive segments merge
// when they share the same duty_status AND next.start - prev.end <= 60s. The
// merged segment spans prev.start -> max(prev.end, next.end) and carries the
// richest city/state/remark and the earliest id (for edit targeting).
// ---------------------------------------------------------------------------
export function coalescedSegments(rawEvents, now = new Date()) {
  const segs = normalizedSegments(rawEvents, now);
  if (segs.length === 0) return [];
  const out = [segs[0]];
  for (let i = 1; i < segs.length; i++) {
    const prev = out[out.length - 1];
    const cur = segs[i];
    const gap = cur.start.getTime() - prev.end.getTime();
    if (cur.duty_status === prev.duty_status && gap <= COALESCE_TOLERANCE_MS) {
      const mergedEnd = prev.end.getTime() >= cur.end.getTime() ? prev.end : cur.end;
      out[out.length - 1] = {
        ...prev,
        end: mergedEnd,
        city: richest(prev.city, cur.city),
        state: richest(prev.state, cur.state),
        remark: richest(prev.remark, cur.remark),
        id: prev.id,
        is_ongoing: prev.is_ongoing || cur.is_ongoing,
      };
    } else {
      out.push(cur);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// getDisplayGrid — display-only daily grid mirroring getDailyGrid's
// day-boundary clipping, but reading rows + remarks from coalescedSegments.
// Totals come from the canonical dailyTotals so the displayed numbers always
// match the certified HOS totals (coalescing is duration-preserving for the
// exactly-contiguous duplicates Part A prevents going forward).
// ---------------------------------------------------------------------------
export function getDisplayGrid(rawEvents, dateStr, timezone, now = new Date()) {
  const segments = coalescedSegments(rawEvents, now);
  const [y, m, d] = dateStr.split('-').map(Number);
  const utcMidnight = Date.UTC(y, m - 1, d);
  const offset = tzOffsetMs(new Date(utcMidnight), timezone);
  const dayStart = new Date(utcMidnight - offset);
  const dayEnd = new Date(dayStart.getTime() + 24 * H);
  const t = now instanceof Date ? now : new Date(now);
  const isCurrent = dayStart.getTime() <= t.getTime() && t.getTime() < dayEnd.getTime();
  const isFuture = dayStart.getTime() >= t.getTime();

  const rows = { OFF_DUTY: [], SLEEPER_BERTH: [], DRIVING: [], ON_DUTY: [] };
  const remarks = [];

  for (const seg of segments) {
    if (seg.end <= dayStart || seg.start >= dayEnd) continue;
    if (isFuture && seg.is_ongoing) continue;
    const s = seg.start < dayStart ? dayStart : seg.start;
    let e = seg.end > dayEnd ? dayEnd : seg.end;
    if (isCurrent && e > t) e = new Date(t);
    if (e <= s) continue;
    const startHour = (s - dayStart) / H;
    const endHour = (e - dayStart) / H;
    rows[seg.duty_status].push({
      startHour, endHour,
      start: new Date(s), end: new Date(e),
      city: seg.city, state: seg.state, remark: seg.remark,
      id: seg.id,
    });
    remarks.push({
      time: new Date(s),
      status: seg.duty_status,
      city: seg.city, state: seg.state,
      remark: seg.remark,
      id: seg.id,
    });
  }
  remarks.sort((a, b) => a.time - b.time);
  const dt = canonicalDailyTotals(rawEvents, dateStr, timezone, t);
  const totals = {
    OFF_DUTY: dt.OFF_DUTY,
    SLEEPER_BERTH: dt.SLEEPER_BERTH,
    DRIVING: dt.DRIVING,
    ON_DUTY: dt.ON_DUTY,
  };
  const totalHours = dt.totalHours;
  return { dayStart, dayEnd, rows, totals, totalHours, remarks, isCurrent, isFuture };
}