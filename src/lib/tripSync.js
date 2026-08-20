// Trip <-> Logs synchronization helpers (deterministic, no AI).
// Derives the trip planner's starting point and fuel stops from logged duty
// events / fuel receipts, computes daily miles from driving hours x planning
// speed, and detects unaccounted time gaps between duty records so the driver
// can fill them. Never mutates RODS; the planner is a plan, not a log.

import { planningMph } from './complianceStop';
import { dateKeyInTz } from './hosEngine';
import { base44 } from '@/api/base44Client';

const H = 3600000;

// Events that belong to the given log day (in the driver's terminal tz).
export function dayEvents(events, dateStr, tz) {
  return (events || [])
    .filter(e => e.start_timestamp)
    .map(e => ({ ...e, _start: new Date(e.start_timestamp) }))
    .filter(e => dateKeyInTz(e._start, tz) === dateStr)
    .sort((a, b) => a._start - b._start);
}

// Where the day started: the earliest duty record of the day.
export function firstEventOfDay(events, dateStr, tz) {
  const evs = dayEvents(events, dateStr, tz);
  return evs.length ? evs[0] : null;
}

// Daily miles derived from logged driving hours x planning speed profile.
export function computeDailyMiles(events, dateStr, tz, speedProfile) {
  const evs = dayEvents(events, dateStr, tz);
  const mph = planningMph(speedProfile);
  let driveMs = 0;
  for (const e of evs) {
    if (e.duty_status !== 'DRIVING') continue;
    const end = e.end_timestamp ? new Date(e.end_timestamp) : (e.is_ongoing ? new Date() : e._start);
    driveMs += Math.max(0, end - e._start);
  }
  return (driveMs / H) * mph;
}

// Fuel stops the driver already logged today: duty events marked Fuel and
// imported FuelReceipt records. Deduplicated by city.
export function loggedFuelStops(events, fuelReceipts, dateStr, tz) {
  const evs = dayEvents(events, dateStr, tz);
  const stops = [];
  const seen = new Set();
  const add = (city, state, source, time) => {
    if (!city) return;
    const key = `${city}|${state || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    stops.push({ type: 'fuel', city, state: state || '', source, time });
  };
  for (const e of evs) {
    if (/fuel/i.test(e.remark || '')) add(e.city, e.state, 'log', e._start);
  }
  for (const r of (fuelReceipts || [])) {
    if (!r.receipt_date) continue;
    const rDate = typeof r.receipt_date === 'string' ? r.receipt_date.slice(0, 10) : new Date(r.receipt_date).toISOString().slice(0, 10);
    if (rDate === dateStr) add(r.city, r.state, 'receipt');
  }
  return stops;
}

// Unaccounted time between consecutive duty records of the day. A RODS day must
// be continuous; any gap > 1 minute means a duty record is missing.
export function findTimelineGaps(events, dateStr, tz, now = new Date()) {
  const evs = dayEvents(events, dateStr, tz);
  const gaps = [];
  const evEnd = (e) => e.end_timestamp ? new Date(e.end_timestamp) : (e.is_ongoing ? now : e._start);
  for (let i = 1; i < evs.length; i++) {
    const prev = evs[i - 1], next = evs[i];
    const prevEnd = evEnd(prev);
    const nextStart = next._start;
    const gap = nextStart - prevEnd;
    if (gap > 60000) gaps.push({ start: prevEnd, end: nextStart, ms: gap });
  }
  // open gap from the last closed event to now
  if (evs.length) {
    const last = evs[evs.length - 1];
    if (last.end_timestamp && !last.is_ongoing) {
      const lastEnd = new Date(last.end_timestamp);
      if (now - lastEnd > 60000) gaps.push({ start: lastEnd, end: now, ms: now - lastEnd, open: true });
    }
  }
  return gaps;
}

// Persisted daily miles (manual override or last auto value).
export async function getDailyMiles(dateStr) {
  try {
    const list = await base44.entities.DailySummary.filter({ log_date: dateStr }, '-created_date', 1);
    return list && list[0] ? list[0] : null;
  } catch (e) { return null; }
}

export async function saveDailyMiles(dateStr, miles, source = 'manual') {
  const existing = await getDailyMiles(dateStr);
  if (existing && existing.id) {
    return await base44.entities.DailySummary.update(existing.id, { miles, miles_source: source });
  }
  return await base44.entities.DailySummary.create({ log_date: dateStr, miles, miles_source: source });
}

export async function getFuelReceipts(daysBack = 30) {
  try {
    const since = new Date(Date.now() - (daysBack + 1) * 24 * H);
    const all = await base44.entities.FuelReceipt.list('-created_date', 200);
    return (all || []).filter(r => !r.receipt_date || new Date((r.receipt_date).slice(0, 10) + 'T12:00:00') >= since);
  } catch (e) { return []; }
}