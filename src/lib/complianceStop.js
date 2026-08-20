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

  const stopCity = `${stop?.stop_city || ''}, ${stop?.stop_state || ''}`.trim().replace(/,\s*$/, '');

  const notes = [
    `Leg 1: ${origin} → ${stopCity} · ~${Math.round(leg1Miles)} mi · ${leg1Hours.toFixed(1)} h driving.`,
    `Rest ${rest}h at ${stopCity} — resets ${[restResetsDrive ? '11h driving & 14h window' : null, restResetsCycle ? 'cycle' : null].filter(Boolean).join(', ') || 'no HOS clock (rest too short)'}.`,
    `Leg 2: ${stopCity} → ${destination} · ~${Math.round(leg2Miles)} mi · ${leg2Hours.toFixed(1)} h driving.`,
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
      city: stopCity,
      note: `${rest}h rest (compliance stop)`,
      miles_from_origin: leg1Miles,
    },
    notes,
  };
}