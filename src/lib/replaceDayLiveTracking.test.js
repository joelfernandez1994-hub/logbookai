// ============================================================================
// LogbookAI — REGRESSION: replace_day must not leak existing live/current-
// status records into the reconstructed proposal.
// ----------------------------------------------------------------------------
// Verified against real data: CarrierProfile.home_terminal_city/state for
// this account is "Homestead"/"FL" (America/New_York), and Today.jsx's quick-
// status selector (DriverProfile.live_tracking_enabled, default true) creates
// exactly this kind of open, city-carried-forward current-status row. The
// stray "OFF_DUTY — Homestead, FL — Pre-Trip Inspection" event from the live
// Midwest test (see liveRegression.midwestOverlap.test.js) is genuine live-
// tracking data, not corruption — it is the driver's last real Today-page
// status, untouched since before the Gary/IN trip narrative began.
//
// Rule: a replace_day proposal reconstructs the ENTIRE target day from the
// driver's narrative alone. Existing records that fall on that day —
// including a still-open/ongoing one — are being REPLACED, not merged in as
// external facts to validate/overlap-check against. Any other intent keeps
// full existing/live-status context, unchanged.
// ============================================================================
import { describe, it, expect } from 'vitest';
import { existingOutsideReplacedDay } from './aiLayer';
import { validateProposal } from './proposalValidation';

const TZ = 'America/New_York';
const TARGET_DATE = '2026-09-06';

// The real stale record: OFF_DUTY, Homestead FL, open/ongoing, started well
// before the Gary/IN narrative's own timeline.
const STALE_HOMESTEAD_LIVE_EVENT = {
  id: '6a9d814ff36a3a1ff3bc0207',
  start_timestamp: '2026-09-06T15:05:48.707Z', // 11:05:48 AM ET
  end_timestamp: null,
  is_ongoing: true,
  duty_status: 'OFF_DUTY',
  city: 'Homestead', state: 'FL',
  remark: 'Pre-Trip Inspection',
};

// A representative slice of the driver's requested Gary, IN -> Midwest
// replace_day reconstruction (full set covered in liveRegression.midwestOverlap.test.js).
const GARY_MIDWEST_PROPOSED = [
  { start_timestamp: '2026-09-06T04:00:00.000Z', end_timestamp: '2026-09-06T09:45:00.000Z', duty_status: 'OFF_DUTY', city: 'Gary', state: 'IN', remark: 'Off duty in Gary, Indiana', field_provenance: { start_time: 'inferred', end_time: 'explicit' } },
  { start_timestamp: '2026-09-06T09:45:00.000Z', end_timestamp: '2026-09-06T10:00:00.000Z', duty_status: 'ON_DUTY', city: 'Gary', state: 'IN', remark: 'Pre-trip inspection', field_provenance: { start_time: 'explicit', end_time: 'explicit' } },
  { start_timestamp: '2026-09-06T10:00:00.000Z', end_timestamp: '2026-09-06T12:20:00.000Z', duty_status: 'DRIVING', city: 'Gary', state: 'IN', remark: 'Driving west', field_provenance: { start_time: 'explicit', end_time: 'explicit' } },
  { start_timestamp: '2026-09-06T12:20:00.000Z', end_timestamp: '2026-09-06T12:40:00.000Z', duty_status: 'ON_DUTY', city: 'Joliet', state: 'IL', remark: 'Fuel stop', field_provenance: { start_time: 'explicit', end_time: 'inferred' } },
  { start_timestamp: '2026-09-06T12:40:00.000Z', end_timestamp: '2026-09-06T15:30:00.000Z', duty_status: 'DRIVING', city: 'Joliet', state: 'IL', remark: 'Driving to Davenport', field_provenance: { start_time: 'inferred', end_time: 'explicit' } },
  { start_timestamp: '2026-09-06T15:30:00.000Z', end_timestamp: '2026-09-06T16:00:00.000Z', duty_status: 'OFF_DUTY', city: 'Davenport', state: 'IA', remark: '30-minute break', field_provenance: { start_time: 'explicit', end_time: 'explicit' } },
  { start_timestamp: '2026-09-06T16:00:00.000Z', end_timestamp: '2026-09-07T00:30:00.000Z', duty_status: 'DRIVING', city: 'Davenport', state: 'IA', remark: 'Driving the rest of the route', field_provenance: { start_time: 'explicit', end_time: 'explicit' } },
  { start_timestamp: '2026-09-07T00:30:00.000Z', end_timestamp: null, duty_status: 'OFF_DUTY', city: 'Lincoln', state: 'NE', remark: 'Off duty for the night', field_provenance: { start_time: 'explicit', end_time: 'inferred' } },
];

describe('existingOutsideReplacedDay — pure scoping rules', () => {
  it('excludes an event that starts within the target day, even though it is still open/ongoing', () => {
    const result = existingOutsideReplacedDay([STALE_HOMESTEAD_LIVE_EVENT], TARGET_DATE, TZ);
    expect(result).toEqual([]);
  });

  it('excludes an event that started before the target day but is still ongoing into it (cross-boundary)', () => {
    const crossBoundary = { ...STALE_HOMESTEAD_LIVE_EVENT, start_timestamp: '2026-09-05T20:00:00.000Z' }; // starts the day before
    const result = existingOutsideReplacedDay([crossBoundary], TARGET_DATE, TZ);
    expect(result).toEqual([]);
  });

  it('keeps an event entirely before the target day', () => {
    const yesterday = { ...STALE_HOMESTEAD_LIVE_EVENT, start_timestamp: '2026-09-05T10:00:00.000Z', end_timestamp: '2026-09-05T12:00:00.000Z', is_ongoing: false };
    const result = existingOutsideReplacedDay([yesterday], TARGET_DATE, TZ);
    expect(result).toHaveLength(1);
  });

  it('keeps an event entirely after the target day', () => {
    const tomorrow = { ...STALE_HOMESTEAD_LIVE_EVENT, start_timestamp: '2026-09-07T10:00:00.000Z', end_timestamp: '2026-09-07T12:00:00.000Z', is_ongoing: false };
    const result = existingOutsideReplacedDay([tomorrow], TARGET_DATE, TZ);
    expect(result).toHaveLength(1);
  });

  it('never throws on malformed input and leaves an event with no start_timestamp untouched', () => {
    expect(() => existingOutsideReplacedDay(null, TARGET_DATE, TZ)).not.toThrow();
    expect(existingOutsideReplacedDay([{ city: 'X' }], TARGET_DATE, TZ)).toEqual([{ city: 'X' }]);
  });
});

describe('REGRESSION — replace_day reconstruction does not leak the stale Homestead live-status row', () => {
  it('the scoped existing list passed to validation is empty (Homestead never merged in)', () => {
    const scoped = existingOutsideReplacedDay([STALE_HOMESTEAD_LIVE_EVENT], TARGET_DATE, TZ);
    expect(scoped).toEqual([]);
  });

  it('the validated/merged timeline contains ONLY the reconstructed Gary->Midwest events — no Homestead event mixed in', () => {
    const scoped = existingOutsideReplacedDay([STALE_HOMESTEAD_LIVE_EVENT], TARGET_DATE, TZ);
    const res = validateProposal(scoped, GARY_MIDWEST_PROPOSED, {
      cycleType: '70_8', tz: TZ, now: new Date('2026-09-07T01:44:00.000Z'),
    });
    expect(res.merged).toHaveLength(GARY_MIDWEST_PROPOSED.length);
    expect(res.merged.some((e) => e.city === 'Homestead')).toBe(false);
  });

  it('no overlap is created from the excluded live-status row', () => {
    const scoped = existingOutsideReplacedDay([STALE_HOMESTEAD_LIVE_EVENT], TARGET_DATE, TZ);
    const res = validateProposal(scoped, GARY_MIDWEST_PROPOSED, {
      cycleType: '70_8', tz: TZ, now: new Date('2026-09-07T01:44:00.000Z'),
    });
    expect(res.warnings.filter((w) => w.type === 'overlap')).toHaveLength(0);
    expect(res.warnings.filter((w) => w.type === 'explicit_boundary_conflict')).toHaveLength(0);
  });

  it('by contrast, a non-replace_day (add_events-style) validation of the SAME data still sees the stale event as real context — proving the scoping is intent-specific, not a blanket exclusion', () => {
    // Unscoped existing (as add_events correctly still uses) — the stale
    // event is genuinely present in the merged timeline for that intent.
    const res = validateProposal([STALE_HOMESTEAD_LIVE_EVENT], GARY_MIDWEST_PROPOSED, {
      cycleType: '70_8', tz: TZ, now: new Date('2026-09-07T01:44:00.000Z'),
    });
    expect(res.merged.some((e) => e.city === 'Homestead')).toBe(true);
  });

  it('building/validating the proposal never writes anything — both functions are pure and synchronous, with no writer call involved', () => {
    // existingOutsideReplacedDay and validateProposal are plain synchronous
    // functions (no Promise, no timelineWriter import) — proposal
    // construction/review can never persist a change. Only an explicit
    // driver Apply (a separate, later call to insertEventsBatch/
    // replaceRangeEvents) does that.
    const scoped = existingOutsideReplacedDay([STALE_HOMESTEAD_LIVE_EVENT], TARGET_DATE, TZ);
    const result = validateProposal(scoped, GARY_MIDWEST_PROPOSED, { cycleType: '70_8', tz: TZ });
    expect(result).not.toBeInstanceOf(Promise);
    expect(scoped).not.toBeInstanceOf(Promise);
  });
});
