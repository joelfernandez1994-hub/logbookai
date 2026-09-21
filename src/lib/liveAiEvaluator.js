// ============================================================================
// LogbookAI — LIVE-AI RESPONSE EVALUATOR (pure, no DOM/network).
// ----------------------------------------------------------------------------
// Scores the STRUCTURED proposal that manualLogAssistant returns for a driver
// prompt against explicit expectations — never against how reasonable the
// summary text sounds. Used by scripts/liveAiStress.console.js (run inside a
// logged-in app tab against the real function) and unit-tested here with canned
// good/bad responses so the scorer itself is trustworthy.
//
// Response shape = mapInterpret() in base44/functions/manualLogAssistant:
//   { intent, requires_clarification, clarification_question, clarifications,
//     proposed_events:[{start_timestamp(UTC ISO), end_timestamp|null,
//       duty_status, city, state, field_provenance, ambiguous_fields,
//       edit_target_index}], delete_target_indices, location_confirmations }
// ============================================================================

export function localHM(iso, tz) {
  if (!iso) return null;
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(iso));
  const h = parts.find((p) => p.type === 'hour').value.replace('24', '00');
  return `${h}:${parts.find((p) => p.type === 'minute').value}`;
}

const norm = (v) => String(v == null ? '' : v).trim().toLowerCase();
const stateNorm = (v) => String(v == null ? '' : v).trim().toUpperCase();
const minutes = (hm) => { const [h, m] = String(hm).split(':').map(Number); return h * 60 + m; };

export const CATEGORY = {
  LOCATION: 'location', TIME: 'time', STATUS: 'status', ORDER: 'order', OVERLAP: 'timeline_overlap',
  GAP: 'timeline_gap', CLARIFY: 'clarification', CORRECTION: 'correction_delete', HOS: 'hos', ROUTE: 'route', SHAPE: 'shape',
};

export function wantsClarification(res) {
  return !!(res && (res.requires_clarification || res.intent === 'clarification'
    || (Array.isArray(res.clarifications) && res.clarifications.length > 0)));
}

// Structural checks that apply to EVERY add/replace proposal.
export function sequenceIssues(events, tz) {
  const out = [];
  const sorted = [...events].sort((a, b) => new Date(a.start_timestamp) - new Date(b.start_timestamp));
  if (sorted.some((e, i) => e !== events[i])) out.push({ cat: CATEGORY.ORDER, msg: 'events are not in chronological order' });
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1], cur = sorted[i];
    if (!prev.end_timestamp) continue; // open-ended continues until the next status change
    const gapMs = new Date(cur.start_timestamp) - new Date(prev.end_timestamp);
    if (gapMs < -60000) out.push({ cat: CATEGORY.OVERLAP, msg: `overlap: ${localHM(prev.end_timestamp, tz)} end vs ${localHM(cur.start_timestamp, tz)} start` });
    if (gapMs > 60000) out.push({ cat: CATEGORY.GAP, msg: `unexplained gap ${localHM(prev.end_timestamp, tz)} -> ${localHM(cur.start_timestamp, tz)}` });
  }
  return out;
}

// spec: {
//   intents?: string[]            allowed intents
//   clarify?: true|false|'either' must the model ask? (default 'either')
//   count?: n | {min,max}         number of proposed events
//   events?: [{status, city, state, start:'HH:MM', end:'HH:MM'|null, startProv, endProv, cityProv, startApprox}]
//   emptyLocation?: true          no event may carry a city/state (unknown "here")
//   stateEmpty?: [city,...]       these cities must NOT carry an invented state
//   forbidCities?: [..]           cities that must not appear anywhere
//   edit?: {target: n, status?, start?, end?}   correction of existing event index n
//   del?: {indices:[n,..]}        delete request
//   noEvents?: true               proposal must carry no events (pure question/clarification)
//   skipSequence?: true
// }
export function evaluateLive(spec, res, tz) {
  const fails = [];
  const F = (cat, msg) => fails.push({ cat, msg });
  if (!res || typeof res !== 'object') return { pass: false, fails: [{ cat: CATEGORY.SHAPE, msg: 'no structured response' }], clarified: false };
  if (res.error) return { pass: false, fails: [{ cat: CATEGORY.SHAPE, msg: `function error: ${res.error}` }], clarified: false };

  const events = Array.isArray(res.proposed_events) ? res.proposed_events : [];
  const asked = wantsClarification(res);

  if (spec.intents && !spec.intents.includes(res.intent)) F(CATEGORY.SHAPE, `intent "${res.intent}" not in ${spec.intents.join('|')}`);
  if (spec.clarify === true && !asked) F(CATEGORY.CLARIFY, 'should have asked a clarifying question but proposed without asking');
  if (spec.clarify === false && asked) F(CATEGORY.CLARIFY, `asked for clarification unnecessarily: "${res.clarification_question || ''}"`);
  if (spec.noEvents && events.length) F(CATEGORY.SHAPE, `expected no proposed events, got ${events.length}`);

  if (spec.count != null) {
    const { min, max } = typeof spec.count === 'number' ? { min: spec.count, max: spec.count } : spec.count;
    if (events.length < min || events.length > (max ?? Infinity)) F(CATEGORY.SHAPE, `expected ${min}-${max ?? '+'} events, got ${events.length}`);
  }

  (spec.events || []).forEach((exp, i) => {
    const ev = events[i];
    if (!ev) { F(CATEGORY.SHAPE, `missing event #${i + 1} (${exp.status || ''} ${exp.city || ''})`); return; }
    const tag = `event #${i + 1}`;
    if (exp.status && ev.duty_status !== exp.status) F(CATEGORY.STATUS, `${tag} status ${ev.duty_status} != ${exp.status}`);
    if (exp.city != null && norm(ev.city) !== norm(exp.city)) F(CATEGORY.LOCATION, `${tag} city "${ev.city}" != "${exp.city}"`);
    if (exp.state != null && stateNorm(ev.state) !== stateNorm(exp.state)) F(CATEGORY.LOCATION, `${tag} state "${ev.state}" != "${exp.state}"`);
    if (exp.start) {
      const got = localHM(ev.start_timestamp, tz);
      const tol = exp.tolMin ?? 0;
      if (got == null || Math.abs(minutes(got) - minutes(exp.start)) > tol) F(CATEGORY.TIME, `${tag} start ${got} != ${exp.start}`);
    }
    if (exp.end !== undefined) {
      if (exp.end === null) { if (ev.end_timestamp) F(CATEGORY.TIME, `${tag} should be open-ended, got end ${localHM(ev.end_timestamp, tz)}`); }
      else {
        const got = localHM(ev.end_timestamp, tz);
        const tol = exp.tolMin ?? 0;
        if (got == null || Math.abs(minutes(got) - minutes(exp.end)) > tol) F(CATEGORY.TIME, `${tag} end ${got} != ${exp.end}`);
      }
    }
    const fp = ev.field_provenance || {};
    if (exp.startProv && fp.start_time !== exp.startProv) F(CATEGORY.TIME, `${tag} start_time provenance "${fp.start_time}" != "${exp.startProv}"`);
    if (exp.endProv && fp.end_time !== exp.endProv) F(CATEGORY.TIME, `${tag} end_time provenance "${fp.end_time}" != "${exp.endProv}"`);
    if (exp.cityProv && fp.city !== exp.cityProv) F(CATEGORY.LOCATION, `${tag} city provenance "${fp.city}" != "${exp.cityProv}"`);
    if (exp.startApprox) {
      const flagged = fp.start_time === 'inferred' || (ev.ambiguous_fields || []).some((f) => /start/.test(f));
      if (!flagged) F(CATEGORY.TIME, `${tag} approximate start was not marked inferred/ambiguous (manufactured precision)`);
    }
  });

  if (spec.emptyLocation) {
    events.forEach((ev, i) => { if (ev.city || ev.state) F(CATEGORY.LOCATION, `event #${i + 1} invented a location "${ev.city}, ${ev.state}"`); });
  }
  (spec.stateEmpty || []).forEach((c) => {
    events.filter((ev) => norm(ev.city) === norm(c)).forEach((ev) => {
      if (ev.state && !asked) F(CATEGORY.LOCATION, `chose state "${ev.state}" for ambiguous "${c}" without asking`);
    });
  });
  (spec.forbidCities || []).forEach((c) => {
    if (events.some((ev) => norm(ev.city) === norm(c))) F(CATEGORY.LOCATION, `city "${c}" must not appear`);
  });

  if (spec.edit) {
    if (res.intent !== 'edit_events') F(CATEGORY.CORRECTION, `intent "${res.intent}" != edit_events`);
    const targeted = events.filter((e) => e.edit_target_index != null);
    if (targeted.length !== 1) F(CATEGORY.CORRECTION, `expected exactly one targeted edit, got ${targeted.length}`);
    else {
      const ev = targeted[0];
      if (ev.edit_target_index !== spec.edit.target) F(CATEGORY.CORRECTION, `edited event index ${ev.edit_target_index} != ${spec.edit.target} (wrong event)`);
      if (spec.edit.status && ev.duty_status !== spec.edit.status) F(CATEGORY.CORRECTION, `edited status ${ev.duty_status} != ${spec.edit.status}`);
      if (spec.edit.start && localHM(ev.start_timestamp, tz) !== spec.edit.start) F(CATEGORY.CORRECTION, `edited start ${localHM(ev.start_timestamp, tz)} != ${spec.edit.start}`);
      if (spec.edit.end && localHM(ev.end_timestamp, tz) !== spec.edit.end) F(CATEGORY.CORRECTION, `edited end ${localHM(ev.end_timestamp, tz)} != ${spec.edit.end}`);
    }
    if (events.length !== 1) F(CATEGORY.CORRECTION, `an edit must return exactly the one corrected event (got ${events.length}) — extra events would duplicate`);
  }
  if (spec.del) {
    if (res.intent !== 'delete_events') F(CATEGORY.CORRECTION, `intent "${res.intent}" != delete_events`);
    const got = [...(res.delete_target_indices || [])].sort();
    const want = [...spec.del.indices].sort();
    if (JSON.stringify(got) !== JSON.stringify(want)) F(CATEGORY.CORRECTION, `delete indices ${JSON.stringify(got)} != ${JSON.stringify(want)}`);
    if (events.length) F(CATEGORY.CORRECTION, 'a delete must not also propose events');
  }

  if (!spec.skipSequence && !spec.edit && !spec.del && events.length > 1) {
    for (const i of sequenceIssues(events, tz)) F(i.cat, i.msg);
  }
  return { pass: fails.length === 0, fails, clarified: asked };
}

// Downstream (client-side) checks after route/HOS validation ran on the
// proposal. `down` = { routeConflict:boolean, warningTypes:string[], violations:string[], blocking:boolean }
export function evaluateDownstream(spec, down) {
  const fails = [];
  if (spec.routeConflict === true && !down.routeConflict) fails.push({ cat: CATEGORY.ROUTE, msg: 'impossible travel time was NOT flagged by route validation' });
  if (spec.routeConflict === false && down.routeConflict) fails.push({ cat: CATEGORY.ROUTE, msg: 'plausible trip was falsely flagged as a route conflict' });
  for (const v of spec.violations || []) {
    if (!(down.violations || []).includes(v)) fails.push({ cat: CATEGORY.HOS, msg: `expected HOS violation "${v}" was not reported` });
  }
  for (const w of spec.warnings || []) {
    if (!(down.warningTypes || []).includes(w)) fails.push({ cat: CATEGORY.SHAPE, msg: `expected validation warning "${w}" missing` });
  }
  return { pass: fails.length === 0, fails };
}
