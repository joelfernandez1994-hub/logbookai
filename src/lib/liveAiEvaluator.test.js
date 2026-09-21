// Tests for the live-AI SCORER itself: it must fail known-bad structured
// responses (the exact failure shapes seen in the stress test) and pass
// known-good ones, so a live run's pass/fail table can be trusted.
import { describe, it, expect } from 'vitest';
import { evaluateLive, evaluateDownstream, localHM, sequenceIssues } from './liveAiEvaluator';
import { PROMPTS, CORRECTION_FIXTURE, fixtureFor } from './liveAiPromptSet';

const TZ = 'America/New_York';
const DAY = '2026-09-21';
// local wall time on DAY (EDT, UTC-4) -> ISO
const t = (hm, dayOffset = 0) => { const [h, m] = hm.split(':').map(Number); return new Date(Date.UTC(2026, 8, 21 + dayOffset, h + 4, m)).toISOString(); };
const ev = (status, city, state, s, e, extra = {}) => ({
  duty_status: status, city, state, start_timestamp: t(s), end_timestamp: e == null ? null : t(e),
  field_provenance: { start_time: 'explicit', end_time: 'explicit', status: 'explicit', city: 'explicit', state: 'explicit' }, ambiguous_fields: [], ...extra,
});
const spec = (id) => PROMPTS.find((p) => p.id === id);

describe('prompt set integrity', () => {
  it('has 50+ prompts, unique ids, and every requested category', () => {
    expect(PROMPTS.length).toBeGreaterThanOrEqual(50);
    expect(new Set(PROMPTS.map((p) => p.id)).size).toBe(PROMPTS.length);
    const cats = new Set(PROMPTS.map((p) => p.cat));
    for (const c of ['single', 'multi', 'multi-long', 'midnight', 'correction', 'delete', 'vague', 'here', 'ambiguous-city', 'impossible-route', 'plausible-route', 'mileage', 'hos', 'time', 'location', 'previously-broken']) {
      expect(cats.has(c), c).toBe(true);
    }
  });
  it('contains every prompt the driver listed as previously broken', () => {
    const texts = PROMPTS.map((p) => p.prompt.toLowerCase());
    for (const p of ['left miami at 8 am and got to orlando at 9 am', 'left miami around 8ish', 'left la at 6 and arrived in las vegas at 11', 'headed to nashville', 'drove over to hialeah', 'started driving from miami', 'drove for about 3 hours', 'i loaded here at 8', 'i went to bed at 10 pm', 'i drove from springfield to columbia']) {
      expect(texts.some((x) => x.includes(p)), p).toBe(true);
    }
  });
  it('correction fixture indices match the specs that reference them', () => {
    const f = CORRECTION_FIXTURE((hm) => t(hm));
    expect(f[1].remark).toBe('Loading'); expect(f[2].duty_status).toBe('DRIVING'); expect(f[3].remark).toBe('Fuel'); expect(f[6].duty_status).toBe('SLEEPER_BERTH');
    expect(fixtureFor(spec('H05'), (hm) => t(hm))).toHaveLength(7);
  });
});

describe('scorer fails the bad shapes seen in the stress test', () => {
  it('A01: destination dropped -> fails (the old parser bug)', () => {
    const bad = { intent: 'add_events', proposed_events: [ev('DRIVING', '', '', '08:00', null)] };
    const r = evaluateLive(spec('A01'), bad, TZ);
    expect(r.pass).toBe(false);
    expect(r.fails.some((f) => f.cat === 'location')).toBe(true);
  });
  it('A02: departure logged at noon instead of 8ish -> fails on time', () => {
    const bad = { intent: 'add_events', proposed_events: [ev('DRIVING', 'Miami', 'FL', '12:00', null), ev('ON_DUTY', 'Orlando', 'FL', '12:00', null)] };
    const r = evaluateLive(spec('A02'), bad, TZ);
    expect(r.fails.some((f) => f.cat === 'time')).toBe(true);
  });
  it('A02: exact time manufactured from "8ish" (marked explicit) -> fails', () => {
    const bad = { intent: 'add_events', proposed_events: [ev('DRIVING', 'Miami', 'FL', '08:00', '12:00'), ev('ON_DUTY', 'Orlando', 'FL', '12:00', null)] };
    const r = evaluateLive(spec('A02'), bad, TZ);
    expect(r.fails.some((f) => /manufactured precision/.test(f.msg))).toBe(true);
  });
  it('A03: origin stamped with the destination city / wrong state -> fails', () => {
    const bad = { intent: 'add_events', proposed_events: [ev('DRIVING', 'Las Vegas', 'NV', '06:00', '11:00')] };
    expect(evaluateLive(spec('A03'), bad, TZ).pass).toBe(false);
  });
  it('A08: "here" resolved to an invented city -> fails; asking with a blank location passes', () => {
    const bad = { intent: 'add_events', proposed_events: [ev('ON_DUTY', 'Miami', 'FL', '08:00', null)] };
    expect(evaluateLive(spec('A08'), bad, TZ).pass).toBe(false);
    const good = { intent: 'add_events', requires_clarification: true, clarification_question: 'Where is "here"?', proposed_events: [ev('ON_DUTY', '', '', '08:00', null)] };
    expect(evaluateLive(spec('A08'), good, TZ).pass).toBe(true);
  });
  it('A10: silently choosing a state for Springfield/Columbia -> fails; asking passes', () => {
    const bad = { intent: 'add_events', proposed_events: [ev('DRIVING', 'Springfield', 'IL', '08:00', '11:00'), ev('ON_DUTY', 'Columbia', 'MO', '11:00', null)] };
    const r = evaluateLive(spec('A10'), bad, TZ);
    expect(r.pass).toBe(false);
    const good = { intent: 'clarification', requires_clarification: true, clarification_question: 'Which states?', proposed_events: [] };
    expect(evaluateLive(spec('A10'), good, TZ).pass).toBe(true);
  });
  it('vague input that produces invented events without asking -> fails', () => {
    const bad = { intent: 'add_events', proposed_events: [ev('DRIVING', 'Orlando', 'FL', '08:00', '11:00')] };
    expect(evaluateLive(spec('I01'), bad, TZ).pass).toBe(false);
  });
});

describe('scorer checks timeline structure on every multi-event proposal', () => {
  it('flags overlaps, gaps and out-of-order events', () => {
    const tz = TZ;
    expect(sequenceIssues([ev('DRIVING', 'A', 'FL', '08:00', '10:00'), ev('ON_DUTY', 'B', 'FL', '09:30', '10:30')], tz).some((i) => i.cat === 'timeline_overlap')).toBe(true);
    expect(sequenceIssues([ev('DRIVING', 'A', 'FL', '08:00', '10:00'), ev('ON_DUTY', 'B', 'FL', '10:30', '11:00')], tz).some((i) => i.cat === 'timeline_gap')).toBe(true);
    expect(sequenceIssues([ev('ON_DUTY', 'B', 'FL', '10:00', '11:00'), ev('DRIVING', 'A', 'FL', '08:00', '10:00')], tz).some((i) => i.cat === 'order')).toBe(true);
    expect(sequenceIssues([ev('DRIVING', 'A', 'FL', '08:00', '10:00'), ev('ON_DUTY', 'B', 'FL', '10:00', null)], tz)).toEqual([]);
  });
});

describe('corrections and deletes', () => {
  it('H01 passes only when the DRIVING event (index 2) is the single corrected event at 08:00', () => {
    const good = { intent: 'edit_events', proposed_events: [{ ...ev('DRIVING', 'Miami', 'FL', '08:00', '11:30'), edit_target_index: 2 }] };
    expect(evaluateLive(spec('H01'), good, TZ).pass).toBe(true);
    const wrong = { intent: 'edit_events', proposed_events: [{ ...ev('DRIVING', 'Miami', 'FL', '08:00', '11:30'), edit_target_index: 4 }] };
    expect(evaluateLive(spec('H01'), wrong, TZ).fails.some((f) => /wrong event/.test(f.msg))).toBe(true);
    const dup = { intent: 'edit_events', proposed_events: [{ ...ev('DRIVING', 'Miami', 'FL', '08:00', '11:30'), edit_target_index: 2 }, ev('DRIVING', 'Miami', 'FL', '08:00', '11:30')] };
    expect(evaluateLive(spec('H01'), dup, TZ).pass).toBe(false);
  });
  it('H05 passes only for delete_target_indices [3] with no proposed events', () => {
    expect(evaluateLive(spec('H05'), { intent: 'delete_events', delete_target_indices: [3], proposed_events: [] }, TZ).pass).toBe(true);
    expect(evaluateLive(spec('H05'), { intent: 'delete_events', delete_target_indices: [3, 4], proposed_events: [] }, TZ).pass).toBe(false); // neighbor deleted too
    expect(evaluateLive(spec('H05'), { intent: 'add_events', delete_target_indices: [], proposed_events: [ev('ON_DUTY', '', '', '11:30', '12:00')] }, TZ).pass).toBe(false);
  });
});

describe('downstream scoring', () => {
  it('an impossible leg the route check did not flag is a failure; a flagged one passes', () => {
    expect(evaluateDownstream({ routeConflict: true }, { routeConflict: false, warningTypes: [], violations: [] }).pass).toBe(false);
    expect(evaluateDownstream({ routeConflict: true }, { routeConflict: true, warningTypes: [], violations: [] }).pass).toBe(true);
    expect(evaluateDownstream({ routeConflict: false }, { routeConflict: true, warningTypes: [], violations: [] }).pass).toBe(false);
  });
  it('HOS violations and mileage warnings are checked by name', () => {
    expect(evaluateDownstream({ violations: ['11-Hour Driving Limit'] }, { violations: [], warningTypes: [] }).pass).toBe(false);
    expect(evaluateDownstream({ violations: ['11-Hour Driving Limit'] }, { violations: ['11-Hour Driving Limit'], warningTypes: [] }).pass).toBe(true);
    expect(evaluateDownstream({ mileageWarn: true }, { warningTypes: [] }).pass).toBe(false);
    expect(evaluateDownstream({ mileageWarn: false }, { warningTypes: ['stated_mileage_mismatch'] }).pass).toBe(false);
  });
  it('localHM converts UTC ISO to carrier-local wall time', () => {
    expect(localHM(t('08:00'), TZ)).toBe('08:00');
    expect(localHM('2026-09-22T04:00:00.000Z', TZ)).toBe('00:00');
  });
});
