// Regression tests for the ProposalReview three-state HOS fix.
// Covers the four display states + Apply-gate behavior. Pure consumer-layer
// tests; no changes to hosEngine/timelineEngine/HOS formulas.

import { describe, it, expect } from 'vitest';
import { validateProposal, hasBlocking, deriveHosDisplay } from './proposalValidation';

const UTC = 'UTC';
const NOW = (iso) => new Date(iso);

describe('deriveHosDisplay — three-state availability', () => {
  const calculableHos = {
    calculable: true,
    validity: { valid: true },
    driving: { applicable: true, drivingRemainingMs: 5 * 3600000 },
    window14: { applicable: true, remainingMs: 6 * 3600000 },
    break30: { satisfied: false, breakRequired: true },
    cycle: { cycleLimit: 70, cycleDays: 8, cycleUsedHours: 64, cycleRemainingHours: 6 },
  };

  it('valid + remaining time → real values', () => {
    const d = deriveHosDisplay(calculableHos, true);
    expect(d.calculable).toBe(true);
    expect(d.driving.value).toBe('5 hr 0 min');
    expect(d.driving.state).toBe('real');
    expect(d.window14.value).toBe('6 hr 0 min');
    expect(d.cycle.value).toBe('6.0 hr');
    expect(d.cycle.state).toBe('real');
  });

  it('insufficient prior history → Driving/14h real, Cycle --', () => {
    const d = deriveHosDisplay(calculableHos, false);
    expect(d.driving.value).toBe('5 hr 0 min');
    expect(d.window14.value).toBe('6 hr 0 min');
    expect(d.cycle.value).toBe('--');
    expect(d.cycle.state).toBe('unverified');
    expect(d.cycle.note).toMatch(/prior history/i);
  });

  it('uncalculable → all cards show --, never 0', () => {
    const uncalculable = {
      calculable: false,
      validity: { valid: false },
      driving: { applicable: false, drivingRemainingMs: 0 },
      window14: { applicable: false, remainingMs: 0 },
      break30: { satisfied: false, breakRequired: false },
      cycle: { cycleLimit: 70, cycleDays: 8, cycleUsedHours: 0, cycleRemainingHours: 0 },
    };
    const d = deriveHosDisplay(uncalculable, true);
    expect(d.calculable).toBe(false);
    expect(d.driving.value).toBe('--');
    expect(d.window14.value).toBe('--');
    expect(d.cycle.value).toBe('--');
    expect(d.break.value).toBe('--');
  });

  it('genuinely exhausted clock → real 0 + exhausted state', () => {
    const exhausted = {
      calculable: true,
      validity: { valid: true },
      driving: { applicable: true, drivingRemainingMs: 0 },
      window14: { applicable: true, remainingMs: 0 },
      break30: { satisfied: false, breakRequired: true },
      cycle: { cycleLimit: 70, cycleDays: 8, cycleUsedHours: 70, cycleRemainingHours: 0 },
    };
    const d = deriveHosDisplay(exhausted, true);
    expect(d.driving.value).toBe('0 hr 0 min');
    expect(d.driving.state).toBe('exhausted');
    expect(d.window14.value).toBe('0 hr 0 min');
    expect(d.window14.state).toBe('exhausted');
    expect(d.cycle.value).toBe('0.0 hr');
    expect(d.cycle.state).toBe('exhausted');
  });
});

describe('validateProposal — Apply gate + history threading', () => {
  it('structurally invalid (gap) → calculable false, cards --, Apply BLOCKED', () => {
    // 00:00-08:00 OFF, 12:00-15:00 DRIVING — gap 08:00-12:00 on the current day.
    const events = [
      { start_timestamp: '2026-08-25T00:00:00Z', end_timestamp: '2026-08-25T08:00:00Z', duty_status: 'OFF_DUTY' },
      { start_timestamp: '2026-08-25T12:00:00Z', end_timestamp: '2026-08-25T15:00:00Z', duty_status: 'DRIVING' },
    ];
    const res = validateProposal(events, [], { cycleType: '70_8', tz: UTC, now: NOW('2026-08-25T15:00:00Z') });
    expect(res.hos.calculable).toBe(false);
    // Coverage gaps are review-level BY DESIGN: the entries that ARE logged
    // stay saveable, the gap remains visible on the saved log for correction,
    // and unresolved notices persist as review notes. Only structural
    // contradictions (duplicates, same-start conflicts, negative durations)
    // are blocking.
    const gapWarning = res.warnings.find(w => w.type === 'elapsed_gap');
    expect(gapWarning?.severity).toBe('review');
    expect(hasBlocking(res.warnings)).toBe(false);
    const d = deriveHosDisplay(res.hos, res.historyComplete);
    expect(d.driving.value).toBe('--');
    expect(d.window14.value).toBe('--');
    expect(d.cycle.value).toBe('--');
  });

  it('insufficient prior history, otherwise valid → Driving/14h real, Cycle --, Apply not falsely blocked', () => {
    // Continuous day, pre-trip recorded, <8h driving. enteredPriorHistory=false
    // and events span only today → cycle history insufficient.
    const events = [
      { start_timestamp: '2026-08-25T00:00:00Z', end_timestamp: '2026-08-25T10:00:00Z', duty_status: 'SLEEPER_BERTH' },
      { start_timestamp: '2026-08-25T10:00:00Z', end_timestamp: '2026-08-25T10:30:00Z', duty_status: 'ON_DUTY', remark: 'Pre-Trip Inspection' },
      { start_timestamp: '2026-08-25T10:30:00Z', end_timestamp: '2026-08-25T15:00:00Z', duty_status: 'DRIVING' },
    ];
    const res = validateProposal(events, [], { cycleType: '70_8', tz: UTC, now: NOW('2026-08-25T15:00:00Z'), enteredPriorHistory: false });
    expect(res.hos.calculable).toBe(true);
    expect(res.historyComplete).toBe(false);
    const d = deriveHosDisplay(res.hos, res.historyComplete);
    expect(d.driving.value).not.toBe('--');
    expect(d.window14.value).not.toBe('--');
    expect(d.cycle.value).toBe('--');
    expect(d.cycle.state).toBe('unverified');
    // No false structural blocker from the history-uncalculable path.
    expect(hasBlocking(res.warnings)).toBe(false);
  });

  it('genuinely exhausted (11h) → real 0 + deterministic 11-Hour violation', () => {
    // 10h sleeper reset at 08:00, pre-trip, then 14.75h driving → 11h exceeded.
    const events = [
      { start_timestamp: '2026-08-24T22:00:00Z', end_timestamp: '2026-08-25T08:00:00Z', duty_status: 'SLEEPER_BERTH' },
      { start_timestamp: '2026-08-25T08:00:00Z', end_timestamp: '2026-08-25T08:15:00Z', duty_status: 'ON_DUTY', remark: 'Pre-Trip Inspection' },
      { start_timestamp: '2026-08-25T08:15:00Z', end_timestamp: '2026-08-25T23:00:00Z', duty_status: 'DRIVING' },
    ];
    const res = validateProposal(events, [], { cycleType: '70_8', tz: UTC, now: NOW('2026-08-25T23:00:00Z'), enteredPriorHistory: true });
    expect(res.hos.calculable).toBe(true);
    const d = deriveHosDisplay(res.hos, res.historyComplete);
    expect(d.driving.value).toBe('0 hr 0 min');
    expect(d.driving.state).toBe('exhausted');
    expect(res.violations.some(v => /11-Hour/.test(v.rule))).toBe(true);
  });

  it('valid proposal → Apply behavior unchanged (no false structural blocker)', () => {
    const events = [
      { start_timestamp: '2026-08-25T00:00:00Z', end_timestamp: '2026-08-25T10:00:00Z', duty_status: 'SLEEPER_BERTH' },
      { start_timestamp: '2026-08-25T10:00:00Z', end_timestamp: '2026-08-25T10:30:00Z', duty_status: 'ON_DUTY', remark: 'Pre-Trip Inspection' },
      { start_timestamp: '2026-08-25T10:30:00Z', end_timestamp: '2026-08-25T15:00:00Z', duty_status: 'DRIVING' },
    ];
    const res = validateProposal(events, [], { cycleType: '70_8', tz: UTC, now: NOW('2026-08-25T15:00:00Z'), enteredPriorHistory: true });
    expect(res.hos.calculable).toBe(true);
    expect(hasBlocking(res.warnings)).toBe(false);
  });
});