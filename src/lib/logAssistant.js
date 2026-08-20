// ============================================================================
// LogbookAI Manual Log Assistant — DETERMINISTIC helpers (no AI).
// ----------------------------------------------------------------------------
// All HOS math here delegates to src/lib/hosEngine.js. Nothing in this file
// calls an LLM. It merges AI-proposed events with actual events, runs the
// deterministic engine on the merged timeline, extracts violations, answers
// "What Can I Do?" questions, and checks location/time reasonableness.
// Planned events NEVER touch authoritative clocks — only a confirmed Apply
// writes to DutyStatusEvent (done by the page, not here).
// ============================================================================

import {
  computeHOS, runComplianceCheck, normalizeEvents, buildRestBlocks,
  evaluateSplitSleeper, compute34Restart, fmtDur, dateKeyInTz,
} from './hosEngine';

const H = 3600000;
const MIN = 60000;

// ---------------------------------------------------------------------------
// Merge AI-proposed events with existing actual events into a simulated
// timeline for HOS computation. The current ongoing event (if any) is ended
// at the first proposed start. Proposed events are returned as
// DutyStatusEvent-shaped objects with a `_proposed: true` marker.
// ---------------------------------------------------------------------------
export function mergeProposedEvents(existing, proposed, now = new Date()) {
  const props = (proposed || []).map((p, i) => ({
    id: `proposed-${i}`,
    log_date: p.date || (p.start_timestamp ? p.start_timestamp.slice(0, 10) : dateKeyInTz(now, 'UTC')),
    start_timestamp: p.start_timestamp,
    end_timestamp: p.end_timestamp || null,
    duty_status: p.duty_status,
    city: p.city || '', state: p.state || '',
    remark: p.remark || (p.activity_type ? p.activity_type : ''),
    tractor_number: p.tractor_number || '',
    trailer_numbers: p.trailer_numbers || '',
    method_of_creation: p.source === 'voice' ? 'Voice AI' : 'Typed AI',
    is_ongoing: !p.end_timestamp,
    is_current_version: true,
    _proposed: true,
  })).filter(p => p.start_timestamp && p.duty_status);

  if (props.length === 0) return [...(existing || [])];

  const firstStart = props.reduce((m, p) => {
    const t = new Date(p.start_timestamp).getTime();
    return t < m ? t : m;
  }, Infinity);

  const merged = (existing || []).map(e => {
    if (e.is_ongoing && new Date(e.start_timestamp).getTime() < firstStart) {
      return { ...e, end_timestamp: new Date(firstStart).toISOString(), is_ongoing: false };
    }
    return e;
  }).filter(e => e && e.start_timestamp);

  return [...merged, ...props];
}

// ---------------------------------------------------------------------------
// Run the deterministic HOS engine on a merged (existing + proposed) timeline.
// Evaluation time is the latest of (now, last proposed end) so the resulting
// clocks reflect the end of the proposed day. Returns HOS + a violations list.
// ---------------------------------------------------------------------------
export function computeProposedHOS(existing, proposed, cycleType, tz, now = new Date(), enteredPriorHistory = false) {
  const merged = mergeProposedEvents(existing, proposed, now);
  let evalNow = now instanceof Date ? now : new Date(now);
  for (const p of (proposed || [])) {
    if (p.end_timestamp) {
      const t = new Date(p.end_timestamp).getTime();
      if (t > evalNow.getTime()) evalNow = new Date(t);
    }
  }
  const hos = computeHOS(merged, cycleType, tz, evalNow, { historyComplete: true });
  const issues = runComplianceCheck(merged, cycleType, tz, evalNow, { historyComplete: true });
  const violations = collectViolations(hos, issues);
  return { hos, issues, violations, evalNow, merged };
}

// Flatten HOS issues into a simple severity-tagged list.
export function collectViolations(hos, issues) {
  const out = [];
  for (const v of (issues?.hos || [])) {
    out.push({ rule: v.rule, severity: v.severity, message: v.message });
  }
  return out;
}

export function highestSeverity(violations) {
  if (!violations || violations.length === 0) return 'green';
  if (violations.some(v => v.severity === 'egregious' || v.severity === 'violation')) return 'red';
  return 'amber';
}

// ---------------------------------------------------------------------------
// "WHAT CAN I DO?" — fully deterministic. No AI. Answers common driver
// questions from the driver's ACTUAL records. Distinguishes availability NOW
// from availability that would arise IF the driver completes a qualifying
// rest that has not yet happened.
// ---------------------------------------------------------------------------
export function whatCanIDo(events, cycleType, tz, now = new Date()) {
  const segments = normalizeEvents(events, now);
  const hos = computeHOS(events, cycleType, tz, now, { historyComplete: true });

  // Current rest block (if the driver is resting right now)
  const restBlocks = buildRestBlocks(segments);
  const lastBlock = restBlocks[restBlocks.length - 1];
  const restingNow = lastBlock && lastBlock.end >= now;

  let tenHourCompletesAt = null;
  let thirtyFourCompletesAt = null;
  if (restingNow) {
    const elapsed = now - lastBlock.start;
    if (elapsed < 10 * H) tenHourCompletesAt = new Date(lastBlock.start.getTime() + 10 * H);
    if (elapsed < 34 * H) thirtyFourCompletesAt = new Date(lastBlock.start.getTime() + 34 * H);
  }

  // Split sleeper is an OPTIONAL optimization (FMCSA §395.1(g)). Surfaced
  // informationally — never as a warning or requirement.
  const split = evaluateSplitSleeper(segments, now);
  let splitAvailableNow = split.status === 'active';
  let splitConditional = null;
  if (split.status === 'available' && split.firstPeriod) {
    const proj = split.projectedDrivingRemainingMs != null && split.projectedWindowRemainingMs != null
      ? ` Once completed, ~${fmtDur(Math.max(0, split.projectedDrivingRemainingMs))} driving and ~${fmtDur(Math.max(0, split.projectedWindowRemainingMs))} on the 14-hour window would be available.`
      : '';
    splitConditional = {
      label: 'Split Sleeper Available',
      description: `You have a ${fmtDur(split.firstPeriod.duration)} qualifying period. Complete ${fmtDur(split.requiredSecondMs)} more qualifying rest to activate the split (optional).${proj}`,
      completesAt: null,
    };
  }

  const restart = hos.restart;

  // --- Driving availability: exact reasons + eligible time ---
  // Build a prioritized list of blockers. Each carries the specific reason and,
  // where determinable, the time the blocker clears (eligibleAt).
  const driveRemainingMs = hos.driving.applicable ? Math.max(0, hos.driving.drivingRemainingMs) : 0;
  const windowRemainingMs = hos.window14.applicable ? Math.max(0, hos.window14.remainingMs) : 0;
  const cycleRemainingHours = hos.cycle ? Math.max(0, hos.cycle.cycleRemainingHours) : 0;
  const cycleRemainingMs = cycleRemainingHours * H;

  const blockers = [];
  if (hos.break30.breakRequired) {
    blockers.push({
      rule: '30-minute break',
      message: 'A 30-minute qualifying break is required before driving more than 8 hours.',
      eligibleAt: null,
    });
  }
  if (!hos.driving.applicable || driveRemainingMs <= 0) {
    blockers.push({
      rule: '11-hour driving limit',
      message: 'You have used all 11 hours of driving time. A 10-hour rest resets the drive clock.',
      eligibleAt: tenHourCompletesAt,
    });
  }
  if (!hos.window14.applicable || windowRemainingMs <= 0) {
    blockers.push({
      rule: '14-hour window',
      message: 'Your 14-hour duty window is closed. A 10-hour rest reopens it.',
      eligibleAt: tenHourCompletesAt,
    });
  }
  if (cycleRemainingHours <= 0) {
    blockers.push({
      rule: `${hos.cycle?.cycleLimit || 70}-hour cycle`,
      message: `You have used all ${hos.cycle?.cycleLimit || 70} cycle hours. A 34-hour restart is required.`,
      eligibleAt: thirtyFourCompletesAt || (restart.inProgress ? restart.estimatedCompletion : null),
    });
  }

  const canDrive = blockers.length === 0;

  // The earliest time driving becomes legal again (earliest blocker eligibleAt).
  const eligibleAts = blockers.map(b => b.eligibleAt).filter(Boolean);
  const driveEligibleAt = eligibleAts.length
    ? new Date(Math.min(...eligibleAts.map(d => new Date(d).getTime())))
    : (canDrive ? new Date(now.getTime()) : null);

  // USABLE vs REMAINING distinction:
  //  remainingDriveMs = the raw 11-hour driving clock (what the rule allows in total).
  //  usableDriveMs    = what you can actually use NOW, bounded by the 14-hour
  //                     window (the tighter limit always governs), and 0 if a
  //                     blocker (break/cycle/rest-not-done) prevents driving now.
  let usableDriveMs = 0;
  if (canDrive) {
    usableDriveMs = Math.min(driveRemainingMs, windowRemainingMs);
  } else if (!hos.break30.breakRequired && driveRemainingMs > 0 && windowRemainingMs > 0 && cycleRemainingHours > 0) {
    // Not blocked by HOS clocks or break — but resting now: usable after rest.
    usableDriveMs = 0;
  }

  return {
    canDrive,
    driveBlockers: blockers,
    driveEligibleAt,
    driveRemainingMs,
    usableDriveMs,
    windowRemainingMs,
    breakRequired: hos.break30.breakRequired,
    breakSatisfied: hos.break30.satisfied,
    cycleRemainingHours,
    cycleRemainingMs,
    cycleReturningTomorrow: hos.cycle.returningTomorrowHours,
    tenHourCompletesAt,
    thirtyFourCompletesAt,
    splitAvailableNow,
    splitConditional,
    restartInProgress: restart.inProgress || null,
    restartCompleted: restart.completed || null,
    restingNow,
  };
}

// ---------------------------------------------------------------------------
// LOCATION / TIME REASONABLENESS
// Rough great-circle distance between two city centers; flags if the implied
// average speed exceeds 70 mph (truck-unrealistic). Used only as an accuracy
// warning — never auto-edits anything.
// ---------------------------------------------------------------------------
export const CITY_COORDS = {
  'miami,fl': [25.7617, -80.1918],
  'ocala,fl': [29.1872, -82.1401],
  'atlanta,ga': [33.749, -84.388],
  'jacksonville,fl': [30.3322, -81.6557],
  'orlando,fl': [28.5383, -81.3792],
  'tampa,fl': [27.9506, -82.4572],
  'nashville,tn': [36.1627, -86.7816],
  'dallas,tx': [32.7767, -96.797],
  'houston,tx': [29.7604, -95.3698],
  'chicago,il': [41.8781, -87.6298],
  'dallas,tx': [32.7767, -96.797],
  'macon,ga': [32.8407, -83.6324],
  'savannah,ga': [32.0809, -81.0912],
  'neworleans,la': [29.9511, -90.0715],
  'memphis,tn': [35.1495, -90.049],
  'knoxville,tn': [35.9606, -83.9207],
  'albany,ny': [42.6526, -73.7562],
  'chattanooga,tn': [35.0456, -85.3097],
  'gainesville,fl': [29.6516, -82.3248],
};

function haversineMiles(a, b) {
  if (!a || !b) return null;
  const R = 3958.8;
  const dLat = (b[0] - a[0]) * Math.PI / 180;
  const dLon = (b[1] - a[1]) * Math.PI / 180;
  const la1 = a[0] * Math.PI / 180, la2 = b[0] * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function distanceReasonableness(cityA, stateA, cityB, stateB, timeGapMs) {
  const keyA = `${(cityA || '').toLowerCase().replace(/\s/g, '')},${(stateA || '').toLowerCase()}`;
  const keyB = `${(cityB || '').toLowerCase().replace(/\s/g, '')},${(stateB || '').toLowerCase()}`;
  const a = CITY_COORDS[keyA];
  const b = CITY_COORDS[keyB];
  if (!a || !b || !timeGapMs || timeGapMs <= 0) return { known: false };
  const miles = haversineMiles(a, b);
  const hours = timeGapMs / H;
  const avgSpeed = miles / hours;
  return {
    known: true,
    miles: Math.round(miles),
    hours: Number(hours.toFixed(2)),
    avgSpeed: Number(avgSpeed.toFixed(1)),
    conflict: avgSpeed > 70,
    note: avgSpeed > 70
      ? `Implied average speed ~${avgSpeed.toFixed(0)} mph between ${cityA}, ${stateA} and ${cityB}, ${stateB} is not realistic for a truck. Review the time or location.`
      : `Distance ~${Math.round(miles)} mi in ${hours.toFixed(1)} h (~${avgSpeed.toFixed(0)} mph) is plausible.`,
  };
}

// ---------------------------------------------------------------------------
// EQUIPMENT CHANGE — build an ON_DUTY equipment-change proposed event from a
// before/after trailer description. Preserves the historical association.
// ---------------------------------------------------------------------------
export function buildEquipmentChangeEvent({ date, start_timestamp, end_timestamp, city, state, tractorBefore, tractorAfter, trailerBefore, trailerAfter, action }) {
  const remark = action === 'bobtail'
    ? `Bobtail — dropped trailer ${trailerBefore}`
    : `Equipment change — dropped ${trailerBefore || ''}, hooked ${trailerAfter || ''}`.replace(/dropped , /, 'dropped ');
  return {
    date,
    start_timestamp,
    end_timestamp,
    duty_status: 'ON_DUTY',
    activity_type: 'Equipment Change',
    city, state,
    tractor_number: tractorAfter || tractorBefore || '',
    trailer_numbers: trailerAfter || '',
    remark,
    source: 'manual',
    confidence: 'high',
    ambiguous_fields: [],
  };
}

// ---------------------------------------------------------------------------
// PRE-TRIP detection in a proposed timeline. Returns true if an ON_DUTY
// pre-trip event exists before the first DRIVING event.
// ---------------------------------------------------------------------------
export function hasPretripInProposed(proposed) {
  const firstDriving = (proposed || []).findIndex(p => p.duty_status === 'DRIVING');
  if (firstDriving < 0) return true;
  return (proposed || []).slice(0, firstDriving).some(p =>
    p.duty_status === 'ON_DUTY' && /pre.?trip/i.test(p.activity_type || p.remark || '')
  );
}

// ---------------------------------------------------------------------------
// GUARD: ensure a proposed set contains no Driving→NonDriving conversion that
// would merely erase a violation without factual basis. (Used by tests; the
// AI safety boundary is enforced in the prompt, this is a deterministic check
// that the proposal did not convert an existing Driving event to Off/Sleeper
// unless marked as a factual correction.)
// ---------------------------------------------------------------------------
export function isFabricatedViolationFix(existing, proposedCorrections) {
  // A correction is suspect if it changes an existing DRIVING event to
  // OFF_DUTY or SLEEPER_BERTH without an activity_type indicating a real
  // stopped activity (Fuel/Loading/etc.).
  for (const c of (proposedCorrections || [])) {
    const ev = (existing || []).find((e, i) => i === c.event_index);
    if (ev && ev.duty_status === 'DRIVING' &&
      (c.proposed_event?.duty_status === 'OFF_DUTY' || c.proposed_event?.duty_status === 'SLEEPER_BERTH')) {
      const act = (c.proposed_event?.activity_type || c.proposed_event?.remark || '').toLowerCase();
      if (!/fuel|load|unload|break|inspection|pre.?trip|stop/.test(act)) {
        return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Convert a future plan (from AI) into planned TripStops — NOT actual events.
// Returns stops only; the page may save them as a planned Trip.
// ---------------------------------------------------------------------------
export function planToStops(plan, now = new Date()) {
  return (plan || []).map((step, i) => ({
    sequence: step.sequence || i + 1,
    stop_type: stepToStopType(step.type),
    city: step.city || '',
    state: step.state || '',
    appointment_time: step.start_offset_min != null
      ? new Date(now.getTime() + step.start_offset_min * MIN).toISOString()
      : null,
    planned: true,
    remark: step.label || '',
  }));
}

function stepToStopType(type) {
  switch ((type || '').toLowerCase()) {
    case 'drive': return 'stop';
    case 'fuel': return 'fuel';
    case 'break': return 'break';
    case 'sleeper':
    case 'offduty': return 'rest';
    default: return 'stop';
  }
}

// ---------------------------------------------------------------------------
// Certified-log correction: build the EventVersion snapshot that preserves the
// original event before it is corrected. The corrected log is then marked as
// requiring re-certification (the page supersedes the active Certification).
// ---------------------------------------------------------------------------
export function buildCorrectionVersion(target, reason, editedBy) {
  return {
    original_event_id: target?.id || null,
    version_number: 1,
    snapshot: { ...target },
    edited_by: editedBy || '',
    edit_reason: reason || 'Corrected entry',
    action: 'corrected',
  };
}

// ---------------------------------------------------------------------------
// FORMAT helpers
// ---------------------------------------------------------------------------
export function fmtClockShort(date, tz) {
  if (!date) return '--';
  return new Date(date).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz });
}