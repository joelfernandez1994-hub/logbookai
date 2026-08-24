// Trip <-> Logs synchronization helpers (deterministic, no AI).
// Derives the trip planner's starting point and fuel stops from logged duty
// events / fuel receipts, computes daily miles from driving hours x planning
// speed, and detects unaccounted time gaps between duty records so the driver
// can fill them. Never mutates RODS; the planner is a plan, not a log.

import { planningMph } from './complianceStop';
import { dateKeyInTz } from './hosEngine';
import { normalizedSegments, startOfDayInTz } from './timelineEngine';
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

// Validate elapsed coverage only after canonical state-change normalization.
// A known status carries forward until the next status change; bounded source
// records therefore do not create filler-record gaps. A gap remains only when
// no status can be determined at the start of the requested elapsed period.
export function findTimelineGaps(events, dateStr, tz, now = new Date()) {
  const dayAnchor = new Date(`${dateStr}T12:00:00Z`);
  const dayStart = startOfDayInTz(dayAnchor, tz);
  const dayEnd = new Date(dayStart.getTime() + 24 * H);
  const targetEnd = now < dayEnd ? now : dayEnd;
  if (targetEnd <= dayStart) return [];

  const segments = normalizedSegments(events, now)
    .filter(s => s.end > dayStart && s.start < targetEnd)
    .sort((a, b) => a.start - b.start);
  if (!segments.length) return [{ start: dayStart, end: targetEnd, ms: targetEnd - dayStart, open: true }];

  const firstStart = segments[0].start > dayStart ? segments[0].start : dayStart;
  return firstStart - dayStart > 60000
    ? [{ start: dayStart, end: firstStart, ms: firstStart - dayStart }]
    : [];
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

export async function saveAutoMilesIfNotManual(dateStr, miles) {
  const existing = await getDailyMiles(dateStr);
  if (existing?.miles_source === 'manual') return { record: existing, skippedManual: true };
  const record = existing?.id
    ? await base44.entities.DailySummary.update(existing.id, { miles, miles_source: 'auto' })
    : await base44.entities.DailySummary.create({ log_date: dateStr, miles, miles_source: 'auto' });
  return { record, skippedManual: false };
}

export async function saveProposalMiles(dateStr, miles, mileageEdited = false) {
  return mileageEdited
    ? { record: await saveDailyMiles(dateStr, miles, 'manual'), skippedManual: false }
    : saveAutoMilesIfNotManual(dateStr, miles);
}

export async function getFuelReceipts(daysBack = 30) {
  try {
    const since = new Date(Date.now() - (daysBack + 1) * 24 * H);
    const all = await base44.entities.FuelReceipt.list('-created_date', 200);
    return (all || []).filter(r => !r.receipt_date || new Date((r.receipt_date).slice(0, 10) + 'T12:00:00') >= since);
  } catch (e) { return []; }
}