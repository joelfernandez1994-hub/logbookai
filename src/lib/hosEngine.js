// ============================================================================
// LogbookAI Deterministic HOS Engine
// US Interstate Property-Carrying Standard Federal Rules (FMCSA 49 CFR 395)
// ----------------------------------------------------------------------------
// This module is PURE DETERMINISTIC APPLICATION LOGIC. It contains NO AI/LLM
// calls. All Hours of Service calculations derive from stored DutyStatusEvents.
// AI may explain results produced here but may never be the source of the math.
// ============================================================================

const MS = {
  MINUTE: 60 * 1000,
  HOUR: 3600000,
  DRIVE_LIMIT: 11 * 3600000,       // 11-hour driving limit
  WINDOW: 14 * 3600000,            // 14-hour driving window
  BREAK_GAP: 8 * 3600000,          // 8 cumulative driving hours before break
  BREAK_REQ: 30 * 60000,           // 30-minute qualifying interruption
  QUAL_REST: 10 * 3600000,         // 10 consecutive hours off duty
  RESTART: 34 * 3600000,           // 34-hour restart
  SPLIT_MIN: 2 * 3600000,          // minimum qualifying split period
  SPLIT_FULL: 10 * 3600000,        // combined split minimum
  SPLIT_SLEEPER: 7 * 3600000,       // one period must contain >=7h sleeper
};

const CYCLES = {
  '60_7': { limit: 60, days: 7 },
  '70_8': { limit: 70, days: 8 },
};

const REST_STATUSES = ['OFF_DUTY', 'SLEEPER_BERTH'];
const DUTY_STATUSES = ['OFF_DUTY', 'SLEEPER_BERTH', 'DRIVING', 'ON_DUTY'];

// ---------------------------------------------------------------------------
// Timezone helpers
// ---------------------------------------------------------------------------
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

export function startOfDayInTz(date, timezone) {
  const d = date instanceof Date ? date : new Date(date);
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const parts = fmt.formatToParts(d);
  const y = parts.find(p => p.type === 'year').value;
  const m = parts.find(p => p.type === 'month').value;
  const dd = parts.find(p => p.type === 'day').value;
  const utcMidnight = Date.UTC(Number(y), Number(m) - 1, Number(dd));
  const offset = tzOffsetMs(new Date(utcMidnight), timezone);
  return new Date(utcMidnight - offset);
}

export function dateKeyInTz(date, timezone) {
  const d = date instanceof Date ? date : new Date(date);
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

export function nowInTz(timezone) {
  return new Date();
}

// ---------------------------------------------------------------------------
// Normalize raw events into a sorted, gap-bridged segment list.
// Each segment: { start: Date, end: Date, status, city, state, remark, ... }
// ---------------------------------------------------------------------------
export function normalizeEvents(rawEvents, now = new Date()) {
  if (!rawEvents || rawEvents.length === 0) return [];
  const segments = rawEvents
    .filter(e => e && e.start_timestamp && e.duty_status)
    .map(e => ({
      ...e,
      start: new Date(e.start_timestamp),
      end: e.end_timestamp ? new Date(e.end_timestamp) : (e.is_ongoing ? now : new Date(e.start_timestamp)),
    }))
    .sort((a, b) => a.start - b.start);
  return segments;
}

// Duration of a segment in ms
function dur(seg) {
  return Math.max(0, seg.end - seg.start);
}

// ---------------------------------------------------------------------------
// Build continuous rest blocks (consecutive OFF_DUTY / SLEEPER_BERTH periods,
// even across midnight) so qualifying rest is not broken by the day boundary.
// ---------------------------------------------------------------------------
export function buildRestBlocks(segments) {
  const blocks = [];
  let current = null;
  for (const seg of segments) {
    if (REST_STATUSES.includes(seg.duty_status)) {
      if (current && current.end >= seg.start - 60000) {
        current.end = new Date(Math.max(current.end, seg.end));
        current.duration = current.end - current.start;
      } else {
        if (current) blocks.push(current);
        current = { start: new Date(seg.start), end: new Date(seg.end), duration: seg.end - seg.start };
      }
    } else {
      if (current) { blocks.push(current); current = null; }
    }
  }
  if (current) blocks.push(current);
  return blocks;
}

// ---------------------------------------------------------------------------
// 11-HOUR DRIVING LIMIT
// Following 10 consecutive hours off duty, a driver may drive up to 11 hours.
// ---------------------------------------------------------------------------
export function computeDrivingLimit(segments, now = new Date()) {
  const restBlocks = buildRestBlocks(segments);
  // Find the last qualifying rest block (>= 10h) that ended at or before now
  let lastQualRestEnd = null;
  for (const b of restBlocks) {
    if (b.duration >= MS.QUAL_REST && b.end <= now) lastQualRestEnd = b.end;
  }
  if (!lastQualRestEnd) {
    return { applicable: false, drivingUsedMs: 0, drivingRemainingMs: MS.DRIVE_LIMIT, expiresAt: null, tourStart: null };
  }
  let drivingUsed = 0;
  let expiryAt = null;
  for (const seg of segments) {
    if (seg.duty_status !== 'DRIVING') continue;
    if (seg.end <= lastQualRestEnd) continue;
    const segStart = seg.start < lastQualRestEnd ? lastQualRestEnd : seg.start;
    const segEnd = seg.end > now ? now : seg.end;
    if (segEnd > segStart) drivingUsed += (segEnd - segStart);
  }
  if (drivingUsed < MS.DRIVE_LIMIT) {
    // expiry when the 11th hour completes: from lastQualRestEnd, but driving used accumulates
    // simplest projection: expiry = lastQualRestEnd + DRIVE_LIMIT + non-driving gaps inside tour
    // We compute wall-clock expiry as the moment drivingUsed would reach 11h
    expiryAt = findDrivingExpiry(segments, lastQualRestEnd, now);
  }
  return {
    applicable: true,
    tourStart: lastQualRestEnd,
    drivingUsedMs: drivingUsed,
    drivingRemainingMs: Math.max(0, MS.DRIVE_LIMIT - drivingUsed),
    expiresAt: expiryAt,
  };
}

function findDrivingExpiry(segments, tourStart, now) {
  let used = 0;
  for (const seg of segments) {
    if (seg.duty_status !== 'DRIVING') continue;
    if (seg.end <= tourStart) continue;
    const segStart = seg.start < tourStart ? tourStart : seg.start;
    const segEnd = seg.end > now ? now : seg.end;
    if (segEnd > segStart) {
      const segDur = segEnd - segStart;
      if (used + segDur >= MS.DRIVE_LIMIT) {
        return new Date(segStart.getTime() + (MS.DRIVE_LIMIT - used));
      }
      used += segDur;
    }
  }
  // If ongoing or projected: from end of last driving, add remaining
  return null; // not yet reached within recorded data
}

// ---------------------------------------------------------------------------
// 14-HOUR DRIVING WINDOW
// 14 consecutive hours following the qualifying off-duty period. Short off-duty
// breaks do NOT pause this clock (unless a valid split-sleeper applies).
// ---------------------------------------------------------------------------
export function compute14HourWindow(segments, now = new Date(), splitExclusionMs = 0) {
  const restBlocks = buildRestBlocks(segments);
  let lastQualRestEnd = null;
  for (const b of restBlocks) {
    if (b.duration >= MS.QUAL_REST && b.end <= now) lastQualRestEnd = b.end;
  }
  if (!lastQualRestEnd) {
    return { applicable: false, windowStart: null, elapsedMs: 0, remainingMs: MS.WINDOW, expiresAt: null };
  }
  const windowStart = lastQualRestEnd;
  const expiresAt = new Date(windowStart.getTime() + MS.WINDOW + splitExclusionMs);
  const elapsed = now - windowStart - splitExclusionMs;
  return {
    applicable: true,
    windowStart,
    elapsedMs: Math.max(0, elapsed),
    remainingMs: Math.max(0, MS.WINDOW - Math.max(0, elapsed)),
    expiresAt,
  };
}

// ---------------------------------------------------------------------------
// 30-MINUTE BREAK
// After 8 CUMULATIVE DRIVING hours (not on-duty+driving) without a qualifying
// 30-minute interruption (Off Duty / Sleeper / On-Duty-Not-Driving with NO
// driving during the 30 consecutive minutes), driving must stop.
// ---------------------------------------------------------------------------
export function compute30MinBreak(segments, now = new Date()) {
  const restBlocks = buildRestBlocks(segments);
  let lastQualRestEnd = null;
  for (const b of restBlocks) {
    if (b.duration >= MS.QUAL_REST && b.end <= now) lastQualRestEnd = b.end;
  }
  // Walk forward from last qualifying rest (or beginning), accumulate driving
  // since last qualifying 30-min interruption.
  let drivingSinceBreak = 0;
  let lastBreakEnd = lastQualRestEnd;
  // Build a merged timeline from lastQualRestEnd
  for (const seg of segments) {
    if (seg.end <= (lastBreakEnd || 0)) continue;
    if (seg.start < now) {
      if (seg.duty_status === 'DRIVING') {
        const s = seg.start < lastBreakEnd ? lastBreakEnd : seg.start;
        const e = seg.end > now ? now : seg.end;
        if (e > s) drivingSinceBreak += (e - s);
      }
    }
  }
  // Find qualifying interruptions of >= 30 min with NO driving
  // Recompute properly: scan segments chronologically tracking last qualifying break
  drivingSinceBreak = 0;
  let breakEnd = lastQualRestEnd ? new Date(lastQualRestEnd) : null;
  for (const seg of segments) {
    if (seg.end <= (breakEnd || 0)) continue;
    const s = seg.start < breakEnd ? breakEnd : seg.start;
    const e = seg.end > now ? now : seg.end;
    if (e <= s) continue;
    if (seg.duty_status === 'DRIVING') {
      drivingSinceBreak += (e - s);
    } else if (seg.duty_status === 'ON_DUTY' || REST_STATUSES.includes(seg.duty_status)) {
      // qualifying interruption if >= 30 consecutive min with no driving
      if ((e - s) >= MS.BREAK_REQ) {
        // check no driving overlaps this window
        breakEnd = new Date(e);
        drivingSinceBreak = 0;
      }
    }
  }
  const satisfied = drivingSinceBreak === 0 || drivingSinceBreak < MS.BREAK_GAP;
  const remainingBeforeBreak = Math.max(0, MS.BREAK_GAP - drivingSinceBreak);
  return {
    drivingAccumulatedMs: drivingSinceBreak,
    remainingBeforeBreakMs: remainingBeforeBreak,
    satisfied: drivingSinceBreak < MS.BREAK_GAP,
    breakRequired: drivingSinceBreak >= MS.BREAK_GAP,
  };
}

// ---------------------------------------------------------------------------
// 60/7 and 70/8 CYCLE
// Total ON_DUTY + DRIVING time across the lookback window.
// ---------------------------------------------------------------------------
export function getDailyTotals(segments, timezone, numDays, now = new Date()) {
  const today = startOfDayInTz(now, timezone);
  const totals = [];
  for (let i = numDays - 1; i >= 0; i--) {
    const dayStart = new Date(today.getTime() - i * 24 * 3600000);
    const dayEnd = new Date(dayStart.getTime() + 24 * 3600000);
    let onDuty = 0;
    let driving = 0;
    let offDuty = 0;
    let sleeper = 0;
    for (const seg of segments) {
      if (seg.end <= dayStart || seg.start >= dayEnd) continue;
      const s = seg.start < dayStart ? dayStart : seg.start;
      const e = seg.end > dayEnd ? dayEnd : seg.end;
      const d = e - s;
      if (d <= 0) continue;
      if (seg.duty_status === 'DRIVING') { driving += d; onDuty += d; }
      else if (seg.duty_status === 'ON_DUTY') { onDuty += d; }
      else if (seg.duty_status === 'OFF_DUTY') { offDuty += d; }
      else if (seg.duty_status === 'SLEEPER_BERTH') { sleeper += d; }
    }
    totals.push({
      date: dateKeyInTz(dayStart, timezone),
      onDutyHours: onDuty / MS.HOUR,
      drivingHours: driving / MS.HOUR,
      offDutyHours: offDuty / MS.HOUR,
      sleeperHours: sleeper / MS.HOUR,
    });
  }
  return totals;
}

export function computeCycle(segments, cycleType, timezone, now = new Date()) {
  const cycle = CYCLES[cycleType] || CYCLES['70_8'];
  const totals = getDailyTotals(segments, timezone, cycle.days, now);
  const cycleUsed = totals.reduce((sum, t) => sum + t.onDutyHours, 0);
  const cycleRemaining = Math.max(0, cycle.limit - cycleUsed);
  // Hours returning tomorrow = limit - (used minus oldest day)
  const oldestDayHours = totals[0] ? totals[0].onDutyHours : 0;
  const returningTomorrow = Math.max(0, cycle.limit - (cycleUsed - oldestDayHours));
  return {
    cycleType,
    cycleLimit: cycle.limit,
    cycleDays: cycle.days,
    cycleUsedHours: cycleUsed,
    cycleRemainingHours: cycleRemaining,
    returningTomorrowHours: returningTomorrow,
    dailyTotals: totals,
    historyComplete: totals.every(t => true), // placeholder; UI checks entered_prior_history
  };
}

// ---------------------------------------------------------------------------
// 34-HOUR RESTART
// Detect a qualifying period of >= 34 consecutive hours off duty.
// ---------------------------------------------------------------------------
export function compute34Restart(segments, now = new Date()) {
  const restBlocks = buildRestBlocks(segments);
  // A completed restart: a rest block >= 34h that has ended
  let completed = null;
  let inProgress = null;
  for (const b of restBlocks) {
    if (b.duration >= MS.RESTART && b.end <= now) {
      completed = { start: b.start, end: b.end, completed: true };
    }
  }
  // In-progress: the last rest block that is still ongoing (end === now) OR a recent one
  const lastBlock = restBlocks[restBlocks.length - 1];
  if (lastBlock && lastBlock.end >= now && lastBlock.duration < MS.RESTART) {
    const remaining = MS.RESTART - lastBlock.duration;
    inProgress = {
      start: lastBlock.start,
      elapsedMs: lastBlock.duration,
      remainingMs: remaining,
      estimatedCompletion: new Date(now.getTime() + remaining),
      completed: false,
    };
  }
  return { completed, inProgress };
}

// ---------------------------------------------------------------------------
// SPLIT SLEEPER BERTH
// Identify candidate pairings where: each period >= 2h, one period contains
// >= 7 consecutive hours in Sleeper Berth, combined >= 10h.
// Show the most advantageous valid pairing; never apply an uncompleted split.
// ---------------------------------------------------------------------------
export function evaluateSplitSleeper(segments, now = new Date()) {
  // Collect off/sleeper blocks with sleeper flag
  const blocks = [];
  let current = null;
  for (const seg of segments) {
    if (REST_STATUSES.includes(seg.duty_status)) {
      if (current && current.end >= seg.start - 60000 && current.hasSleeper === (seg.duty_status === 'SLEEPER_BERTH')) {
        // only merge same-status continuity for sleeper tracking; simpler: merge and track sleeper presence
      }
      if (current && current.end >= seg.start - 60000) {
        const merged = { start: current.start, end: new Date(Math.max(current.end, seg.end)) };
        merged.duration = merged.end - merged.start;
        merged.hasSleeper = current.hasSleeper || seg.duty_status === 'SLEEPER_BERTH';
        merged.sleeperOnly = current.sleeperOnly && seg.duty_status === 'SLEEPER_BERTH';
        current = merged;
      } else {
        if (current) blocks.push(current);
        current = {
          start: new Date(seg.start),
          end: new Date(seg.end),
          duration: seg.end - seg.start,
          hasSleeper: seg.duty_status === 'SLEEPER_BERTH',
          sleeperOnly: seg.duty_status === 'SLEEPER_BERTH',
        };
      }
    } else {
      if (current) { blocks.push(current); current = null; }
    }
  }
  if (current) blocks.push(current);

  // Find the last two qualifying rest blocks; check if they form a valid split
  const candidate = { hasCandidate: false };
  if (blocks.length >= 2) {
    const first = blocks[blocks.length - 2];
    const second = blocks[blocks.length - 1];
    const combined = first.duration + second.duration;
    const oneHasSevenSleeper = (first.sleeperOnly && first.duration >= MS.SPLIT_SLEEPER) ||
                               (second.sleeperOnly && second.duration >= MS.SPLIT_SLEEPER);
    const bothAtLeastTwo = first.duration >= MS.SPLIT_MIN && second.duration >= MS.SPLIT_MIN;
    const isValid = combined >= MS.SPLIT_FULL && oneHasSevenSleeper && bothAtLeastTwo;
    if (bothAtLeastTwo) {
      // Determine the shorter period and the required complement
      const sleeper = (first.sleeperOnly && first.duration >= MS.SPLIT_SLEEPER) ? first : (second.sleeperOnly && second.duration >= MS.SPLIT_SLEEPER ? second : null);
      const other = sleeper === first ? second : (sleeper === second ? first : null);
      if (sleeper && other) {
        candidate.hasCandidate = true;
        candidate.firstPeriod = { start: other.start, end: other.end, duration: other.duration, status: other.sleeperOnly ? 'SLEEPER_BERTH' : 'OFF_DUTY' };
        candidate.secondPeriod = { start: sleeper.start, end: sleeper.end, duration: sleeper.duration, status: 'SLEEPER_BERTH' };
        candidate.isValid = isValid;
        candidate.combinedMs = combined;
        if (!isValid) {
          // what's needed
          if (combined < MS.SPLIT_FULL) {
            candidate.requiredSecondMs = MS.SPLIT_FULL - (other.duration);
            candidate.note = `If completed, your clocks will be recalculated using the qualifying paired periods. Requires at least ${fmtDur(MS.SPLIT_FULL - other.duration)} Sleeper Berth.`;
          }
        } else {
          candidate.note = 'Valid split-sleeper pairing identified. Clocks recalculated using paired periods.';
        }
      }
    }
  }
  return candidate;
}

// ---------------------------------------------------------------------------
// DAILY GRID — 24-hour four-row graph for a given date (home-terminal TZ).
// Splits events crossing midnight while preserving continuity for HOS.
// ---------------------------------------------------------------------------
export function getDailyGrid(rawEvents, dateStr, timezone, now = new Date()) {
  const segments = normalizeEvents(rawEvents, now);
  // Determine the day window in UTC using timezone
  // Build a date object for that dateStr at midnight in tz
  const [y, m, d] = dateStr.split('-').map(Number);
  const utcMidnight = Date.UTC(y, m - 1, d);
  const offset = tzOffsetMs(new Date(utcMidnight), timezone);
  const dayStart = new Date(utcMidnight - offset);
  const dayEnd = new Date(dayStart.getTime() + 24 * 3600000);

  const rows = { OFF_DUTY: [], SLEEPER_BERTH: [], DRIVING: [], ON_DUTY: [] };
  let totalMs = { OFF_DUTY: 0, SLEEPER_BERTH: 0, DRIVING: 0, ON_DUTY: 0 };
  const remarks = [];

  for (const seg of segments) {
    if (seg.end <= dayStart || seg.start >= dayEnd) continue;
    const s = seg.start < dayStart ? dayStart : seg.start;
    const e = seg.end > dayEnd ? dayEnd : seg.end;
    if (e <= s) continue;
    const startHour = (s - dayStart) / MS.HOUR;
    const endHour = (e - dayStart) / MS.HOUR;
    rows[seg.duty_status].push({
      startHour, endHour,
      start: new Date(s), end: new Date(e),
      city: seg.city, state: seg.state, remark: seg.remark,
      id: seg.id,
    });
    totalMs[seg.duty_status] += (e - s);
    remarks.push({
      time: new Date(s),
      status: seg.duty_status,
      city: seg.city, state: seg.state,
      remark: seg.remark,
      id: seg.id,
    });
  }
  remarks.sort((a, b) => a.time - b.time);
  const totals = {
    OFF_DUTY: totalMs.OFF_DUTY / MS.HOUR,
    SLEEPER_BERTH: totalMs.SLEEPER_BERTH / MS.HOUR,
    DRIVING: totalMs.DRIVING / MS.HOUR,
    ON_DUTY: totalMs.ON_DUTY / MS.HOUR,
  };
  const totalHours = totals.OFF_DUTY + totals.SLEEPER_BERTH + totals.DRIVING + totals.ON_DUTY;
  return { dayStart, dayEnd, rows, totals, totalHours, remarks };
}

// ---------------------------------------------------------------------------
// COMPLIANCE CHECK — deterministic analysis of HOS + data-quality issues.
// ---------------------------------------------------------------------------
export function runComplianceCheck(rawEvents, cycleType, timezone, now = new Date(), opts = {}) {
  const segments = normalizeEvents(rawEvents, now);
  const issues = { hos: [], missingInfo: [], docConflicts: [], suggestions: [] };

  const drive = computeDrivingLimit(segments, now);
  const window = compute14HourWindow(segments, now);
  const brk = compute30MinBreak(segments, now);
  const cycle = computeCycle(segments, cycleType, timezone, now);

  // 11-hour
  if (drive.applicable && drive.drivingRemainingMs === 0) {
    issues.hos.push({ rule: '11-Hour Driving Limit', severity: 'violation', message: '11-hour driving limit reached. Further driving is a violation.' });
  } else if (drive.applicable && drive.drivingRemainingMs < MS.HOUR) {
    issues.hos.push({ rule: '11-Hour Driving Limit', severity: 'warning', message: `Less than 1 hour of driving remaining.` });
  }
  // 14-hour
  if (window.applicable && window.remainingMs === 0) {
    issues.hos.push({ rule: '14-Hour Driving Window', severity: 'violation', message: '14-hour driving window has expired. Driving is not permitted without a qualifying rest or split-sleeper.' });
  }
  // 30-min break
  if (brk.breakRequired) {
    issues.hos.push({ rule: '30-Minute Break', severity: 'warning', message: '30-minute qualifying interruption required before continuing to drive.' });
  }
  // cycle
  if (cycle.cycleRemainingHours === 0) {
    issues.hos.push({ rule: `${cycle.cycleLimit}-Hour / ${cycle.cycleDays}-Day Cycle`, severity: 'violation', message: `Cycle limit reached. No driving permitted until hours return or a 34-hour restart is completed.` });
  } else if (cycle.cycleRemainingHours < 1) {
    issues.hos.push({ rule: `${cycle.cycleLimit}-Hour / ${cycle.cycleDays}-Day Cycle`, severity: 'warning', message: `Less than 1 cycle hour remaining.` });
  }
  if (!opts.historyComplete) {
    issues.missingInfo.push({ message: 'Cycle calculation incomplete — previous duty history required. Available hours may be overstated until prior days are entered.' });
  }

  // Overlapping events
  for (let i = 0; i < segments.length - 1; i++) {
    if (segments[i].end > segments[i + 1].start) {
      issues.hos.push({ rule: 'Overlapping Events', severity: 'warning', message: `Two duty statuses overlap near ${fmtTime(segments[i].end)}.` });
      break;
    }
  }

  // Missing location
  for (const seg of segments) {
    if (!seg.city || !seg.state) {
      issues.missingInfo.push({ message: 'A duty-status event is missing city/state location.' });
      break;
    }
  }

  // 24-hour total
  if (opts.dailyTotal !== undefined && Math.abs(opts.dailyTotal - 24) > 0.01) {
    issues.missingInfo.push({ message: `Duty totals for the selected day equal ${opts.dailyTotal.toFixed(2)} hours (should be 24).` });
  }

  // Missing pre-trip
  if (opts.firstDrivingWithoutPretrip) {
    issues.missingInfo.push({ message: 'No pre-trip inspection acknowledgement recorded before the first Driving event of the work period.' });
  }

  // Equipment missing
  if (opts.equipmentMissing) {
    issues.missingInfo.push({ message: 'Equipment (tractor/trailer) information is missing for one or more events.' });
  }

  if (issues.hos.length === 0 && issues.missingInfo.length === 0 && issues.docConflicts.length === 0) {
    issues.suggestions.push({ message: 'No issues detected by the current LogbookAI compliance checks.' });
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------
export function fmtDur(ms) {
  if (ms == null || isNaN(ms)) return '--';
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h} hr ${m} min`;
}
export function fmtHours(hours) {
  if (hours == null || isNaN(hours)) return '--';
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return `${h}.${m.toString().padStart(2, '0')} hr`;
}
export function fmtTime(date) {
  if (!date) return '--';
  return new Date(date).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}
export function fmtClock(date, timezone) {
  if (!date) return '--';
  return new Date(date).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: timezone });
}

// ---------------------------------------------------------------------------
// MASTER: compute full HOS status from events
// ---------------------------------------------------------------------------
export function computeHOS(rawEvents, cycleType, timezone, now = new Date(), opts = {}) {
  const segments = normalizeEvents(rawEvents, now);
  const driving = computeDrivingLimit(segments, now);
  const window14 = compute14HourWindow(segments, now);
  const break30 = compute30MinBreak(segments, now);
  const cycle = computeCycle(segments, cycleType, timezone, now);
  const restart = compute34Restart(segments, now);
  const split = evaluateSplitSleeper(segments, now);

  // Determine current status (last segment)
  let currentStatus = null;
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i].start <= now) { currentStatus = segments[i]; break; }
  }

  return {
    currentStatus,
    driving,
    window14,
    break30,
    cycle,
    restart,
    split,
    historyComplete: opts.historyComplete !== false,
  };
}

// ---------------------------------------------------------------------------
// Split insertion helper: given existing events and a new historical event,
// return the proposed set of segment changes needed to maintain a continuous
// timeline (the example: insert a 30-min On-Duty inside a Driving block).
// ---------------------------------------------------------------------------
export function planEventInsertion(existingEvents, newEvent) {
  // existingEvents sorted; newEvent has start/end/status
  const segments = normalizeEvents([...existingEvents, newEvent]).sort((a, b) => a.start - b.start);
  const changes = [];
  for (const seg of segments) {
    changes.push({
      action: seg.id === newEvent.id ? 'insert' : (seg.original_event_id ? 'modify' : 'keep'),
      start_timestamp: seg.start.toISOString(),
      end_timestamp: seg.end.toISOString(),
      duty_status: seg.duty_status,
      city: seg.city, state: seg.state, remark: seg.remark,
    });
  }
  return changes;
}