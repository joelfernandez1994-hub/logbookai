// ============================================================================
// LogbookAI — IFTA background jurisdiction-mileage resolver.
// ----------------------------------------------------------------------------
// Fully separate from the canonical duty-status timeline. This module only
// READS DutyStatusEvent (city/state/timestamps) to derive driving legs — it
// never creates, edits, or deletes a DutyStatusEvent, and nothing here can
// invalidate HOS or the driver's log. Every mileage value it produces carries
// an explicit provenance and is never presented as an exact, confirmed figure
// until a driver reviews and confirms it (see IftaJurisdictionMileage).
//
// Deliberately does NOT import proposalValidation.js / logAssistant.js (those
// pull in base44Client transitively via other consumers), keeping this module
// small, independently testable, and safe to run purely in the background.
// ============================================================================

import { dateKeyInTz } from './hosEngine';
import { normalizeJurisdiction } from './usStates';

export const IFTA_RESOLVER_VERSION = 'v1';

export function quarterOf(dateStr) {
  const [y, m] = dateStr.split('-').map(Number);
  const q = Math.floor((m - 1) / 3) + 1;
  return `${y}-Q${q}`;
}

function locOf(ev) {
  // Normalized so a GPS-captured full state name ("Georgia") and a manually
  // typed 2-letter code ("GA") on two different events are recognized as the
  // same place — both for the sameLocation short-circuit below and so the
  // origin/destination string sent to the route splitter is consistent.
  return { city: String(ev?.city || '').trim(), state: normalizeJurisdiction(ev?.state) };
}
function usable(loc) {
  return !!(loc.city && loc.state);
}

// Group raw DutyStatusEvent rows by local calendar day (driver's log timezone).
export function groupEventsByDay(events, timezone) {
  const byDay = new Map();
  for (const ev of events || []) {
    if (!ev?.start_timestamp) continue;
    const key = dateKeyInTz(ev.start_timestamp, timezone);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(ev);
  }
  for (const list of byDay.values()) list.sort((a, b) => new Date(a.start_timestamp) - new Date(b.start_timestamp));
  return byDay;
}

// Filter a full event list down to one calendar day (driver's log timezone).
// Small convenience for the single-day "Recalculate day" action so callers
// don't need to build the whole groupEventsByDay map just for one date.
export function eventsForDay(events, logDate, timezone) {
  return (events || []).filter((e) => e?.start_timestamp && dateKeyInTz(e.start_timestamp, timezone) === logDate);
}

// Derive same-day driving legs from a single day's events. Mirrors the
// neighbor-based origin/destination convention used elsewhere in the app
// (proposalValidation.getDrivingLegs) but kept local/lightweight and scoped to
// one day, since IFTA mileage is attributed per calendar day.
export function deriveDayLegs(dayEvents) {
  const sorted = (dayEvents || []).filter((e) => e.start_timestamp)
    .sort((a, b) => new Date(a.start_timestamp) - new Date(b.start_timestamp));
  const legs = [];
  sorted.forEach((event, index) => {
    if (event.duty_status !== 'DRIVING') return;
    let origin = null;
    for (let i = index - 1; i >= 0; i--) {
      if (sorted[i].duty_status === 'DRIVING') continue;
      const loc = locOf(sorted[i]);
      if (usable(loc)) { origin = loc; break; }
    }
    if (!origin) origin = locOf(event);

    let destination = null;
    for (let i = index + 1; i < sorted.length; i++) {
      if (sorted[i].duty_status === 'DRIVING') continue;
      const loc = locOf(sorted[i]);
      if (usable(loc)) { destination = loc; break; }
    }
    if (!destination) destination = locOf(event);

    legs.push({ event, origin, destination });
  });
  return legs;
}

// Resolve one calendar day's per-jurisdiction mileage. `routeSplitFn(origin,
// destination)` must resolve to `{ totalMiles, segments: [{state, miles}] }`
// or throw/return an error shape — any failure for a leg is swallowed and
// recorded in `errors`, never thrown, so a routing outage or bad geocode can
// only ever leave that day's IFTA mileage unresolved, never touch HOS/logging.
export async function resolveDayMileage(dayEvents, { timezone, routeSplitFn }) {
  const legs = deriveDayLegs(dayEvents);
  const jurisdictionMiles = new Map(); // state -> miles
  const sourceEventIds = new Set();
  const errors = [];

  for (const leg of legs) {
    const originStr = usable(leg.origin) ? `${leg.origin.city}, ${leg.origin.state}` : '';
    const destStr = usable(leg.destination) ? `${leg.destination.city}, ${leg.destination.state}` : '';
    if (!originStr || !destStr) {
      errors.push({ eventId: leg.event.id, reason: 'Missing origin or destination city/state — skipped.' });
      continue;
    }
    if (leg.origin.city === leg.destination.city && leg.origin.state === leg.destination.state) {
      continue; // same location both ends — no mileage to attribute
    }
    let result;
    try {
      result = await routeSplitFn(originStr, destStr);
    } catch (e) {
      result = null;
    }
    if (!result || result.error || !Array.isArray(result.segments)) {
      errors.push({ eventId: leg.event.id, reason: result?.error || 'Route could not be resolved right now — will retry next visit.' });
      continue;
    }
    if (leg.event.id) sourceEventIds.add(leg.event.id);
    for (const seg of result.segments) {
      const jurisdiction = normalizeJurisdiction(seg?.state);
      if (!jurisdiction || !(seg.miles > 0)) continue;
      jurisdictionMiles.set(jurisdiction, (jurisdictionMiles.get(jurisdiction) || 0) + seg.miles);
    }
  }

  return {
    jurisdictionMiles: Array.from(jurisdictionMiles.entries()).map(([jurisdiction, miles]) => ({
      jurisdiction,
      miles: Math.round(miles * 10) / 10,
    })),
    sourceEventIds: Array.from(sourceEventIds),
    errors,
  };
}

// Resolve every day in `events` that has driving activity and does not
// already have an up-to-date resolved record, writing route_estimated rows
// via `upsertFn`. Days where the driver already entered/confirmed a value for
// a jurisdiction are left untouched — this resolver only ever fills gaps, it
// never overwrites a driver-provided figure.
export async function resolveMissingDays({
  events,
  timezone,
  existingRecords = [],
  routeSplitFn,
  upsertFn,
  resolverVersion = IFTA_RESOLVER_VERSION,
}) {
  const byDay = groupEventsByDay(events, timezone);
  const existingByDay = new Map();
  for (const rec of existingRecords) {
    if (!existingByDay.has(rec.log_date)) existingByDay.set(rec.log_date, []);
    existingByDay.get(rec.log_date).push(rec);
  }

  const summary = { resolvedDays: 0, skippedDays: 0, errors: [] };

  for (const [logDate, dayEvents] of byDay.entries()) {
    const hasDriving = dayEvents.some((e) => e.duty_status === 'DRIVING');
    if (!hasDriving) continue;

    const existing = existingByDay.get(logDate) || [];
    // A day is considered already resolved if every existing row for it is
    // either driver-provided (never touched by the resolver) or was produced
    // by the current resolver version. Otherwise (no rows, or stale version
    // present), it's eligible for (re)resolution.
    const upToDate = existing.length > 0 && existing.every(
      (r) => r.mileage_source === 'driver_entered' || r.mileage_source === 'driver_confirmed' || r.resolver_version === resolverVersion
    );
    if (upToDate) { summary.skippedDays++; continue; }

    const { jurisdictionMiles, sourceEventIds, errors } = await resolveDayMileage(dayEvents, { timezone, routeSplitFn });
    if (errors.length) summary.errors.push({ log_date: logDate, errors });
    if (!jurisdictionMiles.length) continue;

    const quarter = quarterOf(logDate);
    for (const { jurisdiction, miles } of jurisdictionMiles) {
      const existingRow = existing.find((r) => r.jurisdiction === jurisdiction);
      // Never overwrite a driver-provided figure.
      if (existingRow && (existingRow.mileage_source === 'driver_entered' || existingRow.mileage_source === 'driver_confirmed')) {
        continue;
      }
      try {
        await upsertFn({
          existingRow,
          log_date: logDate,
          quarter,
          jurisdiction,
          miles,
          mileage_source: 'route_estimated',
          confirmed: false,
          source_event_ids: sourceEventIds,
          resolver_version: resolverVersion,
        });
      } catch (e) {
        summary.errors.push({ log_date: logDate, errors: [{ reason: `Could not save mileage for ${jurisdiction}: ${e?.message || e}` }] });
      }
    }
    summary.resolvedDays++;
  }

  return summary;
}

// Force-recompute ONE calendar day, ignoring the resolver-version staleness
// check that resolveMissingDays uses (that check is what makes background
// resolution idempotent; this deliberately bypasses it). Use this when the
// driver has edited a past trip/log after IFTA mileage for that day was
// already resolved, and taps an explicit "Recalculate day" action.
//
// - Only route_estimated / odometer_derived rows are ever refreshed.
// - driver_entered / driver_confirmed rows are left untouched UNLESS the
//   caller passes replaceConfirmed:true (the driver explicitly opted in).
// - A jurisdiction that no longer appears in the freshly-derived legs (e.g.
//   the driver deleted or rerouted a trip) has its non-driver-provided row
//   refreshed to the new (possibly zero) mileage rather than left stale.
// - Only ever reads DutyStatusEvent (via the caller-supplied dayEvents) and
//   never writes it; never throws — every failure lands in summary.errors,
//   so this can never affect HOS or logging.
export async function recomputeDay({
  dayEvents,
  logDate,
  existingRecords = [],
  routeSplitFn,
  upsertFn,
  resolverVersion = IFTA_RESOLVER_VERSION,
  replaceConfirmed = false,
}) {
  const summary = { updated: [], preserved: [], errors: [] };
  const hasDriving = (dayEvents || []).some((e) => e.duty_status === 'DRIVING');
  if (!hasDriving) return summary;

  const { jurisdictionMiles, sourceEventIds, errors } = await resolveDayMileage(dayEvents, { routeSplitFn });
  if (errors.length) summary.errors.push(...errors);

  const quarter = quarterOf(logDate);
  const freshByJurisdiction = new Map(jurisdictionMiles.map((j) => [j.jurisdiction, j.miles]));
  // Union of jurisdictions with fresh mileage now, and jurisdictions that had
  // a stored (non-driver-provided) row before — so a trip that disappeared
  // (deleted/rerouted) gets its stale estimate refreshed down, not left behind.
  const jurisdictions = new Set(freshByJurisdiction.keys());
  for (const r of existingRecords) jurisdictions.add(r.jurisdiction);

  for (const jurisdiction of jurisdictions) {
    const existingRow = existingRecords.find((r) => r.jurisdiction === jurisdiction);
    const isDriverProvided = existingRow && (existingRow.mileage_source === 'driver_entered' || existingRow.mileage_source === 'driver_confirmed');
    if (isDriverProvided && !replaceConfirmed) {
      summary.preserved.push({ jurisdiction, miles: existingRow.miles, mileage_source: existingRow.mileage_source });
      continue;
    }
    const miles = freshByJurisdiction.has(jurisdiction) ? freshByJurisdiction.get(jurisdiction) : 0;
    if (!existingRow && miles <= 0) continue; // nothing to create for a jurisdiction with no mileage and no prior row
    try {
      await upsertFn({
        existingRow,
        log_date: logDate,
        quarter,
        jurisdiction,
        miles,
        mileage_source: 'route_estimated',
        confirmed: false,
        source_event_ids: sourceEventIds,
        resolver_version: resolverVersion,
      });
      summary.updated.push({ jurisdiction, miles });
    } catch (e) {
      summary.errors.push({ reason: `Could not save mileage for ${jurisdiction}: ${e?.message || e}` });
    }
  }

  return summary;
}

// Pure aggregation for the quarterly report / exports. Takes the raw
// IftaJurisdictionMileage rows and fuel-by-jurisdiction summary already
// fetched by the caller and produces one plain-data object both the PDF and
// CSV builders and the review screen read from — so every surface always
// shows numbers computed the exact same way. `driver_entered`/
// `driver_confirmed` mileage is authoritative: a jurisdiction is "fully
// confirmed" only when NONE of its rows are still an estimate.
//
// Taxable miles: LogbookAI does not currently distinguish non-taxable miles
// (e.g. off-highway, personal conveyance) from the rest of a jurisdiction's
// logged mileage, so taxableMiles intentionally equals totalMiles here —
// never a smaller "corrected" figure we haven't actually derived. No tax-due
// amount is computed anywhere in this module; that would require per-
// jurisdiction tax-rate data this app does not have.
export function buildQuarterlyReport({ quarter, records = [], fuel = { byState: [], totalGallons: 0 } }) {
  const map = new Map();
  for (const r of records) {
    const j = r.jurisdiction;
    if (!map.has(j)) map.set(j, { jurisdiction: j, totalMiles: 0, confirmedMiles: 0, estimatedMiles: 0, rows: [] });
    const g = map.get(j);
    const miles = Number(r.miles) || 0;
    g.totalMiles += miles;
    const isConfirmed = r.mileage_source === 'driver_entered' || r.mileage_source === 'driver_confirmed';
    if (isConfirmed) g.confirmedMiles += miles; else g.estimatedMiles += miles;
    g.rows.push(r);
  }
  const fuelByState = new Map((fuel.byState || []).map((f) => [f.jurisdiction, f.gallons]));

  const jurisdictions = Array.from(map.values()).map((g) => ({
    jurisdiction: g.jurisdiction,
    totalMiles: Math.round(g.totalMiles * 10) / 10,
    confirmedMiles: Math.round(g.confirmedMiles * 10) / 10,
    estimatedMiles: Math.round(g.estimatedMiles * 10) / 10,
    fullyConfirmed: g.estimatedMiles <= 0.05,
    fuelGallons: Math.round(((fuelByState.get(g.jurisdiction) || 0)) * 100) / 100,
    rowCount: g.rows.length,
  })).sort((a, b) => b.totalMiles - a.totalMiles);

  const totalMiles = jurisdictions.reduce((s, j) => s + j.totalMiles, 0);
  const totalConfirmedMiles = jurisdictions.reduce((s, j) => s + j.confirmedMiles, 0);
  const totalEstimatedMiles = jurisdictions.reduce((s, j) => s + j.estimatedMiles, 0);
  const totalGallons = fuel.totalGallons || 0;
  const mpg = totalGallons > 0 ? Math.round((totalMiles / totalGallons) * 100) / 100 : null;

  return {
    quarter,
    jurisdictions,
    totalMiles: Math.round(totalMiles * 10) / 10,
    taxableMiles: Math.round(totalMiles * 10) / 10,
    totalConfirmedMiles: Math.round(totalConfirmedMiles * 10) / 10,
    totalEstimatedMiles: Math.round(totalEstimatedMiles * 10) / 10,
    totalGallons: Math.round(totalGallons * 100) / 100,
    mpg,
    fullyConfirmed: jurisdictions.every((j) => j.fullyConfirmed),
  };
}

export function currentQuarter(now = new Date()) {
  const y = now.getFullYear();
  const q = Math.floor(now.getMonth() / 3) + 1;
  return `${y}-Q${q}`;
}

export function quarterDateRange(quarter) {
  const [y, q] = quarter.split('-Q').map(Number);
  const startMonth = (q - 1) * 3; // 0-indexed
  // Built purely with Date.UTC so the result never depends on the runtime's
  // local timezone (a local-time Date here could shift the date by a day
  // when the environment's offset is negative).
  const start = new Date(Date.UTC(y, startMonth, 1));
  const end = new Date(Date.UTC(y, startMonth + 3, 0)); // last day of quarter
  const fmt = (d) => d.toISOString().slice(0, 10);
  return { start: fmt(start), end: fmt(end) };
}
