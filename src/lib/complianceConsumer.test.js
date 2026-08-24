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
});