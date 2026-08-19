// ============================================================================
// LogbookAI Deterministic HOS Engine
// US Interstate Property-Carrying Standard Federal Rules (FMCSA 49 CFR 395)
// ----------------------------------------------------------------------------
// This module is PURE DETERMINISTIC APPLICATION LOGIC. It contains NO AI/LLM
// calls. All Hours of Service calculations derive from stored DutyStatusEvents.
// AI may explain results produced here but may never be the source of the math.
//
// SPLIT SLEEPER BERTH (49 CFR 395.1(g)):
// A valid split-sleeper pairing recalculates BOTH the 11-hour driving limit and
// the 14-hour driving window. For a valid selected pairing, each clock's
// calculation period begins at the END OF THE FIRST qualifying rest period of
// the pair (the applicable reference point). The paired qualifying rest
// periods themselves do not count against the 14-hour window; driving between
// and after the paired periods counts toward the 11-hour limit. Completion of
// the second qualifying period is NEVER a fresh reset for either clock. When a
// subsequent qualifying rest period forms a new valid pair, the calculation
// point advances per FMCSA's rolling split-sleeper methodology. The 60/7-70/8
// cycle (actual On-Duty + Driving) and the 30-minute break (actual cumulative
// driving since the last qualifying interruption) are NOT reduced by split
// treatment; only 10 consecutive qualifying off-duty hours gives a full reset.
//
// Pairing selection follows FMCSA order: fewest/least-severe violations first
// (nominal <15 min -> violation -> OOS/egregious), then most available on-duty
// and driving time moving forward as the tiebreak.
// ============================================================================

const MS = {
  MINUTE: 60 * 1000,
  HOUR: 3600000,
  DRIVE_LIMIT: 11 * 3600000,       // 11-hour driving limit
  WINDOW: 14 * 3600000,            // 14-hour driving window
  BREAK_GAP: 8 * 3600000,          // 8 cumulative driving hours before break
  BREAK_REQ: 30 * 60000,           // 30-minute qualifying interruption
  QUAL_REST: 10 * 3600000,         // 10 consecutive hours off duty (full reset)
  RESTART: 34 * 3600000,           // 34-hour restart
  SPLIT_MIN: 2 * 3600000,          // minimum qualifying split period
  SPLIT_FULL: 10 * 3600000,        // combined split minimum
  SPLIT_SLEEPER: 7 * 3600000,       // one period must contain >=7h consecutive sleeper
  NOMINAL: 15 * 60000,            // overrun < 15 min = nominal
  VIOLATION: 60 * 60000,          // overrun 15-60 min = violation; > 60 min = egregious
};

const CYCLES = {
  '60_7': { limit: 60, days: 7 },
  '70_8': { limit: 70, days: 8 },
};

const REST_STATUSES = ['OFF_DUTY', 'SLEEPER_BERTH'];

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

// ---------------------------------------------------------------------------
// Normalize raw events into a sorted segment list.
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

// ---------------------------------------------------------------------------
// Build continuous rest blocks (consecutive OFF_DUTY / SLEEPER_BERTH, even
// across midnight). Tracks the longest run of consecutive SLEEPER_BERTH within
// each block (needed for the >=7h-sleeper split requirement). Ongoing rest is
// capped at `now`.
// ---------------------------------------------------------------------------
export function buildRestBlocksWithSleeper(segments, now = new Date()) {
  const blocks = [];
  let cur = null;
  let curSleeperRun = 0;
  for (const seg of segments) {
    const isRest = REST_STATUSES.includes(seg.duty_status);
    if (isRest) {
      const rawEnd = seg.end > now ? now : seg.end;
      const segStart = seg.start < now ? seg.start : now;
      const segDur = Math.max(0, rawEnd - segStart);
      if (segDur <= 0) continue;
      const contiguous = cur && cur.end.getTime() >= segStart.getTime() - 60000;
      if (contiguous) {
        cur.end = new Date(Math.max(cur.end.getTime(), rawEnd.getTime()));
        cur.duration = cur.end - cur.start;
        cur.isOngoing = cur.isOngoing || seg.end > now;
        if (seg.duty_status === 'SLEEPER_BERTH') {
          curSleeperRun += segDur;
        } else {
          curSleeperRun = 0;
        }
        cur.sleeperRunMs = Math.max(cur.sleeperRunMs, curSleeperRun);
        cur.hasSleeper = cur.hasSleeper || seg.duty_status === 'SLEEPER_BERTH';
        cur.isSleeperOnly = cur.isSleeperOnly && seg.duty_status === 'SLEEPER_BERTH';
      } else {
        if (cur) blocks.push(cur);
        cur = {
          start: new Date(segStart),
          end: new Date(rawEnd),
          duration: segDur,
          sleeperRunMs: seg.duty_status === 'SLEEPER_BERTH' ? segDur : 0,
          hasSleeper: seg.duty_status === 'SLEEPER_BERTH',
          isSleeperOnly: seg.duty_status === 'SLEEPER_BERTH',
          isOngoing: seg.end > now,
        };
        curSleeperRun = cur.sleeperRunMs;
      }
    } else {
      if (cur) { blocks.push(cur); cur = null; curSleeperRun = 0; }
    }
  }
  if (cur) blocks.push(cur);
  return blocks;
}

// Simple rest blocks (no sleeper tracking) — used by break/restart calcs.
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

function periodInfo(b) {
  if (!b) return null;
  return {
    start: b.start,
    end: b.end,
    duration: b.duration,
    status: b.hasSleeper ? 'SLEEPER_BERTH' : 'OFF_DUTY',
    sleeperRunMs: b.sleeperRunMs,
    isOngoing: !!b.isOngoing,
  };
}

// ---------------------------------------------------------------------------
// SPLIT SLEEPER — enumerate all valid pairings.
// A pairing is two rest blocks (first earlier, second later), each >= 2h and
// < 10h, where at least one contains >= 7 consecutive hours of Sleeper Berth,
// and the two combined >= 10h. Both must occur after the last full 10h reset.
// ---------------------------------------------------------------------------
export function enumerateValidPairings(blocks, now, tFullMs) {
  const eligible = blocks.filter(
    b => b.duration >= MS.SPLIT_MIN &&
         b.duration < MS.QUAL_REST &&
         b.end.getTime() > tFullMs &&
         b.end.getTime() <= now.getTime() + 1
  );
  const pairings = [];
  for (let i = 0; i < eligible.length; i++) {
    for (let j = i + 1; j < eligible.length; j++) {
      const a = eligible[i];
      const b = eligible[j];
      const combined = a.duration + b.duration;
      if (combined < MS.SPLIT_FULL) continue;
      const seven = a.sleeperRunMs >= MS.SPLIT_SLEEPER || b.sleeperRunMs >= MS.SPLIT_SLEEPER;
      if (!seven) continue;
      pairings.push({
        first: a,
        second: b,
        combinedMs: combined,
        referenceTime: a.end,   // end of FIRST qualifying period
        effectiveTime: b.end,   // end of second period
      });
    }
  }
  return pairings;
}

// ---------------------------------------------------------------------------
// Compute the split-recalculated clocks for a single candidate pairing.
// Reference point = end of the FIRST qualifying period.
//   14h countable = (now - referenceTime) - secondPeriodDuration
//   11h driving   = driving accumulated between and after the paired periods
// ----------------------------------------------------------------------------
export function computeClocksForPairing(segments, pairing, now) {
  const ref = pairing.first.end;
  const secondDur = pairing.second.duration;
  const wallElapsed = Math.max(0, now - ref);
  const windowCountable = Math.max(0, wallElapsed - secondDur);
  const windowRemaining = MS.WINDOW - windowCountable;
  let drivingUsed = 0;
  for (const seg of segments) {
    if (seg.duty_status !== 'DRIVING') continue;
    if (seg.end <= ref) continue;
    const s = seg.start < ref ? ref : seg.start;
    const e = seg.end > now ? now : seg.end;
    if (e > s) drivingUsed += (e - s);
  }
  const drivingRemaining = MS.DRIVE_LIMIT - drivingUsed;
  const violations = [];
  if (drivingRemaining < 0) {
    const over = -drivingRemaining;
    violations.push({ rule: '11-Hour Driving Limit', severity: severityFor(over), overMs: over });
  }
  if (windowRemaining < 0) {
    const over = -windowRemaining;
    violations.push({ rule: '14-Hour Driving Window', severity: severityFor(over), overMs: over });
  }
  return {
    referenceTime: ref,
    secondDuration: secondDur,
    drivingUsedMs: drivingUsed,
    drivingRemainingMs: drivingRemaining,
    windowCountableMs: windowCountable,
    windowRemainingMs: windowRemaining,
    violations,
  };
}

function severityFor(overMs) {
  if (overMs < MS.NOMINAL) return 'nominal';
  if (overMs < MS.VIOLATION) return 'violation';
  return 'egregious';
}

// ---------------------------------------------------------------------------
// FMCSA pairing selection: fewest/least-severe violations first (egregious >
// violation > nominal), then most available on-duty+driving time forward,
// then latest effective time (rolling) as the final tiebreak.
// ---------------------------------------------------------------------------
export function selectAuthoritativeSplit(pairings, segments, now) {
  if (!pairings || pairings.length === 0) return null;
  const scored = pairings.map(p => {
    const clocks = computeClocksForPairing(segments, p, now);
    let e = 0, v = 0, n = 0;
    clocks.violations.forEach(vi => {
      if (vi.severity === 'egregious') e++;
      else if (vi.severity === 'violation') v++;
      else n++;
    });
    const availableForward = Math.min(
      Math.max(0, clocks.drivingRemainingMs),
      Math.max(0, clocks.windowRemainingMs)
    );
    return { pairing: p, clocks, e, v, n, availableForward };
  });
  scored.sort((a, b) => {
    if (a.e !== b.e) return a.e - b.e;
    if (a.v !== b.v) return a.v - b.v;
    if (a.n !== b.n) return a.n - b.n;
    if (b.availableForward !== a.availableForward) return b.availableForward - a.availableForward;
    return b.pairing.effectiveTime - a.pairing.effectiveTime;
  });
  return scored[0];
}

// ---------------------------------------------------------------------------
// Detect an incomplete split: a qualifying first period (>=7h consecutive
// sleeper) exists but no later block completes the 10h combined requirement.
// Reported (never applied) so the driver knows what is still required.
// ---------------------------------------------------------------------------
export function detectIncompleteSplit(blocks, tFullMs) {
  const eligible = blocks.filter(
    b => b.duration >= MS.SPLIT_MIN && b.duration < MS.QUAL_REST && b.end.getTime() > tFullMs
  );
  for (let i = eligible.length - 1; i >= 0; i--) {
    const c = eligible[i];
    if (c.sleeperRunMs < MS.SPLIT_SLEEPER) continue;
    let partialSecond = null;
    let completed = false;
    for (let j = i + 1; j < eligible.length; j++) {
      const s = eligible[j];
      if (s.duration >= MS.SPLIT_MIN && c.duration + s.duration >= MS.SPLIT_FULL) {
        completed = true;
        break;
      }
      partialSecond = s;
    }
    if (!completed) {
      const required = MS.SPLIT_FULL - c.duration;
      const already = partialSecond ? partialSecond.duration : 0;
      const moreNeeded = Math.max(0, required - already);
      return {
        firstPeriod: periodInfo(c),
        secondPeriod: partialSecond ? periodInfo(partialSecond) : null,
        completedPeriodMs: c.duration,
        requiredSecondMs: required,
        additionalMs: moreNeeded,
        note: partialSecond
          ? `Split Sleeper Incomplete — ${fmtDur(c.duration)} qualifying period taken with ${fmtDur(already)} toward the second. Requires ${fmtDur(moreNeeded)} more to complete the split.`
          : `Split Sleeper Incomplete — qualifying period of ${fmtDur(c.duration)} taken. Requires a second qualifying period of at least ${fmtDur(required)} to complete the split.`,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Evaluate the split-sleeper state for the current timeline.
// Returns { status: 'active'|'incomplete'|'none', ... }.
//   active: a valid pairing governs; clocks recalculated from the first period.
//   incomplete: a qualifying first period exists but the split is unfinished.
//   none: no valid pairing (and no incomplete candidate).
// ---------------------------------------------------------------------------
export function evaluateSplitSleeper(segments, now = new Date(), blocksArg) {
  const blocks = blocksArg || buildRestBlocksWithSleeper(segments, now);
  let fullReset = null;
  for (const b of blocks) {
    if (b.duration >= MS.QUAL_REST && b.end <= now) fullReset = b;
  }
  const tFull = fullReset ? fullReset.end.getTime() : -Infinity;
  const pairings = enumerateValidPairings(blocks, now, tFull);
  if (pairings.length > 0) {
    const selected = selectAuthoritativeSplit(pairings, segments, now);
    if (selected) {
      const p = selected.pairing;
      return {
        status: 'active',
        hasCandidate: true,
        isValid: true,
        pairing: p,
        firstPeriod: periodInfo(p.first),
        secondPeriod: periodInfo(p.second),
        referenceTime: p.first.end,
        effectiveTime: p.second.end,
        secondDuration: p.second.duration,
        combinedMs: p.combinedMs,
        clocks: selected.clocks,
        note: 'Split Sleeper Active — the 11-hour driving limit and 14-hour window were recalculated using the qualifying paired periods (reference: end of the first qualifying period).',
      };
    }
  }
  const incomplete = detectIncompleteSplit(blocks, tFull);
  if (incomplete) {
    return {
      status: 'incomplete',
      hasCandidate: true,
      isValid: false,
      pairing: null,
      referenceTime: null,
      effectiveTime: null,
      secondDuration: null,
      clocks: null,
      ...incomplete,
    };
  }
  return {
    status: 'none',
    hasCandidate: false,
    isValid: false,
    pairing: null,
    referenceTime: null,
    effectiveTime: null,
    secondDuration: null,
    clocks: null,
    note: 'No valid split-sleeper pairing.',
  };
}

// ---------------------------------------------------------------------------
// GOVERNING RESET — the reset that anchors the current 11h and 14h clocks.
// A valid split (after the last full reset) governs over the full reset;
// otherwise the most recent 10h off-duty rest governs; otherwise none.
// ----------------------------------------------------------------------------
export function computeGoverningReset(segments, now = new Date()) {
  const blocks = buildRestBlocksWithSleeper(segments, now);
  const split = evaluateSplitSleeper(segments, now, blocks);
  if (split.status === 'active' && split.referenceTime) {
    return {
      type: 'split',
      referenceTime: split.referenceTime,
      effectiveTime: split.effectiveTime,
      secondDuration: split.secondDuration,
      split,
      block: null,
    };
  }
  let fullReset = null;
  for (const b of blocks) {
    if (b.duration >= MS.QUAL_REST && b.end <= now) fullReset = b;
  }
  if (fullReset) {
    return {
      type: 'full',
      referenceTime: fullReset.end,
      effectiveTime: fullReset.end,
      secondDuration: 0,
      split,
      block: fullReset,
    };
  }
  return { type: 'none', referenceTime: null, effectiveTime: null, secondDuration: 0, split, block: null };
}

// ---------------------------------------------------------------------------
// 11-HOUR DRIVING LIMIT (split-aware)
// Driving accumulated from the governing reference point to now. Under a split,
// this includes driving between and after the paired periods.
// ---------------------------------------------------------------------------
export function computeDrivingLimit(segments, now = new Date(), governing) {
  if (!governing) governing = computeGoverningReset(segments, now);
  if (!governing || governing.type === 'none' || !governing.referenceTime) {
    return { applicable: false, referenceType: 'none', drivingUsedMs: 0, drivingRemainingMs: MS.DRIVE_LIMIT, expiresAt: null, tourStart: null };
  }
  const ref = governing.referenceTime;
  let drivingUsed = 0;
  for (const seg of segments) {
    if (seg.duty_status !== 'DRIVING') continue;
    if (seg.end <= ref) continue;
    const s = seg.start < ref ? ref : seg.start;
    const e = seg.end > now ? now : seg.end;
    if (e > s) drivingUsed += (e - s);
  }
  const remaining = Math.max(0, MS.DRIVE_LIMIT - drivingUsed);
  return {
    applicable: true,
    referenceType: governing.type,
    tourStart: ref,
    drivingUsedMs: drivingUsed,
    drivingRemainingMs: remaining,
    expiresAt: null,
  };
}

// ---------------------------------------------------------------------------
// 14-HOUR DRIVING WINDOW (split-aware)
// Under a full reset: wall-clock elapsed from the reference (no exclusions).
// Under a split: wall-clock elapsed from the end of the first qualifying
// period, minus the second qualifying period's rest (the paired rest does not
// count). The first period is before the reference point and so is excluded.
// ---------------------------------------------------------------------------
export function compute14HourWindow(segments, now = new Date(), governing) {
  if (!governing) governing = computeGoverningReset(segments, now);
  if (!governing || governing.type === 'none' || !governing.referenceTime) {
    return { applicable: false, referenceType: 'none', windowStart: null, elapsedMs: 0, excludedMs: 0, remainingMs: MS.WINDOW, expiresAt: null };
  }
  const ref = governing.referenceTime;
  const wallElapsed = Math.max(0, now - ref);
  let countable = wallElapsed;
  let excluded = 0;
  if (governing.type === 'split') {
    excluded = governing.secondDuration || 0;
    countable = Math.max(0, wallElapsed - excluded);
  }
  const remaining = Math.max(0, MS.WINDOW - countable);
  const expiresAt = new Date(ref.getTime() + MS.WINDOW + excluded);
  return {
    applicable: true,
    referenceType: governing.type,
    windowStart: ref,
    elapsedMs: countable,
    excludedMs: excluded,
    remainingMs: remaining,
    expiresAt,
  };
}

// ---------------------------------------------------------------------------
// 30-MINUTE BREAK
// After 8 CUMULATIVE DRIVING hours without a qualifying 30-minute interruption
// (Off Duty / Sleeper / On-Duty-Not-Driving with no driving during the 30
// consecutive minutes), driving must stop. Based on actuals — NOT reduced by
// split-sleeper treatment.
// ---------------------------------------------------------------------------
export function compute30MinBreak(segments, now = new Date()) {
  const restBlocks = buildRestBlocks(segments);
  let lastQualRestEnd = null;
  for (const b of restBlocks) {
    if (b.duration >= MS.QUAL_REST && b.end <= now) lastQualRestEnd = b.end;
  }
  let drivingSinceBreak = 0;
  let breakEnd = lastQualRestEnd ? new Date(lastQualRestEnd) : null;
  for (const seg of segments) {
    if (seg.end <= (breakEnd || 0)) continue;
    const s = seg.start < breakEnd ? breakEnd : seg.start;
    const e = seg.end > now ? now : seg.end;
    if (e <= s) continue;
    if (seg.duty_status === 'DRIVING') {
      drivingSinceBreak += (e - s);
    } else if (seg.duty_status === 'ON_DUTY' || REST_STATUSES.includes(seg.duty_status)) {
      if ((e - s) >= MS.BREAK_REQ) {
        breakEnd = new Date(e);
        drivingSinceBreak = 0;
      }
    }
  }
  return {
    drivingAccumulatedMs: drivingSinceBreak,
    remainingBeforeBreakMs: Math.max(0, MS.BREAK_GAP - drivingSinceBreak),
    satisfied: drivingSinceBreak < MS.BREAK_GAP,
    breakRequired: drivingSinceBreak >= MS.BREAK_GAP,
  };
}

// ---------------------------------------------------------------------------
// 60/7 and 70/8 CYCLE — total ON_DUTY + DRIVING across the lookback window.
// Based on actuals; NOT reduced by split-sleeper treatment.
// ---------------------------------------------------------------------------
export function getDailyTotals(segments, timezone, numDays, now = new Date()) {
  const today = startOfDayInTz(now, timezone);
  const totals = [];
  for (let i = numDays - 1; i >= 0; i--) {
    const dayStart = new Date(today.getTime() - i * 24 * 3600000);
    const dayEnd = new Date(dayStart.getTime() + 24 * 3600000);
    let onDuty = 0, driving = 0, offDuty = 0, sleeper = 0;
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
    historyComplete: true,
  };
}

// ---------------------------------------------------------------------------
// SUFFICIENT CYCLE HISTORY — has the driver accumulated enough LogbookAI
// records to cover the full 7/8-day cycle lookback window? When prior duty
// history was NOT entered during onboarding, cycle availability is only
// trustworthy once the in-app record spans the entire cycle window. Until
// then the engine must NOT treat unknown prior days as verified zero — the UI
// surfaces an "unverified" notice instead.
// ---------------------------------------------------------------------------
export function hasSufficientCycleHistory(rawEvents, cycleType, enteredPriorHistory, timezone, now = new Date()) {
  if (enteredPriorHistory) return true;
  const cycle = CYCLES[cycleType] || CYCLES['70_8'];
  const segments = normalizeEvents(rawEvents, now);
  if (!segments.length) return false;
  const windowStart = startOfDayInTz(now, timezone).getTime() - (cycle.days - 1) * 24 * 3600000;
  const earliest = segments.reduce((min, s) => (s.start.getTime() < min ? s.start.getTime() : min), segments[0].start.getTime());
  return earliest <= windowStart;
}

// ---------------------------------------------------------------------------
// 34-HOUR RESTART
// ---------------------------------------------------------------------------
export function compute34Restart(segments, now = new Date()) {
  const restBlocks = buildRestBlocks(segments);
  let completed = null;
  for (const b of restBlocks) {
    if (b.duration >= MS.RESTART && b.end <= now) {
      completed = { start: b.start, end: b.end, completed: true };
    }
  }
  let inProgress = null;
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
// DAILY GRID — 24-hour four-row graph for a given date (home-terminal TZ).
// ---------------------------------------------------------------------------
export function getDailyGrid(rawEvents, dateStr, timezone, now = new Date()) {
  const segments = normalizeEvents(rawEvents, now);
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
// Uses split-aware 11h and 14h clocks.
// ---------------------------------------------------------------------------
export function runComplianceCheck(rawEvents, cycleType, timezone, now = new Date(), opts = {}) {
  const segments = normalizeEvents(rawEvents, now);
  const issues = { hos: [], missingInfo: [], docConflicts: [], suggestions: [] };

  const governing = computeGoverningReset(segments, now);
  const drive = computeDrivingLimit(segments, now, governing);
  const window = compute14HourWindow(segments, now, governing);
  const brk = compute30MinBreak(segments, now);
  const cycle = computeCycle(segments, cycleType, timezone, now);

  // 11-hour
  if (drive.applicable && drive.drivingUsedMs >= MS.DRIVE_LIMIT) {
    const over = drive.drivingUsedMs - MS.DRIVE_LIMIT;
    const sev = severityFor(over);
    issues.hos.push({ rule: '11-Hour Driving Limit', severity: sev, message: `11-hour driving limit exceeded by ${fmtDur(over)}. Further driving is a violation.` });
  } else if (drive.applicable && drive.drivingRemainingMs < MS.HOUR) {
    issues.hos.push({ rule: '11-Hour Driving Limit', severity: 'warning', message: `Less than 1 hour of driving remaining.` });
  }
  // 14-hour
  if (window.applicable && window.elapsedMs >= MS.WINDOW) {
    const over = window.elapsedMs - MS.WINDOW;
    const sev = severityFor(over);
    issues.hos.push({ rule: '14-Hour Driving Window', severity: sev, message: `14-hour driving window exceeded by ${fmtDur(over)}. Driving is not permitted without a qualifying rest or split-sleeper.` });
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
  if (opts.firstDrivingWithoutPretrip) {
    issues.missingInfo.push({ message: 'No pre-trip inspection acknowledgement recorded before the first Driving event of the work period.' });
  }
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
export function fmtHoursShort(ms) {
  if (ms == null) return '--';
  const h = ms / MS.HOUR;
  return Number.isInteger(h) ? `${h}h` : `${h.toFixed(1)}h`;
}

// ---------------------------------------------------------------------------
// MASTER: compute full HOS status from events (split-aware).
// ---------------------------------------------------------------------------
export function computeHOS(rawEvents, cycleType, timezone, now = new Date(), opts = {}) {
  const segments = normalizeEvents(rawEvents, now);
  const governing = computeGoverningReset(segments, now);
  const driving = computeDrivingLimit(segments, now, governing);
  const window14 = compute14HourWindow(segments, now, governing);
  const break30 = compute30MinBreak(segments, now);
  const cycle = computeCycle(segments, cycleType, timezone, now);
  const restart = compute34Restart(segments, now);
  const split = governing.split;

  let currentStatus = null;
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i].start <= now) { currentStatus = segments[i]; break; }
  }

  return {
    currentStatus,
    governing,
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
// timeline.
// ---------------------------------------------------------------------------
export function planEventInsertion(existingEvents, newEvent) {
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