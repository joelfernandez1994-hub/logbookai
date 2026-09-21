import { it, vi } from 'vitest';
vi.mock('@/api/base44Client', () => ({ base44: {} }));
import { validateInterpretResult } from './aiLayer';
import { normalizeCandidateTimeline } from './timelineNormalization';
import { enrichProposalMileage, addRouteWarning, validateProposal } from './proposalValidation';
import { reconstructDrivingDurations } from './drivingDurationReconstruction';

const NOW = new Date('2026-09-21T15:54:52Z'); const TZ = 'America/New_York';
const ROUTES = { 'Miami, FL|Orlando, FL': [235, 3.4], 'Miami, FL|Jacksonville, FL': [345, 5.0], 'Dallas, TX|Houston, TX': [238, 3.6], 'Houston, TX|San Antonio, TX': [196, 3.0] };
const provider = async (o, d) => { const r = ROUTES[`${o}|${d}`]; return r ? { miles: r[0], hours: r[1] } : null; };
const fp = (s='explicit', e='explicit', st='explicit', c='explicit', S='inferred') => ({ start_time: s, end_time: e, status: st, city: c, state: S });
const E = (s, st, en, c, ST, prov, amb=[]) => ({ duty_status: s, start_timestamp: st, end_timestamp: en, city: c, state: ST, field_provenance: prov, ambiguous_fields: amb, adjustments: [], source: 'typed', edit_target_index: null });

const cases = {
  D01: { input: 'I left Miami at 8 AM and arrived in Orlando at 9 AM', events: [E('DRIVING','2026-09-21T12:00:00.000Z','2026-09-21T13:00:00.000Z','Miami','FL', fp())], locConf: [{original:'Miami',interpreted:'Miami, FL'},{original:'Orlando',interpreted:'Orlando, FL'}] },
  C11: { input: 'I drove from Miami to Orlando', events: [E('DRIVING','2026-09-21T12:00:00.000Z','2026-09-21T16:00:00.000Z','Miami','FL', fp('inferred','inferred','explicit','explicit','explicit'), ['start_time','end_time'])], locConf: [{original:'Miami',interpreted:'Miami, FL'},{original:'Orlando',interpreted:'Orlando, FL'}] },
  G01: { input: 'I drove from Miami to Orlando from 10 PM to 4 AM', events: [E('DRIVING','2026-09-22T02:00:00.000Z','2026-09-21T08:00:00.000Z','Miami','FL', fp('explicit','explicit','explicit','explicit','explicit'))], locConf: [{original:'Miami',interpreted:'Miami, FL'},{original:'Orlando',interpreted:'Orlando, FL'}] },
  L04: { input: 'loaded in Portland at 7', events: [E('ON_DUTY','2026-09-21T11:00:00.000Z',null,'Portland','OR', fp('explicit','inferred','inferred','explicit','inferred'), ['state'])], locConf: [{original:'Portland',interpreted:'Portland, OR'}] },
  A08: { input: 'I loaded here at 8', events: [E('ON_DUTY','2026-09-21T12:00:00.000Z',null,'Unknown','Unknown', fp('explicit','inferred','inferred','inferred','inferred'), ['city','state'])], locConf: [] },
  C14: { input: 'Started in Dallas at 6 AM, did a 20 minute pretrip, drove to Houston, fueled for 15 minutes, then drove to San Antonio and shut down.', events: [
    E('ON_DUTY','2026-09-21T10:00:00.000Z','2026-09-21T10:20:00.000Z','Dallas','TX', fp('explicit','explicit','inferred','explicit','inferred')),
    E('DRIVING','2026-09-21T10:20:00.000Z','2026-09-21T14:00:00.000Z','Dallas','TX', fp('explicit','inferred','explicit','explicit','inferred'), ['end_time']),
    E('ON_DUTY','2026-09-21T14:00:00.000Z','2026-09-21T14:15:00.000Z','Houston','TX', fp('inferred','explicit','inferred','inferred','inferred')),
    E('DRIVING','2026-09-21T14:15:00.000Z','2026-09-21T17:30:00.000Z','Houston','TX', fp('explicit','inferred','explicit','inferred','inferred'), ['end_time']),
    E('OFF_DUTY','2026-09-21T17:30:00.000Z',null,'San Antonio','TX', fp('inferred','explicit','inferred','inferred','inferred'), ['start_time'])], locConf: [] },
};

it('probe', async () => {
  for (const [id, c] of Object.entries(cases)) {
    const { normalized } = validateInterpretResult({ intent: 'add_events', proposed_events: c.events, location_confirmations: c.locConf, original_input: c.input, deterministic_explicit_facts: { times: [], locations: [], statuses: [] } });
    const { events: selfN } = normalizeCandidateTimeline(normalized.proposed_events);
    const enriched = await enrichProposalMileage(selfN, { routingProvider: provider, speedProfile: 'conservative', now: NOW, narrative: c.input });
    const { events: rec } = reconstructDrivingDurations(enriched.events, enriched.legs, { now: NOW });
    const rw = await addRouteWarning(rec, { routingProvider: provider, speedProfile: 'conservative', now: NOW, isFuture: false });
    const v = validateProposal([], rec, { tz: TZ, now: NOW, isFuture: false, narrative: c.input, provenance: normalized, explicitGuard: normalized.explicit_guard, cycleType: '70_8' });
    console.log('PROBE', id, JSON.stringify({ legs: enriched.legs.map(l => ({ o: l.origin, d: l.destination, known: l.destinationKnown, ev: l.evaluation?.known, conflict: l.evaluation?.conflict })), mileage: rec.map(e => e.mileage ?? null), routeWarn: rw && { sev: rw.severity, ack: rw.requiresAcknowledgment }, warnings: v.warnings.map(w => `${w.severity}:${w.type}`), dm: v.warnings.filter(w=>w.type==='described_movement_missing').map(w=>w.message), recEv: rec.map(e=>[e.duty_status,e.city,e.start_timestamp.slice(11,16),(e.end_timestamp||'').slice(11,16)].join(' ')) }));
  }
});
