// ============================================================================
// LogbookAI — IFTA data access. Thin wrappers around base44 entities/functions
// only; all resolution logic lives in the pure, testable iftaResolver.js.
// Nothing here reads or writes DutyStatusEvent except as a read-only source
// for deriving driving legs — never a write target.
// ============================================================================
import { base44 } from '@/api/base44Client';
import { getAllEvents } from '@/lib/driverData';
import {
  resolveMissingDays, recomputeDay, eventsForDay, currentQuarter, quarterDateRange, IFTA_RESOLVER_VERSION,
} from '@/lib/iftaResolver';

export async function getIftaMileageRecords(quarter) {
  return await base44.entities.IftaJurisdictionMileage.filter({ quarter }, '-log_date', 2000) || [];
}

async function routeSplit(origin, destination) {
  try {
    const res = await base44.functions.invoke('iftaRouteSplit', { origin, destination });
    return res?.data || res;
  } catch (e) {
    return { error: e?.message || 'Route split failed' };
  }
}

async function upsertMileageRow({ existingRow, log_date, quarter, jurisdiction, miles, mileage_source, confirmed, source_event_ids, resolver_version }) {
  const payload = { log_date, quarter, jurisdiction, miles, mileage_source, confirmed, source_event_ids, resolver_version };
  if (existingRow?.id) return await base44.entities.IftaJurisdictionMileage.update(existingRow.id, payload);
  return await base44.entities.IftaJurisdictionMileage.create(payload);
}

// Runs the background resolver for one quarter. Safe to call repeatedly
// (idempotent for already-resolved days) and safe to call with IFTA tracking
// disabled — callers must gate on ifta_tracking_enabled before invoking this,
// but this function itself never touches HOS or duty-status data either way.
export async function runIftaResolverForQuarter(quarter, timezone) {
  const { start, end } = quarterDateRange(quarter);
  const [allEvents, existingRecords] = await Promise.all([
    getAllEvents(),
    getIftaMileageRecords(quarter),
  ]);
  const startMs = new Date(`${start}T00:00:00Z`).getTime();
  const endMs = new Date(`${end}T23:59:59Z`).getTime();
  const events = (allEvents || []).filter((e) => {
    if (!e.start_timestamp) return false;
    const t = new Date(e.start_timestamp).getTime();
    return t >= startMs - 24 * 3600000 && t <= endMs + 24 * 3600000; // small pad for timezone edges
  });

  return await resolveMissingDays({
    events,
    timezone,
    existingRecords,
    routeSplitFn: routeSplit,
    upsertFn: upsertMileageRow,
    resolverVersion: IFTA_RESOLVER_VERSION,
  });
}

// Manual "Recalculate day" action: re-derives one calendar day's mileage from
// the driver's current (possibly just-edited) trip/location data. Only
// route_estimated/odometer_derived rows are refreshed; driver_entered /
// driver_confirmed rows are preserved unless `replaceConfirmed` is true (the
// driver explicitly opted in). Never touches DutyStatusEvent.
export async function recomputeDayForQuarter({ logDate, quarter, timezone, replaceConfirmed = false }) {
  const [allEvents, existingForQuarter] = await Promise.all([
    getAllEvents(),
    getIftaMileageRecords(quarter),
  ]);
  const dayEvents = eventsForDay(allEvents, logDate, timezone);
  const existingRecords = existingForQuarter.filter((r) => r.log_date === logDate);

  return await recomputeDay({
    dayEvents,
    logDate,
    existingRecords,
    routeSplitFn: routeSplit,
    upsertFn: upsertMileageRow,
    resolverVersion: IFTA_RESOLVER_VERSION,
    replaceConfirmed,
  });
}

// Driver confirms an estimated/derived row as-is.
export async function confirmMileageRow(row) {
  return await base44.entities.IftaJurisdictionMileage.update(row.id, {
    mileage_source: 'driver_confirmed',
    confirmed: true,
  });
}

// Driver corrects a jurisdiction's mileage for a day — always becomes
// driver_entered and is never overwritten by the background resolver again.
export async function setDriverMileage({ existingRow, log_date, quarter, jurisdiction, miles }) {
  const payload = {
    log_date, quarter, jurisdiction, miles,
    mileage_source: 'driver_entered',
    confirmed: true,
    source_event_ids: [],
    resolver_version: null,
  };
  if (existingRow?.id) return await base44.entities.IftaJurisdictionMileage.update(existingRow.id, payload);
  return await base44.entities.IftaJurisdictionMileage.create(payload);
}

// Fuel-by-jurisdiction, reused directly from existing FuelReceipt records —
// no duplicate entry. Computed live; nothing is persisted or duplicated.
export async function getFuelByJurisdiction(quarter) {
  const { start, end } = quarterDateRange(quarter);
  let receipts = [];
  try {
    receipts = await base44.entities.FuelReceipt.list('-receipt_date', 1000) || [];
  } catch (e) {
    return { byState: [], totalGallons: 0, error: e?.message || 'Could not load fuel receipts.' };
  }
  const inRange = receipts.filter((r) => r.receipt_date && r.receipt_date >= start && r.receipt_date <= end);
  const byState = new Map();
  let totalGallons = 0;
  for (const r of inRange) {
    const state = String(r.state || '').trim().toUpperCase();
    const gallons = Number(r.gallons) || 0;
    if (!state || !gallons) continue;
    byState.set(state, (byState.get(state) || 0) + gallons);
    totalGallons += gallons;
  }
  return {
    byState: Array.from(byState.entries()).map(([jurisdiction, gallons]) => ({ jurisdiction, gallons: Math.round(gallons * 100) / 100 })),
    totalGallons: Math.round(totalGallons * 100) / 100,
  };
}

export { currentQuarter, quarterDateRange };
