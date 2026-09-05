import { describe, expect, it } from 'vitest';
import { computeHOS, hasSufficientCycleHistory, runComplianceCheck } from './hosEngine';
import { whatCanIDo } from './logAssistant';

const TZ = 'America/New_York';
const CYCLE = '70_8';
const NOW = new Date('2026-08-24T15:00:00.000Z');
const DAY_START = new Date('2026-08-24T04:00:00.000Z');
const WINDOW_START = new Date('2026-08-17T04:00:00.000Z');

const event = (start, end, duty_status, id) => ({
  id,
  log_date: start.slice(0, 10),
  start_timestamp: start,
  end_timestamp: end,
  duty_status,
  is_ongoing: !end,
  is_current_version: true,
  city: 'Albany',
  state: 'NY',
});

const cycleValue = (info) => info.cycleRemainingHours == null
  ? '--'
  : `${info.cycleRemainingHours.toFixed(1)} hr left`;

const report = (info) => ({
  unavailable: info.unavailable,
  canDrive: info.canDrive,
  cycleUnverified: info.cycleUnverified,
  cycleRemainingHours: info.cycleRemainingHours,
});

function evaluate(events, enteredPriorHistory) {
  const historyComplete = hasSufficientCycleHistory(events, CYCLE, enteredPriorHistory, TZ, NOW);
  const info = whatCanIDo(events, CYCLE, TZ, NOW, enteredPriorHistory);
  const hos = computeHOS(events, CYCLE, TZ, NOW, { historyComplete });
  const issues = runComplianceCheck(events, CYCLE, TZ, NOW, { historyComplete });
  return { info, hos, issues, report: report(info), renderedCycle: cycleValue(info) };
}

describe('Compliance canonical availability consumer', () => {
  it('shows unavailable values for no records and no prior history', () => {
    const result = evaluate([], false);
    expect(result.report).toEqual({ unavailable: true, canDrive: null, cycleUnverified: false, cycleRemainingHours: null });
    expect(result.renderedCycle).toBe('--');
    expect(result.issues.missingInfo.some((item) => item.message.includes('Cycle calculation incomplete'))).toBe(true);
  });

  it('shows unavailable values for an invalid unresolved timeline', () => {
    const events = [
      event(DAY_START.toISOString(), null, 'OFF_DUTY', 'invalid-off'),
      event(DAY_START.toISOString(), null, 'ON_DUTY', 'invalid-on'),
    ];
    const result = evaluate(events, true);
    expect(result.report).toEqual({ unavailable: true, canDrive: null, cycleUnverified: false, cycleRemainingHours: null });
    expect(result.hos.calculable).toBe(false);
    expect(result.renderedCycle).toBe('--');
  });

  it('keeps calculable shift clocks while cycle history is unverified', () => {
    const events = [event(DAY_START.toISOString(), null, 'OFF_DUTY', 'short-history')];
    const result = evaluate(events, false);
    expect(result.report).toEqual({ unavailable: false, canDrive: true, cycleUnverified: true, cycleRemainingHours: null });
    expect(result.info.driveRemainingMs).toBe(11 * 3600000);
    expect(result.info.windowRemainingMs).toBe(14 * 3600000);
    expect(result.renderedCycle).toBe('--');
    expect(result.info.cycleUnverifiedReason).toContain('8-day cycle');
  });

  it('shows real available values with sufficient valid history', () => {
    const events = [event(WINDOW_START.toISOString(), null, 'OFF_DUTY', 'full-history')];
    const result = evaluate(events, false);
    expect(result.report).toEqual({ unavailable: false, canDrive: true, cycleUnverified: false, cycleRemainingHours: 70 });
    expect(result.renderedCycle).toBe('70.0 hr left');
    expect(result.issues.missingInfo.some((item) => item.message.includes('Cycle calculation incomplete'))).toBe(false);
  });

  it('shows real zero and restart blocker for confirmed cycle exhaustion', () => {
    const events = [
      event(WINDOW_START.toISOString(), '2026-08-21T06:00:00.000Z', 'OFF_DUTY', 'exhausted-off-before'),
      event('2026-08-21T06:00:00.000Z', DAY_START.toISOString(), 'ON_DUTY', 'exhausted-on'),
      event(DAY_START.toISOString(), null, 'OFF_DUTY', 'exhausted-off-now'),
    ];
    const result = evaluate(events, false);
    expect(result.report).toEqual({ unavailable: false, canDrive: false, cycleUnverified: false, cycleRemainingHours: 0 });
    expect(result.renderedCycle).toBe('0.0 hr left');
    expect(result.info.driveBlockers.some((blocker) => blocker.rule === '70-hour cycle' && blocker.message.includes('34-hour restart'))).toBe(true);
    expect(result.issues.missingInfo.some((item) => item.message.includes('Cycle calculation incomplete'))).toBe(false);
  });

  it('never reports an HOS violation while the timeline is invalid — unavailable and violations go dark together', () => {
    // A stale/ancient DRIVING event with nothing after it (same-day conflict
    // forces the timeline invalid) used to still let runComplianceCheck
    // compute the 14-hour window off of it directly, reporting a huge
    // fabricated overage (e.g. 230+ hours) even while whatCanIDo/computeHOS
    // correctly said HOS was unavailable.
    const events = [
      event(DAY_START.toISOString(), null, 'OFF_DUTY', 'conflict-off'),
      event(DAY_START.toISOString(), null, 'DRIVING', 'conflict-driving'),
    ];
    const result = evaluate(events, true);
    expect(result.hos.calculable).toBe(false);
    expect(result.info.unavailable).toBe(true);
    // No 11h/14h/cycle/overlap violation may appear — only the single blocking
    // "timeline needs correction" notice, matching computeHOS's own gating.
    expect(result.issues.hos).toHaveLength(1);
    expect(result.issues.hos[0].severity).toBe('blocking');
    expect(result.issues.hos.some((h) => /11-hour|14-hour|cycle/i.test(h.rule))).toBe(false);
  });

  it('does not require a full 24-hour total for the current (still in progress) day', () => {
    const events = [event(DAY_START.toISOString(), null, 'DRIVING', 'today-driving')];
    // NOW is 11h after DAY_START, so today's logged total is ~11h, not 24h.
    const partialDayIssues = runComplianceCheck(events, CYCLE, TZ, NOW, {
      historyComplete: true, dailyTotal: 11, isCurrentDay: true,
    });
    expect(partialDayIssues.missingInfo.some((item) => item.message.includes('should be 24'))).toBe(false);

    // The same partial total on a COMPLETED day is still a real data-quality issue.
    const completedDayIssues = runComplianceCheck(events, CYCLE, TZ, NOW, {
      historyComplete: true, dailyTotal: 11, isCurrentDay: false,
    });
    expect(completedDayIssues.missingInfo.some((item) => item.message.includes('should be 24'))).toBe(true);
  });

  it('still reports the driver\'s current open status even when an earlier, unrelated gap makes the day HOS-unavailable', () => {
    // Logged this morning, then nothing for hours (a real, unaddressed gap),
    // then an open DRIVING status starting later. The gap correctly makes
    // numeric HOS clocks unavailable — but "what is my status right now" must
    // NOT be swallowed by that: Today should still show DRIVING as active,
    // not "No active status", while the HOS clock cards stay "--".
    const morning = event(DAY_START.toISOString(), '2026-08-24T07:00:00.000Z', 'OFF_DUTY', 'morning-off');
    // gap: nothing logged 07:00 -> 14:00
    const openDrive = event('2026-08-24T14:00:00.000Z', null, 'DRIVING', 'evening-driving');
    const events = [morning, openDrive];
    const hos = computeHOS(events, CYCLE, TZ, NOW, { historyComplete: true });
    expect(hos.calculable).toBe(false); // the gap correctly blocks numeric HOS
    expect(hos.currentStatus).toBeTruthy(); // but current status is NOT lost
    expect(hos.currentStatus.id).toBe('evening-driving');
    expect(hos.currentStatus.duty_status).toBe('DRIVING');
    // Numeric clocks remain unavailable, matching the gating contract.
    expect(hos.driving.applicable).toBe(false);
    expect(hos.window14.applicable).toBe(false);
  });
});