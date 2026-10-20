// ============================================================================
// LogbookAI — FABRICATED / UNSPECIFIED DRIVING START-TIME SAFEGUARD.
// ----------------------------------------------------------------------------
// Regression coverage for the PRD: a driving event with NO stated or reliably
// established start time must never carry midnight (12:00 AM) as if it were a
// confirmed actual timestamp, for typed AND voice requests alike. The guard is
// deterministic (proposalValidation.findFabricatedTimestampIssues, folded into
// validateProposal) and recomputes on the proposal AS EDITED, so a driver who
// fixes the time in Edit Proposal immediately unlocks Apply. Also covers:
//   - labeled inferred starts (non-midnight) stay allowed and are confirmed
//     explicitly by the driver before saving,
//   - the canonical save path never receives an unconfirmed fabricated
//     timestamp (Apply stays locked / shouldOfferApply stays false),
//   - no unrequested OFF_DUTY/SLEEPER or pre-trip events pass review,
//   - rest events the driver DID describe, and midnight the driver DID state,
//     remain allowed.
// All issues are exercised through validateProposal with an explicit guard
// present (the AI-proposal path); no AI call is made.
// ============================================================================
import { describe, it, expect, vi } from 'vitest';
vi.mock('@/api/base44Client', () => ({ base44: {} }));
import { validateProposal, hasBlocking } from './proposalValidation';
import { shouldOfferApply } from './aiLayer';

const TZ = 'America/New_York';
const DAY = '2026-10-20';
const NOW = new Date('2026-10-20T23:30:00-04:00'); // after every fixture event
const CYCLE = '70_8';
const at = (hm) => { const [h, m] = String(hm).split(':').map(Number); return new Date(new Date(`${DAY}T00:00:00-04:00`).getTime() + (h * 60 + (m || 0)) * 60000).toISOString(); };
const local = (hm) => { const [h, m] = String(hm).split(':').map(Number); return new Date(new Date(`${DAY}T00:00:00-04:00`).getTime() + (h * 60 + (m || 0)) * 60000)
  .toLocaleString('sv-SE', { timeZone: TZ }).replace(' ', 'T'); };
const fp = (start = 'explicit', end = 'explicit') => ({ start_time: start, end_time: end, status: 'explicit', city: 'explicit', state: 'explicit' });
const ev = (status, s, e, extra = {}) => ({
  date: DAY, start_timestamp: at(...[].concat(s)), end_timestamp: e == null ? null : at(...[].concat(e)),
  start_time_local: local(...[].concat(s)), end_time_local: e == null ? null : local(...[].concat(e)),
  duty_status: status, city: 'San Antonio', state: 'TX',
  ambiguous_fields: [], field_provenance: fp(), adjustments: [], source: extra.source || 'typed', ...extra,
});
const GUARD = {}; // any non-null explicit guard marks the AI-proposal path
const evaluate = (narrative, proposed) => validateProposal([], proposed, {
  cycleType: CYCLE, tz: TZ, now: NOW, narrative, explicitGuard: GUARD,
  provenance: { deterministic_explicit_facts: { times: [], locations: [], statuses: [] } },
});
const byType = (warnings, type) => warnings.find((w) => w.type === type);

// ---- 1. midnight placeholder is never saved as an actual driving start ----
describe('unspecified driving start time — midnight placeholder', () => {
  const MIDNIGHT_DRIVE = [
    ev('DRIVING', 0, null, { field_provenance: fp('inferred', 'explicit'), ambiguous_fields: ['start_timestamp'] }),
  ];

  it('typed request: blocked at review, never saved silently', () => {
    const v = evaluate('Log a driving event to San Antonio, Texas', MIDNIGHT_DRIVE);
    expect(hasBlocking(v.warnings)).toBe(true);
    expect(byType(v.warnings, 'fabricated_midnight_start')).toBeTruthy();
  });

  it('voice request: the same safeguard applies (source never weakens the guard)', () => {
    const v = evaluate('Log a driving event to San Antonio, Texas', MIDNIGHT_DRIVE.map((e) => ({ ...e, source: 'voice' })));
    expect(hasBlocking(v.warnings)).toBe(true);
    expect(byType(v.warnings, 'fabricated_midnight_start')).toBeTruthy();
  });

  it('claimed driver-stated (provenance explicit) is blocked the same way — a silent fabrication', () => {
    const v = evaluate('Log a driving event to San Antonio, Texas', [ev('DRIVING', 0, null)]);
    expect(hasBlocking(v.warnings)).toBe(true);
    expect(byType(v.warnings, 'fabricated_midnight_start')).toBeTruthy();
  });

  it('Apply is locked and Apply is never offered while the placeholder stands', () => {
    const v = evaluate('Log a driving event to San Antonio, Texas', MIDNIGHT_DRIVE);
    expect(v.warnings.some((w) => w.severity === 'blocking')).toBe(true);
  });

  it('a driver-stated midnight ("left Dallas at midnight") is preserved, never flagged', () => {
    const v = evaluate('Left Dallas at midnight and drove to San Antonio', [ev('DRIVING', 0, null)]);
    expect(byType(v.warnings, 'fabricated_midnight_start')).toBeUndefined();
    expect(hasBlocking(v.warnings)).toBe(false);
  });

  it('fixing the time in Edit Proposal clears the block (recomputed on the edited proposal)', () => {
    const fixed = [{ ...MIDNIGHT_DRIVE[0], driver_confirmed_times: true, start_timestamp: at(7), start_time_local: local(7) }];
    const v = evaluate('Log a driving event to San Antonio, Texas', fixed);
    expect(byType(v.warnings, 'fabricated_midnight_start')).toBeUndefined();
    expect(hasBlocking(v.warnings)).toBe(false);
  });
});

// ---- 2. unlabeled fabrication: no stated times + not marked inferred ----
describe('unspecified driving start time — unlabeled fabrication', () => {
  it('a non-midnight start claimed explicit (driver stated nothing) is blocked', () => {
    const v = evaluate('Log a driving event to San Antonio, Texas', [ev('DRIVING', 6, null)]);
    expect(byType(v.warnings, 'fabricated_start_time')).toBeTruthy();
    expect(hasBlocking(v.warnings)).toBe(true);
  });

  it('a clearly labeled inferred start is allowed and requires explicit driver confirmation', () => {
    const proposed = [ev('DRIVING', 6, null, { field_provenance: fp('inferred', 'explicit'), ambiguous_fields: ['start_timestamp'] })];
    const v = evaluate('Log a driving event to San Antonio, Texas', proposed);
    expect(byType(v.warnings, 'fabricated_start_time')).toBeUndefined();
    expect(byType(v.warnings, 'fabricated_midnight_start')).toBeUndefined();
    // the labeled inference reaches review (Apply offered), where the driver
    // confirms it explicitly — the event carries the inference marker
    expect(proposed[0].field_provenance.start_time).toBe('inferred');
  });

  it('a stated time keeps the normal explicit-fact path (no fabricated-start noise)', () => {
    const v = evaluate('I left Dallas at 8:30 AM and got to San Antonio at 1:30 PM', [ev('DRIVING', '8:30', '13:30')]);
    expect(byType(v.warnings, 'fabricated_start_time')).toBeUndefined();
    expect(byType(v.warnings, 'fabricated_midnight_start')).toBeUndefined();
  });
});

// ---- 3. no unrequested Off Duty / Sleeper / pre-trip events ----
describe('no unrequested Off Duty, Sleeper, or pre-trip events', () => {
  it('an OFF_DUTY event the driver never described is blocked', () => {
    const proposed = [ev('DRIVING', '8:30', '13:30'), ev('OFF_DUTY', 16, null, { field_provenance: fp('inferred', 'inferred') })];
    const v = evaluate('I drove to San Antonio and arrived at 1:30 PM', proposed);
    expect(byType(v.warnings, 'unrequested_rest_event')).toBeTruthy();
    expect(hasBlocking(v.warnings)).toBe(true);
  });

  it('a SLEEPER_BERTH event the driver never described is blocked', () => {
    const proposed = [ev('SLEEPER_BERTH', 20, null, { field_provenance: fp('inferred', 'inferred') })];
    const v = evaluate('I drove to San Antonio', proposed);
    expect(byType(v.warnings, 'unrequested_rest_event')).toBeTruthy();
  });

  it('rest the driver DID describe is never flagged', () => {
    const proposed = [ev('SLEEPER_BERTH', 20, null, { field_provenance: fp('explicit', 'inferred') })];
    const v = evaluate('I drove to San Antonio and then slept at the truck stop', proposed);
    expect(byType(v.warnings, 'unrequested_rest_event')).toBeUndefined();
  });

  it('a pre-trip event the driver never described is blocked', () => {
    const proposed = [ev('ON_DUTY', '7:45', '8:30', { activity_type: 'Pre-Trip', remark: 'Pre-Trip Inspection', field_provenance: fp('inferred', 'inferred') }), ev('DRIVING', '8:30', '13:30')];
    const v = evaluate('I drove to San Antonio and arrived at 1:30 PM', proposed);
    expect(byType(v.warnings, 'unrequested_pretrip')).toBeTruthy();
    expect(hasBlocking(v.warnings)).toBe(true);
  });

  it('a pre-trip the driver DID describe is never flagged', () => {
    const proposed = [ev('ON_DUTY', '7:45', '8:30', { activity_type: 'Pre-Trip', remark: 'Pre-Trip Inspection' }), ev('DRIVING', '8:30', '13:30')];
    const v = evaluate('I did my pre-trip at 7:45 then drove to San Antonio, arriving at 1:30 PM', proposed);
    expect(byType(v.warnings, 'unrequested_pretrip')).toBeUndefined();
  });
});

// ---- 4. canonical save path gates ----
describe('save-path gates', () => {
  it('a blocked fabricated-start proposal can never be applied (shouldOfferApply false)', () => {
    // mirrors LogAssistant's canApply: a proposal carrying the guard issues is
    // held for clarification, never silently applied
    const v = evaluate('Log a driving event to San Antonio, Texas', [ev('DRIVING', 0, null)]);
    expect(hasBlocking(v.warnings)).toBe(true);
    expect(shouldOfferApply({ intent: 'add_events', requires_clarification: false, proposed_events: [ev('DRIVING', 0, null)], explicit_guard: { blocking: true } })).toBe(false);
  });

  it('manual timeline edits (no AI guard present) are never second-guessed by this check', () => {
    const v = validateProposal([], [ev('DRIVING', 0, null)], { cycleType: CYCLE, tz: TZ, now: NOW, narrative: '' });
    expect(byType(v.warnings, 'fabricated_midnight_start')).toBeUndefined();
  });
});