// ============================================================================
// LogbookAI — COMPLIANCE STOP SUGGESTION (deterministic, no AI).
// ----------------------------------------------------------------------------
// Given the driver's current HOS clocks and a planned route, compute:
//   • which clock is the limiting factor (11h driving / 14h window / cycle)
//   • the maximum miles the driver can still cover within that limit, using
//     the driver's planning speed profile (miles <-> hours are consistent)
//   • a proposed set of edits that makes the trip compliant: a rest stop at
//     the suggested location splitting the route into two driving legs, with
//     the rest duration chosen to reset the limiting clock
//
// The geographic stop itself is resolved by the complianceStop backend
// (routing/web-context LLM); THIS module only does the deterministic math and
// builds the proposal. Nothing here writes to the database. The page applies
// the proposal only after the driver approves it.
// ============================================================================

import { SPEED_PROFILES } from './proposalValidation';

const H = 3600000;

// Always render durations as X hr YY min — never raw floating point.
const fmtHM = (h) => {
  if (h == null || isNaN(h)) return '—';
  const totalMin = Math.round(h * 60);
  const hh = Math.floor(totalMin / 60);
  const mm = totalMin % 60;
  return `${hh} hr ${String(mm).padStart(2, '0')} min`;
};

// Planning mph for "how far can I get in X driving hours". Conservative uses a
// safe 55 mph planning average; fixed profiles use their value; provider falls
// back to the 50 mph assumed by the routing estimator.
export function planningMph(profileId) {
  const p = SPEED_PROFILES[profileId] || SPEED_PROFILES.conservative;
  if (p.mph) return p.mph;
  if (p.id === 'provider') return 50;
  return 55;
}

// Which remaining clock runs out first.
export function limitingClock(hos) {
  const driveH = (hos.driving?.drivingRemainingMs ?? 0) / H;
  const winH = (hos.window14?.remainingMs ?? 0) / H;
  const cycH = hos.cycle?.cycleRemainingHours ?? 0;
  const arr = [
    { key: 'driving', hours: driveH, label: '11-hour driving' },
    { key: 'window', hours: winH, label: '14-hour window' },
    { key: 'cycle', hours: cycH, label: 'cycle (60/70h)' },
  ].sort((a, b) => a.hours - b.hours);
  return { limiter: arr[0], all: arr };
}

// Max miles the driver can cover before hitting the limiting clock.
export function maxDriveMiles(hos, profileId) {
  return Math.max(0, limitingClock(hos).limiter.hours * planningMph(profileId));
}

export function legHours(miles, profileId) {
  const mph = planningMph(profileId);
  return mph > 0 ? miles / mph : null;
}

// Choose the rest duration that resets the limiting clock:
//   10h+ off/sleeper resets 11h driving & 14h window.
//   34h off/sleeper additionally resets the cycle.
export function restHoursForLimiter(limiterKey) {
  return limiterKey === 'cycle' ? 34 : 10;
}

// Multi-stop route planner. Simulates the trip mile-by-mile against the SAME
// canonical HOS numbers already produced by hosEngine.computeHOS (break30,
// driving, window14, cycle) — this function does not compute or duplicate any
// HOS rule itself; it only converts those already-computed HOURS into ROUTE
// MILES using the driver's planning speed profile, to say WHERE along the
// route each next stop becomes necessary. Returns an ordered list of
// { type: 'break'|'rest'|'restart', mile, durationHours, reason }.
//
//   'break'   — 30-minute qualifying break, required once 8 cumulative
//               driving hours are reached since the last qualifying break
//               (hos.break30, tracked by the canonical engine from the
//               driver's actual logged history — not reimplemented here).
//   'rest'    — 10-hour qualifying rest, required when the 11-hour driving
//               limit or 14-hour window would otherwise be exceeded.
//   'restart' — 34-hour restart, required when the 60/70-hour cycle would
//               otherwise be exceeded. Never suggested when the cycle is
//               unverified (cycleRemainingHours == null) — there is nothing
//               reliable to plan a restart against.
//
// These are TRIP-PLANNING SUGGESTIONS ONLY. Nothing here writes an event or
// claims to be an official RODS entry — the driver logs/confirms the actual
// stop when it happens, same as every other Trip Planner suggestion.
export function planTripStops({ hos, profileId, cycleType, totalMiles, maxStops = 12 } = {}) {
  const mph = planningMph(profileId);
  if (!(mph > 0) || !(totalMiles > 0) || !hos) return [];

  const fullCycle = cycleType === '60_7' ? 60 : 70;
  let milesCovered = 0;
  let milesToBreak = ((hos.break30?.remainingBeforeBreakMs ?? 0) / H) * mph;
  let driveRemaining = (hos.driving?.drivingRemainingMs ?? 0) / H;
  let windowRemaining = (hos.window14?.remainingMs ?? 0) / H;
  let cycleRemaining = Number.isFinite(hos.cycle?.cycleRemainingHours) ? hos.cycle.cycleRemainingHours : null;

  const stops = [];
  for (let i = 0; i < maxStops && milesCovered < totalMiles - 0.5; i++) {
    const remainingTripMiles = totalMiles - milesCovered;
    const candidates = [
      { type: 'break', miles: milesToBreak, reason: '8-hour cumulative driving threshold (30-minute break required)' },
      { type: 'rest', miles: driveRemaining * mph, reason: '11-hour driving limit' },
      { type: 'rest', miles: windowRemaining * mph, reason: '14-hour window' },
    ];
    if (cycleRemaining != null) candidates.push({ type: 'restart', miles: cycleRemaining * mph, reason: `${fullCycle}-hour cycle limit` });

    const next = candidates
      .filter((c) => Number.isFinite(c.miles) && c.miles >= 0)
      .sort((a, b) => a.miles - b.miles)[0];
    if (!next || next.miles >= remainingTripMiles - 0.5) break; // reaches destination before any boundary

    const stopMiles = Math.max(0, next.miles);
    const stopAtMile = milesCovered + stopMiles;
    const hoursDriven = stopMiles / mph;
    milesCovered = stopAtMile;

    if (next.type === 'break') {
      stops.push({ type: 'break', mile: stopAtMile, durationHours: 0.5, reason: next.reason });
      milesToBreak = 8 * mph; // qualifying break satisfied — 8-hour driving budget resets
      driveRemaining -= hoursDriven;
      windowRemaining -= hoursDriven + 0.5; // the window keeps running during the break itself
      if (cycleRemaining != null) cycleRemaining -= hoursDriven;
    } else if (next.type === 'rest') {
      stops.push({ type: 'rest', mile: stopAtMile, durationHours: 10, reason: next.reason });
      driveRemaining = 11;
      windowRemaining = 14;
      milesToBreak = 8 * mph;
      if (cycleRemaining != null) cycleRemaining -= hoursDriven;
    } else {
      stops.push({ type: 'restart', mile: stopAtMile, durationHours: 34, reason: next.reason });
      driveRemaining = 11;
      windowRemaining = 14;
      milesToBreak = 8 * mph;
      cycleRemaining = fullCycle;
    }
  }
  return stops;
}

// Build the proposed compliance edits: a rest stop at the suggested location
// splitting the route into two driving legs. Returns leg mileages/hours and
// per-leg feasibility so the UI can show exactly how miles match driving hours.
export function buildComplianceEdits({ origin, destination, stop, hos, profileId, cycleType, restHours } = {}) {
  const mph = planningMph(profileId);
  const fullCycle = cycleType === '60_7' ? 60 : 70;
  const { limiter } = limitingClock(hos);
  const rest = restHours != null ? restHours : restHoursForLimiter(limiter.key);

  const driveH = (hos.driving?.drivingRemainingMs ?? 0) / H;
  const winH = (hos.window14?.remainingMs ?? 0) / H;
  const cycH = hos.cycle?.cycleRemainingHours ?? 0;

  const leg1Miles = stop?.miles_from_origin ?? 0;
  const leg2Miles = stop?.miles_remaining ?? 0;
  const leg1Hours = leg1Miles / mph;
  const leg2Hours = leg2Miles / mph;

  const restResetsDrive = rest >= 10;
  const restResetsCycle = rest >= 34;
  const leg2DriveAvail = restResetsDrive ? 11 : driveH;
  const leg2CycleAvail = restResetsCycle ? fullCycle : cycH;

  const leg1DriveOk = leg1Hours <= driveH;
  const leg1WindowOk = leg1Hours <= winH;
  const leg1CycleOk = leg1Miles <= cycH * mph;
  const leg1Ok = leg1DriveOk && leg1WindowOk && leg1CycleOk;

  const leg2DriveOk = leg2Hours <= leg2DriveAvail;
  const leg2CycleOk = leg2Hours <= leg2CycleAvail;
  const overallOk = leg1Ok && leg2DriveOk && leg2CycleOk;

  const stopCity = `${stop?.stop_city || ''}, ${stop?.stop_state || ''}`.trim().replace(/,\s*$/, '').replace(/^,\s*/, '') || 'Suggested stopping area';
  const stopArea = stop?.verified ? stopCity : 'Suggested stopping area';

  const notes = [
    `Leg 1: ${origin} → ${stopArea} · ~${Math.round(leg1Miles)} mi · ${fmtHM(leg1Hours)} driving.`,
    `Rest ${fmtHM(rest)} at ${stopArea} — resets ${[restResetsDrive ? '11h driving & 14h window' : null, restResetsCycle ? 'cycle' : null].filter(Boolean).join(', ') || 'no HOS clock (rest too short)'}.`,
    `Leg 2: ${stopArea} → ${destination} · ~${Math.round(leg2Miles)} mi · ${fmtHM(leg2Hours)} driving.`,
    leg2CycleOk ? '' : 'Cycle still limiting after this rest — a 34h restart or a correction to an over-stated prior driving entry is needed before Leg 2.',
  ].filter(Boolean);

  return {
    limiter: limiter.key,
    limiterLabel: limiter.label,
    mph,
    restHours: rest,
    leg1Miles, leg2Miles, leg1Hours, leg2Hours,
    leg1Ok, leg2DriveOk, leg2CycleOk, overallOk,
    needsCycleFix: !leg2CycleOk,
    stopEvent: {
      type: 'rest',
      city: stopArea,
      note: `${fmtHM(rest)} rest (planned)`,
      miles_from_origin: leg1Miles,
    },
    notes,
  };
}