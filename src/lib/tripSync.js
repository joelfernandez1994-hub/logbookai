// Trip <-> Logs synchronization helpers (deterministic, no AI).
// Derives the trip planner's starting point and fuel stops from logged duty
// events / fuel receipts, computes daily miles from driving hours x planning
// speed, and detects unaccounted time gaps between duty records so the driver
// can fill them. Never mutates RODS; the planner is a plan, not a log.

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

// Daily miles fallback: logged Driving hours × 65 mph. Used only when real
// routed mileage is unavailable or incomplete (DailyMilesCard display + PDF).
export function computeDailyMiles(events, dateStr, tz, speedProfile) {
  const evs = dayEvents(events, dateStr, tz);
  const mph = 65; // fallback estimate (Driving Hours × 65 mph)
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

// Classify only gaps proven by canonical duty-status segments. An untouched
// day has incomplete history, not a confirmed full-day gap. Open-ended status
// segments naturally carry across midnight during canonical normalization.
export function findTimelineGaps(events, dateStr, tz, now = new Date()) {
  const dayAnchor = new Date(`${dateStr}T12:00:00Z`);
  const dayStart = startOfDayInTz(dayAnchor, tz);
  const dayEnd = new Date(dayStart.getTime() + 24 * H);
  const targetEnd = now < dayEnd ? now : dayEnd;
  if (targetEnd <= dayStart) return [];

  const segments = normalizedSegments(events, now)
    .filter(s => s.end > dayStart && s.start < targetEnd)
    .map(s => ({
      start: s.start < dayStart ? dayStart : s.start,
      end: s.end > targetEnd ? targetEnd : s.end,
      is_ongoing: !!s.is_ongoing,
    }))
    .sort((a, b) => a.start - b.start);
  if (!segments.length) return [];

  const gaps = [];
  let cursor = dayStart;
  let lastIsOngoing = false;
  for (const segment of segments) {
    if (segment.start - cursor > 60000) {
      gaps.push({ start: cursor, end: segment.start, ms: segment.start - cursor });
    }
    if (segment.end > cursor) cursor = segment.end;
    lastIsOngoing = segment.is_ongoing;
  }
  // A currently open-ended duty status (Live Tracking's active status, or any
  // status the driver hasn't changed yet) is CONTINUOUS with "now" by
  // definition — there is no missing time to add a record for. Only report
  // the trailing gap when the most recent logged segment has a real, closed
  // end (the driver's status genuinely stopped being tracked and nothing
  // picked it up). Without this, a driver actively driving/on duty could see
  // a false "time gap" purely from the live clock ticking a minute or two
  // ahead of the last re-render, with nothing wrong in the actual log.
  if (!lastIsOngoing && targetEnd - cursor > 60000) {
    gaps.push({ start: cursor, end: targetEnd, ms: targetEnd - cursor });
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

// All Driving legs for a log day. A Driving leg's origin is its own city/state;
// its destination is the next event's city/state (any status). Legs missing an
// origin or destination are returned but flagged unroutable so the caller can
// mark the suggestion incomplete instead of inventing mileage.
export function getDrivingLegs(events, dateStr, tz) {
  const evs = dayEvents(events, dateStr, tz);
  const legs = [];
  for (let i = 0; i < evs.length; i++) {
    const e = evs[i];
    if (e.duty_status !== 'DRIVING') continue;
    const origin = [e.city, e.state].filter(Boolean).join(', ').trim();
    let destination = '';
    for (let j = i + 1; j < evs.length; j++) {
      const dest = [evs[j].city, evs[j].state].filter(Boolean).join(', ').trim();
      if (dest) { destination = dest; break; }
    }
    legs.push({ origin, destination, routable: !!(origin && destination) });
  }
  return legs;
}

// In-session cache keyed by log date + the routable-legs signature, so opening
// a day again does not re-route (and re-spend integration credits). Invalidates
// automatically when the day's Driving legs materially change.
const suggestedMilesCache = new Map();
const legsSignature = (legs) => legs.filter(l => l.routable).map(l => `${l.origin}->${l.destination}`).join(';;');

// Real road miles for the day: routes every Driving leg that has both an origin
// and a destination through the tripEstimate provider, sums the returned miles,
// and marks the result incomplete when any leg was excluded or failed to route.
export async function computeSuggestedMiles(events, dateStr, tz) {
  const legs = getDrivingLegs(events, dateStr, tz);
  const routable = legs.filter(l => l.routable);
  if (!routable.length) return { miles: 0, incomplete: legs.length > 0, legsCount: legs.length, routedCount: 0, available: false };

  const cacheKey = `${dateStr}::${legsSignature(routable)}`;
  const cached = suggestedMilesCache.get(cacheKey);
  if (cached) return { ...cached, cached: true };

  let total = 0, routedCount = 0;
  for (const leg of routable) {
    try {
      const res = await base44.functions.invoke('tripEstimate', { origin: leg.origin, destination: leg.destination });
      if (res && typeof res.miles === 'number' && Number.isFinite(res.miles)) { total += res.miles; routedCount++; }
    } catch (e) { /* leg unroutable — counted as incomplete below */ }
  }
  const result = {
    miles: Math.round(total),
    incomplete: routedCount < routable.length || routable.length < legs.length,
    legsCount: legs.length,
    routedCount,
    available: routedCount > 0,
  };
  suggestedMilesCache.set(cacheKey, result);
  return result;
}

// Persist optional Begin/End Odometer readings without touching Total Miles or
// its source. Creates a record only when the driver actually entered a value.
export async function saveOdometers(dateStr, beginOdometer, endOdometer) {
  const b = beginOdometer === '' || beginOdometer == null ? null : Number(beginOdometer);
  const e = endOdometer === '' || endOdometer == null ? null : Number(endOdometer);
  if ((b == null || Number.isNaN(b)) && (e == null || Number.isNaN(e)) && !(await getDailyMiles(dateStr))) return null;
  const patch = {
    begin_odometer: b == null || Number.isNaN(b) ? null : b,
    end_odometer: e == null || Number.isNaN(e) ? null : e,
  };
  const existing = await getDailyMiles(dateStr);
  if (existing && existing.id) return await base44.entities.DailySummary.update(existing.id, patch);
  return await base44.entities.DailySummary.create({ log_date: dateStr, ...patch });
}

export async function getAllDailySummaries() {
  try {
    const list = await base44.entities.DailySummary.list('-created_date', 400);
    return list || [];
  } catch (e) { return []; }
}

export async function getFuelReceipts(daysBack = 30) {
  try {
    const since = new Date(Date.now() - (daysBack + 1) * 24 * H);
    const all = await base44.entities.FuelReceipt.list('-created_date', 200);
    return (all || []).filter(r => !r.receipt_date || new Date((r.receipt_date).slice(0, 10) + 'T12:00:00') >= since);
  } catch (e) { return []; }
}