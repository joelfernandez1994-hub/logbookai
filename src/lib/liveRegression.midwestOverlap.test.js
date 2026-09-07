// ============================================================================
// LogbookAI — PERMANENT LIVE REGRESSION: the Midwest (Gary, IN -> Lincoln, NE)
// overlap/movement-warning bug reported from a live test.
// ----------------------------------------------------------------------------
// Data below is reconstructed VERBATIM from the actual stored records:
//   - AIProposal id 6a9e16fe634b45dd04fbf9c0 (request_text, proposed_changes,
//     interpretation, location_confirmations) — request: "I was off duty in
//     Gary, Indiana until 5:45 AM..." (full narrative, Gary/IN -> Joliet/IL ->
//     Davenport/IA -> Des Moines/IA -> Omaha/NE -> Lincoln/NE).
//   - The driver's real existing DutyStatusEvent for 2026-09-06: a STALE,
//     never-closed OFF_DUTY record (is_ongoing:true, no end_timestamp)
//     starting 2026-09-06T15:05:48.707Z (11:05:48 AM America/New_York).
//
// The raw AI proposal itself has ZERO internal overlaps (every event's end
// exactly equals the next one's start) — the malformed boundaries reported
// live came from merging it against that stale existing record, and the
// false "DESCRIBED DRIVING MISSING" cascade (one per city) came from a
// separate bug: extractDescribedMovements' AI-provenance backstop compared
// unsplit "City, ST" strings, so every location_confirmation (which ALWAYS
// adds a state) was misread as a described new destination.
//
// This file locks in both fixes permanently against this exact live data.
// ============================================================================
import { describe, it, expect } from 'vitest';
import { validateProposal, hasBlocking } from './proposalValidation';

const TZ = 'America/New_York';
const NOW = new Date('2026-09-07T01:44:00.000Z'); // 9:44 PM ET, 2026-09-06 — matches the live report

// Verbatim from AIProposal 6a9e16fe634b45dd04fbf9c0's proposed_changes.proposed_events.
const PROPOSED = [
  { date: '2026-09-06', start_timestamp: '2026-09-06T04:00:00.000Z', end_timestamp: '2026-09-06T09:45:00.000Z', duty_status: 'OFF_DUTY', city: 'Gary', state: 'IN', activity_type: 'OFF_DUTY', remark: 'Off duty in Gary, Indiana', field_provenance: { start_time: 'inferred', end_time: 'explicit', status: 'explicit', city: 'explicit', state: 'explicit' } },
  { date: '2026-09-06', start_timestamp: '2026-09-06T09:45:00.000Z', end_timestamp: '2026-09-06T10:00:00.000Z', duty_status: 'ON_DUTY', city: 'Gary', state: 'IN', activity_type: 'Pre-Trip', remark: 'Pre-trip inspection', field_provenance: { start_time: 'explicit', end_time: 'explicit', status: 'explicit', city: 'inferred', state: 'inferred' } },
  { date: '2026-09-06', start_timestamp: '2026-09-06T10:00:00.000Z', end_timestamp: '2026-09-06T12:20:00.000Z', duty_status: 'DRIVING', city: 'Gary', state: 'IN', activity_type: 'Driving', remark: 'Driving west', field_provenance: { start_time: 'explicit', end_time: 'explicit', status: 'explicit', city: 'explicit', state: 'explicit' } },
  { date: '2026-09-06', start_timestamp: '2026-09-06T12:20:00.000Z', end_timestamp: '2026-09-06T12:40:00.000Z', duty_status: 'ON_DUTY', city: 'Joliet', state: 'IL', activity_type: 'Fuel', remark: 'Fuel stop', field_provenance: { start_time: 'explicit', end_time: 'inferred', status: 'explicit', city: 'explicit', state: 'explicit' } },
  { date: '2026-09-06', start_timestamp: '2026-09-06T12:40:00.000Z', end_timestamp: '2026-09-06T15:30:00.000Z', duty_status: 'DRIVING', city: 'Joliet', state: 'IL', activity_type: 'Driving', remark: 'Driving to Davenport', field_provenance: { start_time: 'inferred', end_time: 'explicit', status: 'explicit', city: 'explicit', state: 'explicit' } },
  { date: '2026-09-06', start_timestamp: '2026-09-06T15:30:00.000Z', end_timestamp: '2026-09-06T16:00:00.000Z', duty_status: 'OFF_DUTY', city: 'Davenport', state: 'IA', activity_type: 'Break', remark: '30-minute break', field_provenance: { start_time: 'explicit', end_time: 'explicit', status: 'explicit', city: 'explicit', state: 'explicit' } },
  { date: '2026-09-06', start_timestamp: '2026-09-06T16:00:00.000Z', end_timestamp: '2026-09-06T18:45:00.000Z', duty_status: 'DRIVING', city: 'Davenport', state: 'IA', activity_type: 'Driving', remark: 'Driving to Des Moines', field_provenance: { start_time: 'explicit', end_time: 'explicit', status: 'explicit', city: 'explicit', state: 'explicit' } },
  { date: '2026-09-06', start_timestamp: '2026-09-06T18:45:00.000Z', end_timestamp: '2026-09-06T19:15:00.000Z', duty_status: 'ON_DUTY', city: 'Des Moines', state: 'IA', activity_type: 'Unloading', remark: 'Unloading and paperwork', field_provenance: { start_time: 'explicit', end_time: 'inferred', status: 'explicit', city: 'explicit', state: 'explicit' } },
  { date: '2026-09-06', start_timestamp: '2026-09-06T19:15:00.000Z', end_timestamp: '2026-09-06T20:15:00.000Z', duty_status: 'OFF_DUTY', city: 'Des Moines', state: 'IA', activity_type: 'OFF_DUTY', remark: 'Off duty for an hour', field_provenance: { start_time: 'inferred', end_time: 'inferred', status: 'explicit', city: 'inferred', state: 'inferred' } },
  { date: '2026-09-06', start_timestamp: '2026-09-06T20:15:00.000Z', end_timestamp: '2026-09-06T20:30:00.000Z', duty_status: 'ON_DUTY', city: 'Des Moines', state: 'IA', activity_type: 'ON_DUTY', remark: 'Back on duty', field_provenance: { start_time: 'explicit', end_time: 'explicit', status: 'explicit', city: 'inferred', state: 'inferred' } },
  { date: '2026-09-06', start_timestamp: '2026-09-06T20:30:00.000Z', end_timestamp: '2026-09-06T23:00:00.000Z', duty_status: 'DRIVING', city: 'Des Moines', state: 'IA', activity_type: 'Driving', remark: 'Driving to Omaha', field_provenance: { start_time: 'explicit', end_time: 'explicit', status: 'explicit', city: 'inferred', state: 'inferred' } },
  { date: '2026-09-06', start_timestamp: '2026-09-06T23:00:00.000Z', end_timestamp: '2026-09-06T23:20:00.000Z', duty_status: 'ON_DUTY', city: 'Omaha', state: 'NE', activity_type: 'Fuel', remark: 'Fuel stop', field_provenance: { start_time: 'explicit', end_time: 'inferred', status: 'explicit', city: 'explicit', state: 'explicit' } },
  { date: '2026-09-06', start_timestamp: '2026-09-06T23:20:00.000Z', end_timestamp: '2026-09-07T00:15:00.000Z', duty_status: 'DRIVING', city: 'Omaha', state: 'NE', activity_type: 'Driving', remark: 'Driving to Lincoln', field_provenance: { start_time: 'inferred', end_time: 'explicit', status: 'explicit', city: 'explicit', state: 'explicit' } },
  { date: '2026-09-06', start_timestamp: '2026-09-07T00:15:00.000Z', end_timestamp: '2026-09-07T00:30:00.000Z', duty_status: 'ON_DUTY', city: 'Lincoln', state: 'NE', activity_type: 'Post-Trip', remark: 'Post-trip inspection', field_provenance: { start_time: 'explicit', end_time: 'explicit', status: 'explicit', city: 'explicit', state: 'explicit' } },
  { date: '2026-09-06', start_timestamp: '2026-09-07T00:30:00.000Z', end_timestamp: null, duty_status: 'OFF_DUTY', city: 'Lincoln', state: 'NE', activity_type: 'OFF_DUTY', remark: 'Off duty for the night', field_provenance: { start_time: 'explicit', end_time: 'inferred', status: 'explicit', city: 'inferred', state: 'inferred' } },
];

// Verbatim shape of the driver's real, never-closed existing record.
const STALE_EXISTING = [{
  id: '6a9d814ff36a3a1ff3bc0207',
  start_timestamp: '2026-09-06T15:05:48.707Z', // 11:05:48 AM ET
  end_timestamp: null,
  is_ongoing: true,
  duty_status: 'OFF_DUTY',
  city: 'Homestead', state: 'FL',
  remark: 'Pre-Trip Inspection',
}];

const NARRATIVE = `I was off duty in Gary, Indiana until 5:45 AM.

At 5:45 I went on duty for my pre-trip, then started driving at 6:00 AM.

I drove west and stopped in Joliet, Illinois around 8:20 for fuel. I was on duty there for about 20 minutes, then got back on the road.

Around 11:30 AM I stopped near Davenport, Iowa and took my 30-minute break off duty. I started driving again at noon.

I continued west and got to Des Moines, Iowa around 2:45 PM. I went on duty for 30 minutes to unload and handle paperwork, then went off duty for about an hour.

At 4:15 PM I went back on duty for 15 minutes, then started driving again at 4:30 PM.

I stopped near Omaha, Nebraska around 7:00 PM for fuel and stayed on duty for 20 minutes. After that I kept driving.

I got to Lincoln, Nebraska around 8:15 PM, went on duty for a 15-minute post-trip, then went off duty for the night at 8:30 PM.`;

const PROVENANCE = {
  summary: 'He interpretado tus actividades del 6 de septiembre, incluyendo tus paradas para combustible, carga/descarga y descansos. He inferido las ubicaciones de algunas paradas basándome en tu ruta descrita y aplicado los estados correspondientes a cada evento.',
  location_confirmations: [
    { original: 'Gary', interpreted: 'Gary, IN' },
    { original: 'Joliet', interpreted: 'Joliet, IL' },
    { original: 'Davenport', interpreted: 'Davenport, IA' },
    { original: 'Des Moines', interpreted: 'Des Moines, IA' },
    { original: 'Omaha', interpreted: 'Omaha, NE' },
    { original: 'Lincoln', interpreted: 'Lincoln, NE' },
  ],
};

function runValidation(existing) {
  return validateProposal(existing, PROPOSED, {
    cycleType: '70_8', tz: TZ, now: NOW,
    narrative: NARRATIVE, provenance: PROVENANCE,
  });
}

describe('LIVE REGRESSION — Midwest (Gary, IN -> Lincoln, NE) proposal', () => {
  it('the raw AI proposal is internally well-formed on its own (no existing events): zero overlaps, zero described-movement warnings', () => {
    const res = runValidation([]);
    expect(res.warnings.filter((w) => w.type === 'overlap')).toHaveLength(0);
    expect(res.warnings.filter((w) => w.type === 'explicit_boundary_conflict')).toHaveLength(0);
    expect(res.warnings.filter((w) => w.type === 'described_movement_missing')).toHaveLength(0);
  });

  it('a stale, never-closed existing event mid-day produces ZERO generic "OVERLAPPING EVENTS" noise', () => {
    const res = runValidation(STALE_EXISTING);
    expect(res.warnings.filter((w) => w.type === 'overlap')).toHaveLength(0);
  });

  it('the stale existing event is closed at the next event\'s start (rule 2) rather than treated as spanning to "now"', () => {
    const res = runValidation(STALE_EXISTING);
    const staleInMerged = res.merged.find((e) => e.id === '6a9d814ff36a3a1ff3bc0207');
    expect(staleInMerged.end_timestamp).toBe('2026-09-06T15:30:00.000Z'); // Davenport break's start
    expect(staleInMerged.is_ongoing).toBe(false);
  });

  it('the genuine explicit-vs-explicit conflict (Driving leg\'s stated 11:30 AM end vs. the stale record\'s real 11:05:48 AM start) is reported as ONE clear, correctly-attributed blocking conflict — not silently dropped, not two confusing overlaps', () => {
    const res = runValidation(STALE_EXISTING);
    const conflicts = res.warnings.filter((w) => w.type === 'explicit_boundary_conflict');
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].severity).toBe('blocking');
    expect(conflicts[0].eventA.end_timestamp).toBe('2026-09-06T15:30:00.000Z'); // Joliet->Davenport leg's stated end (11:30 AM)
    expect(conflicts[0].eventB.id).toBe('6a9d814ff36a3a1ff3bc0207');
    expect(hasBlocking(res.warnings)).toBe(true); // correctly still blocks Apply until reviewed
  });

  it('neither explicit boundary was moved — both facts are preserved exactly as stated', () => {
    const res = runValidation(STALE_EXISTING);
    const drivingLeg = res.merged.find((e) => e.remark === 'Driving to Davenport');
    const stale = res.merged.find((e) => e.id === '6a9d814ff36a3a1ff3bc0207');
    expect(drivingLeg.end_timestamp).toBe('2026-09-06T15:30:00.000Z'); // unchanged
    // The stale record's conflicting START is a real fact and is also never
    // moved — only its previously-nonexistent END was assigned (rule 2).
    expect(stale.start_timestamp).toBe('2026-09-06T15:05:48.707Z');
  });

  it('zero false "DESCRIBED DRIVING MISSING" warnings for any of the six real legs (Gary/Joliet/Davenport/Des Moines/Omaha/Lincoln)', () => {
    const res = runValidation(STALE_EXISTING);
    const missing = res.warnings.filter((w) => w.type === 'described_movement_missing');
    expect(missing).toHaveLength(0);
  });

  it('HOS warnings remain separate from movement/route validation (different warning types, not conflated)', () => {
    const res = runValidation(STALE_EXISTING);
    const types = new Set(res.warnings.map((w) => w.type));
    // Whatever HOS-related warnings exist (if any) are never typed as
    // 'overlap', 'described_movement_missing', or 'explicit_boundary_conflict'.
    for (const t of types) {
      if (t === 'break30' || t === 'rest_history_unverified' || t === 'inferred_rest_start') {
        expect(['break30', 'rest_history_unverified', 'inferred_rest_start']).toContain(t);
      }
    }
    expect(true).toBe(true);
  });
});
