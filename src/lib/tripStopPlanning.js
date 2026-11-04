// ============================================================================
// LogbookAI — TRIP PLANNER HOS-STOP PLANNING BOUNDARY.
// ----------------------------------------------------------------------------
// One narrow seam between the canonical, deterministic HOS engine and the Trip
// Planner UI. It answers three questions and nothing else:
//
//   1. Is the driver's HOS verified AS OF NOW, or only verified through an
//      earlier timestamp (a trailing unrecorded interval), or not at all?
//      Historical clocks are real history — they are never current driving
//      eligibility.
//
//   2. Is driving even possible before a qualifying rest? If a clock is
//      already exhausted (e.g. the 14-hour window has expired), the answer is
//      "rest required before departure" — the reset rule decides the hours.
//
//   3. What is a valid complianceStop request? A zero/negative distance is
//      never sent: there is no stop to look up, so it is handled locally.
//
// This module does NOT compute any HOS rule of its own. planTripStopsGuarded()
// wraps the existing planTripStops() simulation in complianceStop.js, which in
// turn only converts hosEngine.computeHOS()'s already-computed hours into route
// miles. The canonical engine, agricultural logic and stored records are
// untouched.
// ============================================================================

import { planTripStops, maxDriveMiles, restHoursForLimiter } from './complianceStop';
import { validateMaxDriveMiles } from './stopRequest';

const H = 3600000;

// verified_now     — clocks cover the present instant; current eligibility can
//                    be stated.
// verified_through — clocks are valid only up to lastVerifiedAt (a trailing,
//                    unrecorded stretch follows); current eligibility withheld.
// unavailable      — the timeline itself is invalid/incomplete; nothing usable.
export const TRIP_HOS_STATE = Object.freeze({
  VERIFIED_NOW: 'verified_now',
  VERIFIED_THROUGH: 'verified_through',
  UNAVAILABLE: 'unavailable',
});

// Which HOS numbers a plan may be built from, and how it must be labeled.
//   verified_now  — the driver's real, current remaining clocks.
//   hypothetical  — a fresh, fully-rested day, only after explicit opt-in.
//   hidden        — no plan at all (no reachable recommendations).
export const PLAN_BASIS = Object.freeze({
  VERIFIED_NOW: 'verified_now',
  HYPOTHETICAL: 'hypothetical',
  HIDDEN: 'hidden',
});

// Resolves the current-vs-historical HOS state from BOTH signals the app
// already produces: whatCanIDo()'s availability object (undetermined /
// unavailable) and computeHOS()'s own availability block (verified_through with
// a lastVerifiedAt timestamp).
export function resolveTripHosState(availability, hos) {
  const lastVerifiedAt =
    hos?.availability?.lastVerifiedAt || availability?.lastVerifiedAt || null;
  if (availability?.unavailable) {
    return { state: TRIP_HOS_STATE.UNAVAILABLE, lastVerifiedAt: null };
  }
  if (hos?.availability?.status === 'verified_through') {
    return { state: TRIP_HOS_STATE.VERIFIED_THROUGH, lastVerifiedAt };
  }
  if (availability?.undetermined) {
    return { state: TRIP_HOS_STATE.VERIFIED_THROUGH, lastVerifiedAt };
  }
  return { state: TRIP_HOS_STATE.VERIFIED_NOW, lastVerifiedAt: null };
}

// A plan is only ever built from current clocks, or — after explicit opt-in —
// as a clearly labeled assumption. There is no silent third path.
export function resolvePlanBasis(hosState, hypotheticalOptIn = false) {
  if (hosState === TRIP_HOS_STATE.VERIFIED_NOW) return PLAN_BASIS.VERIFIED_NOW;
  return hypotheticalOptIn ? PLAN_BASIS.HYPOTHETICAL : PLAN_BASIS.HIDDEN;
}

// Is a qualifying rest required BEFORE departure? True when a clock that
// governs driving is already exhausted. The rest length follows the existing
// reset rules: 10 hours reopens the 11-hour/14-hour clocks; a 34-hour restart
// is the only thing that recovers an exhausted cycle (and covers the rest).
// `reasons` are stable keys (window14 / driving11 / cycle) for translation.
export function departureRestRequirement(hos) {
  const driveRemainingH = (hos?.driving?.drivingRemainingMs ?? 0) / H;
  const windowRemainingH = (hos?.window14?.remainingMs ?? 0) / H;
  const cycleRemainingH = hos?.cycle?.cycleRemainingHours;

  const reasons = [];
  if (!(windowRemainingH > 0)) reasons.push('window14');
  if (!(driveRemainingH > 0)) reasons.push('driving11');
  if (typeof cycleRemainingH === 'number' && !(cycleRemainingH > 0)) reasons.push('cycle');
  if (reasons.length === 0) return { required: false, hours: null, reasons: [] };

  const hours = reasons.includes('cycle')
    ? restHoursForLimiter('cycle')
    : restHoursForLimiter('window14');
  return { required: true, hours, reasons };
}

// How far the driver can actually drive before the limiting clock — clamped,
// and refused when there is no positive distance at all.
export function resolveStopLookupMiles(hos, profileId) {
  const raw = maxDriveMiles(hos, profileId);
  const miles = Number.isFinite(raw) ? Math.max(0, raw) : 0;
  const check = validateMaxDriveMiles(miles);
  return check.ok ? { ok: true, miles } : { ok: false, miles: 0, error: 'no_drive_distance' };
}

// Builds the complianceStop payload, or refuses locally. Callers must never
// invoke the API unless `ok` is true.
export function buildStopLookupRequest({ origin, destination, miles } = {}) {
  const o = (origin || '').trim();
  const d = (destination || '').trim();
  if (!o || !d) return { ok: false, error: 'route_missing' };
  const check = validateMaxDriveMiles(miles);
  if (!check.ok) {
    const numeric = Number(miles);
    const error = Number.isFinite(numeric) && numeric < 0 ? 'invalid_miles' : 'no_drive_distance';
    return { ok: false, error, detail: check.error };
  }
  return { ok: true, payload: { origin: o, destination: d, max_drive_miles: check.miles } };
}

// Route stop plan, gated on the departure check. Delegates the HOS -> miles
// conversion to the canonical planTripStops(); the only thing added here is
// refusing a stop at ~mile 0 (a clock already exhausted at departure) and
// never emitting a non-positive mileage for a later lookup.
export function planTripStopsGuarded({ hos, profileId, cycleType, totalMiles } = {}) {
  const departureRest = departureRestRequirement(hos);
  if (departureRest.required) return { stops: [], departureRest };
  const stops = planTripStops({ hos, profileId, cycleType, totalMiles })
    .filter((s) => Number.isFinite(s.mile) && s.mile > 0);
  return { stops, departureRest };
}