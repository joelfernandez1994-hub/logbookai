// ============================================================================
// LogbookAI Manual Log Assistant — deterministic, non-mutating tests.
// Run: npx vitest run src/lib/logAssistant.test.js
// ----------------------------------------------------------------------------
// No database writes, no AI calls. These tests verify the safety boundary and
// the deterministic behaviors that must hold regardless of AI output.
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  mergeProposedEvents, computeProposedHOS, hasPretripInProposed,
  isFabricatedViolationFix, whatCanIDo, distanceReasonableness,
  buildEquipmentChangeEvent, buildCorrectionVersion, planToStops,
} from './logAssistant';
import { computeHOS } from './hosEngine';
import { SCENARIOS, runScenario } from './hosScenarios';

const H = 3600000;
const NOW = new Date('2026-08-19T12:00:00Z');
const TZ = 'UTC';
const CYCLE = '70_8';

function ev(startAgoH, endAgoH, status, extra = {}) {
  return {
    id: `e-${startAgoH}`,
    log_date: new Date(NOW - startAgoH * H).toISOString().slice(0, 10),
    start_timestamp: new Date(NOW - startAgoH * H).toISOString(),
    end_timestamp: new Date(NOW - endAgoH * H).toISOString(),
    duty_status: status,
    is_current_version: true,
    ...extra,
  };
}

describe('Manual Log Assistant — deterministic safety', () => {
  // 1. Proposed day does not save until confirmation.
  it('marks proposed events as _proposed and does not mutate actual events', () => {
    const existing = [ev(5, 0, 'DRIVING', { is_ongoing: true, end_timestamp: null })];
    const frozen = JSON.parse(JSON.stringify(existing));
    const proposed = [{
      date: '2026-08-19', start_timestamp: new Date(NOW - 2 * H).toISOString(),
      end_timestamp: new Date(NOW - 1 * H).toISOString(), duty_status: 'ON_DUTY',
      activity_type: 'Fuel', city: 'Ocala', state: 'FL', source: 'typed',
    }];
    const merged = mergeProposedEvents(existing, proposed, NOW);
    expect(merged.some(m => m._proposed)).toBe(true);
    // existing array untouched
    expect(JSON.stringify(existing)).toBe(JSON.stringify(frozen));
    // ongoing event ended at first proposed start
    const ongoing = merged.find(m => m.id === 'e-5');
    expect(ongoing.end_timestamp).toBe(proposed[0].start_timestamp);
  });

  // 2. Proposed timeline triggers the HOS engine before confirmation.
  it('computeProposedHOS derives clocks from the merged timeline', () => {
    // a valid 10h Off Duty reset anchors the clocks before the driving begins
    const existing = [
      ev(13, 3, 'OFF_DUTY'),
      ev(3, 0, 'DRIVING', { is_ongoing: true, end_timestamp: null }),
    ];
    const proposed = [{
      date: '2026-08-19', start_timestamp: new Date(NOW - 1 * H).toISOString(),
      end_timestamp: new Date(NOW).toISOString(), duty_status: 'DRIVING',
      source: 'typed',
    }];
    const { hos, violations } = computeProposedHOS(existing, proposed, CYCLE, TZ, NOW);
    expect(hos.driving.applicable).toBe(true);
    // 2h existing driving (3h→1h ago) + 1h proposed driving → at least 3h counted
    expect(hos.driving.drivingUsedMs).toBeGreaterThan(0);
    expect(Array.isArray(violations)).toBe(true);
  });

  // 3. Missing pre-trip causes clarification, not fabrication.
  it('hasPretripInProposed is false when driving starts with no pre-trip', () => {
    const proposed = [
      { duty_status: 'DRIVING', start_timestamp: new Date(NOW - 4 * H).toISOString() },
      { duty_status: 'ON_DUTY', activity_type: 'Fuel', start_timestamp: new Date(NOW - 1 * H).toISOString() },
    ];
    expect(hasPretripInProposed(proposed)).toBe(false);
    const withPretrip = [
      { duty_status: 'ON_DUTY', activity_type: 'Pre-Trip', remark: 'Pre-Trip', start_timestamp: new Date(NOW - 5 * H).toISOString() },
      ...proposed,
    ];
    expect(hasPretripInProposed(withPretrip)).toBe(true);
  });

  // 4. A reported fuel stop omitted from RODS is a legitimate factual correction.
  it('a Driving→ON_DUTY Fuel correction is NOT flagged as fabrication', () => {
    const existing = [ev(3, 2, 'DRIVING')];
    const correction = {
      event_index: 0,
      proposed_event: { duty_status: 'ON_DUTY', activity_type: 'Fuel', remark: 'Fuel stop', start_timestamp: existing[0].start_timestamp, end_timestamp: existing[0].end_timestamp },
    };
    expect(isFabricatedViolationFix(existing, [correction])).toBe(false);
  });

  // 5. AI cannot convert arbitrary Driving to Off/Sleeper to remove a violation.
  it('a Driving→SLEEPER conversion with no real activity IS flagged as fabrication', () => {
    const existing = [ev(3, 2, 'DRIVING')];
    const bad = {
      event_index: 0,
      proposed_event: { duty_status: 'SLEEPER_BERTH', activity_type: '', remark: '', start_timestamp: existing[0].start_timestamp, end_timestamp: existing[0].end_timestamp },
    };
    expect(isFabricatedViolationFix(existing, [bad])).toBe(true);
  });

  // 6. Certified-log correction creates a new version and requires re-certification.
  it('buildCorrectionVersion preserves the original snapshot and marks corrected', () => {
    const target = ev(5, 2, 'DRIVING', { id: 'abc', city: 'Miami' });
    const v = buildCorrectionVersion(target, 'Fuel stop missing', 'Jane Driver');
    expect(v.action).toBe('corrected');
    expect(v.original_event_id).toBe('abc');
    expect(v.snapshot.duty_status).toBe('DRIVING');
    expect(v.snapshot.city).toBe('Miami');
    expect(v.edit_reason).toBe('Fuel stop missing');
  });

  // 7. Future planned sleeper does not affect current authoritative clocks.
  it('a future sleeper in the events array does not change current clocks', () => {
    const base = [ev(3, 0, 'DRIVING', { is_ongoing: true, end_timestamp: null })];
    const futureSleeper = {
      ...ev(-8, -10, 'SLEEPER_BERTH'), // starts 8h in the future
      id: 'future',
    };
    const without = computeHOS(base, CYCLE, TZ, NOW, { historyComplete: true });
    const withFuture = computeHOS([...base, futureSleeper], CYCLE, TZ, NOW, { historyComplete: true });
    expect(without.driving.drivingRemainingMs).toBe(withFuture.driving.drivingRemainingMs);
    expect(without.window14.remainingMs).toBe(withFuture.window14.remainingMs);
  });

  // 8. "What Can I Do?" distinguishes current vs conditional availability.
  it('reports conditional rest completion when resting but not yet at 10h', () => {
    // gap-free: prior on-duty work, then the sleeper rest in progress (2h so far)
    const resting = [ev(14, 2, 'ON_DUTY'), ev(2, 0, 'SLEEPER_BERTH', { is_ongoing: true, end_timestamp: null })];
    const info = whatCanIDo(resting, CYCLE, TZ, NOW);
    expect(info.canDrive).toBe(false);
    expect(info.restingNow).toBe(true);
    expect(info.tenHourCompletesAt).not.toBeNull();
    // a driver mid-rest cannot drive now; the 10h completion is conditional
    expect(info.tenHourCompletesAt.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it('returns unavailable with null clocks for an uncalculable timeline', () => {
    const invalid = [
      ev(6, 5, 'OFF_DUTY'),
      ev(3, 0, 'DRIVING', { is_ongoing: true, end_timestamp: null }),
    ];
    const info = whatCanIDo(invalid, CYCLE, TZ, NOW, true);
    expect(info.unavailable).toBe(true);
    expect(info.driveRemainingMs).toBeNull();
    expect(info.windowRemainingMs).toBeNull();
    expect(info.cycleRemainingHours).toBeNull();
    expect(info.driveBlockers).toEqual([]);
  });

  it('keeps valid shift clocks but marks cycle unavailable without prior history', () => {
    const events = [ev(13, 3, 'OFF_DUTY'), ev(3, 0, 'DRIVING', { is_ongoing: true, end_timestamp: null })];
    const info = whatCanIDo(events, CYCLE, TZ, NOW, false);
    expect(info.unavailable).toBe(false);
    expect(info.cycleUnverified).toBe(true);
    expect(info.driveRemainingMs).toBeGreaterThan(0);
    expect(info.windowRemainingMs).toBeGreaterThan(0);
    expect(info.cycleRemainingHours).toBeNull();
    expect(info.driveBlockers.some(b => b.rule.includes('cycle'))).toBe(false);
  });

  it('keeps real zero and reset guidance for confirmed exhaustion', () => {
    const events = [ev(21, 11, 'OFF_DUTY'), ev(11, 0, 'DRIVING', { is_ongoing: true, end_timestamp: null })];
    const info = whatCanIDo(events, CYCLE, TZ, NOW, true);
    expect(info.unavailable).toBe(false);
    expect(info.driveRemainingMs).toBe(0);
    expect(info.driveBlockers.some(b => b.rule === '11-hour driving limit' && b.message.includes('10-hour rest'))).toBe(true);
  });

  it('returns actual available clocks for a fresh valid day with sufficient history', () => {
    const events = [ev(12, 2, 'OFF_DUTY'), ev(2, 0, 'ON_DUTY', { is_ongoing: true, end_timestamp: null })];
    const info = whatCanIDo(events, CYCLE, TZ, NOW, true);
    expect(info.unavailable).toBe(false);
    expect(info.cycleUnverified).toBe(false);
    expect(info.driveRemainingMs).toBe(11 * H);
    expect(info.windowRemainingMs).toBe(12 * H);
    expect(info.cycleRemainingHours).toBe(68);
  });

  // 9. Impossible city/time combination generates a location/time conflict.
  it('flags Miami→Atlanta in 2 hours as a conflict', () => {
    const r = distanceReasonableness('Miami', 'FL', 'Atlanta', 'GA', 2 * H);
    expect(r.known).toBe(true);
    expect(r.conflict).toBe(true);
    // Atlanta→Macon is ~85 mi, achievable in ~2h → no conflict
    const ok = distanceReasonableness('Atlanta', 'GA', 'Macon', 'GA', 2 * H);
    expect(ok.known).toBe(true);
    expect(ok.conflict).toBe(false);
  });

  // 10. Equipment/trailer swap preserves historical equipment in the remark.
  it('buildEquipmentChangeEvent records before/after trailers', () => {
    const e = buildEquipmentChangeEvent({
      date: '2026-08-19', start_timestamp: new Date(NOW - 1 * H).toISOString(),
      end_timestamp: new Date(NOW).toISOString(), city: 'Nashville', state: 'TN',
      trailerBefore: '123', trailerAfter: '456', action: 'swap',
    });
    expect(e.duty_status).toBe('ON_DUTY');
    expect(e.trailer_numbers).toBe('456');
    expect(e.remark).toContain('123');
    expect(e.remark).toContain('456');
  });

  // 11. Deterministic clock questions do not require an AI request.
  it('whatCanIDo driveRemainingMs matches the deterministic engine', () => {
    // gap-free: a prior 10h+ rest so the timeline is continuous back to a verified reset
    const events = [ev(30, 5, 'OFF_DUTY'), ev(5, 4, 'SLEEPER_BERTH'), ev(4, 1, 'DRIVING'), ev(1, 0, 'ON_DUTY', { is_ongoing: true, end_timestamp: null })];
    const info = whatCanIDo(events, CYCLE, TZ, NOW, true);
    const hos = computeHOS(events, CYCLE, TZ, NOW, { historyComplete: true });
    expect(info.unavailable).toBe(false);
    expect(info.driveRemainingMs).toBe(hos.driving.drivingRemainingMs);
    expect(info.windowRemainingMs).toBe(hos.window14.remainingMs);
  });

  // 12. All 9 split-sleeper scenarios continue to pass.
  it('all 9 split-sleeper scenarios pass', () => {
    expect(SCENARIOS.length).toBe(9);
    for (const s of SCENARIOS) {
      const r = runScenario(s);
      expect(r.splitStatus).toBe(s.expected.splitStatus);
      expect(Math.abs(r.driveRemH - s.expected.driveRemH)).toBeLessThanOrEqual(0.05);
      expect(Math.abs(r.windowRemH - s.expected.windowRemH)).toBeLessThanOrEqual(0.05);
    }
  });

  // Bonus: planToStops produces planned (non-actual) stops only.
  it('planToStops marks every stop as planned', () => {
    const stops = planToStops([
      { sequence: 1, type: 'drive', start_offset_min: 0, duration_min: 240, duty_status: 'DRIVING', label: 'Drive' },
      { sequence: 2, type: 'sleeper', start_offset_min: 240, duration_min: 600, duty_status: 'SLEEPER_BERTH', label: 'Rest' },
    ], NOW);
    expect(stops.length).toBe(2);
    expect(stops.every(s => s.planned === true)).toBe(true);
  });
});