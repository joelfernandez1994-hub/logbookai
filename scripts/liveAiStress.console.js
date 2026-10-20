/* ============================================================================
 * LogbookAI — LIVE AI STRESS RUN (standalone browser-console script)
 * ----------------------------------------------------------------------------
 * Works from an ALREADY LOGGED-IN LogbookAI tab. It does not import anything from
 * /src (the editor origin serves HTML for those paths). It calls the same backend
 * endpoints the running app's SDK client calls (/api/apps/<id>/functions/...),
 * with the session token the app already stored in localStorage. No API key, no
 * secret, no auth bypass.
 *
 * WHERE TO PASTE: the app runs inside the editor Preview as an IFRAME. In DevTools >
 * Console, switch the context dropdown (default "top") to that iframe, then paste.
 *
 * STEP 1 - SMOKE TEST (1 AI request). Before pasting:
 *     window.LIVE_AI = { testEmail: 'the-test-account@example.com' }
 *   The script verifies: not the editor page, app id, logged-in email === testEmail,
 *   role is not admin, carrier timezone === America/New_York. It then makes ONE real
 *   manualLogAssistant call ("Left Miami at 8 AM and got to Orlando at 9 AM"), prints the
 *   raw structured response, and checks it: prompt_version r4-2026-10-20-missing-start-time,
 *   DRIVING Miami FL -> destination_city/destination_state Orlando FL, 8 AM and 9 AM kept
 *   exactly, route lookup performed, impossible travel flagged. The full run stays locked
 *   unless the version, destination and times checks pass.
 * STEP 2 - full runs (only after the smoke test passed in this same page session):
 *     window.LIVE_AI = { testEmail: '...', run: 'phase1' }   // 71 prompts (everything except H01-H07)
 *     window.LIVE_AI = { testEmail: '...', run: 'phase2' }   // 7 correction/delete prompts
 *     window.LIVE_AI = { testEmail: '...', run: 'all' }      // all 78
 *     (also: only: ['A01','A10'], delayMs: 1500). Requires ai_allowance_override >= 100.
 *   Results: console tables + window.__liveAiResults (copied to the clipboard when possible).
 *
 * SAFETY: interpret mode with SYNTHETIC events in the request body - the function reads
 * context events from the body, never the database, and never writes duty-status events.
 * Side effects: the account's AI-usage counter and the function's own AIProposal audit row.
 * Route checks call the tripEstimate function (Nominatim/OSRM, no database writes).
 * There is NO save leg in this script.
 * ========================================================================== */
(async () => {
// ===================== SCORER (from src/lib/liveAiEvaluator.js) =====================
// ============================================================================
// LogbookAI — placeholder location text (pure).
// ----------------------------------------------------------------------------
// The AI's strict output schema makes `city`/`state` required strings, so when
// a location is genuinely unknown the live model sometimes writes a literal
// placeholder ("Unknown", "N/A") instead of the empty string the prompt asks
// for (seen live: "I loaded here at 8" -> city "Unknown", state "Unknown").
// A placeholder is NOT a place: left in, it would be logged as "Unknown,
// Unknown", treated as a usable route endpoint, and hide the missing-location
// state from the review. Every AI-supplied city/state goes through here.
// ============================================================================

const PLACEHOLDER = /^(?:unknown|unk|n\/?a|none|null|undefined|unspecified|not specified|not provided|tbd|tba|\?+|[-–—]+)$/i;

function isPlaceholderLocation(value) {
  const s = String(value == null ? '' : value).trim();
  if (!s) return false;
  // "Unknown, Unknown" / "N/A, N/A" written into a single field.
  return s.split(/\s*,\s*/).every((part) => PLACEHOLDER.test(part));
}

// '' for empty or placeholder text; otherwise the trimmed text unchanged.
function cleanLocationText(value) {
  const s = String(value == null ? '' : value).trim();
  return isPlaceholderLocation(s) ? '' : s;
}

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


function localHM(iso, tz) {
  if (!iso) return null;
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(iso));
  const h = parts.find((p) => p.type === 'hour').value.replace('24', '00');
  return `${h}:${parts.find((p) => p.type === 'minute').value}`;
}

const norm = (v) => String(v == null ? '' : v).trim().toLowerCase();
const stateNorm = (v) => String(v == null ? '' : v).trim().toUpperCase();
const minutes = (hm) => { const [h, m] = String(hm).split(':').map(Number); return h * 60 + m; };

const CATEGORY = {
  LOCATION: 'location', TIME: 'time', STATUS: 'status', ORDER: 'order', OVERLAP: 'timeline_overlap',
  GAP: 'timeline_gap', CLARIFY: 'clarification', CORRECTION: 'correction_delete', HOS: 'hos', ROUTE: 'route', SHAPE: 'shape',
};

function wantsClarification(res) {
  return !!(res && (res.requires_clarification || res.intent === 'clarification'
    || (Array.isArray(res.clarifications) && res.clarifications.length > 0)));
}

// Structural checks that apply to EVERY add/replace proposal.
function sequenceIssues(events, tz) {
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
function evaluateLive(spec, res, tz) {
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

  if (spec.notRefuse && res.refuses_fabrication) F(CATEGORY.SHAPE, 'refused / rewrote a factual statement it should have preserved');
  (spec.includeCities || []).forEach((c) => {
    // A city is preserved when it sits on an event (origin, or a stop) OR is the stated
    // destination of a DRIVING event (destination_city) — the arrival place of a drive has no
    // other event to live on unless the driver described one.
    if (!events.some((ev) => norm(ev.city) === norm(c) || (ev.duty_status === 'DRIVING' && norm(ev.destination_city) === norm(c)))) {
      F(CATEGORY.LOCATION, `city "${c}" was dropped (origin/destination not preserved)`);
    }
  });

  // Every event must run forward in time (a live midnight-crossing prompt once returned a 4 AM end
  // dated BEFORE its 10 PM start and the hour-of-day comparison below could not see it), and no
  // event may carry a placeholder such as "Unknown" as its location.
  events.forEach((ev, i) => {
    if (ev.end_timestamp && new Date(ev.end_timestamp) <= new Date(ev.start_timestamp)) {
      F(CATEGORY.TIME, `event #${i + 1} ends (${ev.end_timestamp}) at or before it starts (${ev.start_timestamp})`);
    }
    for (const k of ['city', 'state', 'destination_city', 'destination_state']) {
      if (isPlaceholderLocation(ev[k])) F(CATEGORY.LOCATION, `event #${i + 1} ${k} is the placeholder "${ev[k]}" (must be empty)`);
    }
  });

  (spec.eventsIfPresent && events.length === 0 ? [] : (spec.events || [])).forEach((exp, i) => {
    const ev = events[i];
    if (!ev) { F(CATEGORY.SHAPE, `missing event #${i + 1} (${exp.status || ''} ${exp.city || ''})`); return; }
    const tag = `event #${i + 1}`;
    if (exp.status && ev.duty_status !== exp.status) F(CATEGORY.STATUS, `${tag} status ${ev.duty_status} != ${exp.status}`);
    if (exp.statusAny && !exp.statusAny.includes(ev.duty_status)) F(CATEGORY.STATUS, `${tag} status ${ev.duty_status} not in ${exp.statusAny.join('|')}`);
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
function evaluateDownstream(spec, down) {
  const fails = [];
  if (spec.routeConflict === true && !down.routeConflict) fails.push({ cat: CATEGORY.ROUTE, msg: 'impossible travel time was NOT flagged by route validation' });
  if (spec.routeConflict === false && down.routeConflict) fails.push({ cat: CATEGORY.ROUTE, msg: 'plausible trip was falsely flagged as a route conflict' });
  if (spec.mileageWarn === true && !(down.warningTypes || []).includes('stated_mileage_mismatch')) fails.push({ cat: CATEGORY.ROUTE, msg: 'large stated-vs-route mileage discrepancy was NOT flagged' });
  if (spec.mileageWarn === false && (down.warningTypes || []).includes('stated_mileage_mismatch')) fails.push({ cat: CATEGORY.ROUTE, msg: 'small mileage difference was falsely flagged' });
  for (const v of spec.violations || []) {
    if (!(down.violations || []).includes(v)) fails.push({ cat: CATEGORY.HOS, msg: `expected HOS violation "${v}" was not reported` });
  }
  for (const w of spec.warnings || []) {
    if (!(down.warningTypes || []).includes(w)) fails.push({ cat: CATEGORY.SHAPE, msg: `expected validation warning "${w}" missing` });
  }
  return { pass: fails.length === 0, fails };
}

// ===================== PROMPT SET (from src/lib/liveAiPromptSet.js) =====================
// ============================================================================
// LogbookAI — LIVE-AI STRESS PROMPT SET (78 prompts) with structured
// expectations, scored by liveAiEvaluator.js. Run with
// scripts/liveAiStress.console.js in a logged-in app tab.
//
// Nothing here writes to any table: the harness calls manualLogAssistant in
// `interpret` mode with SYNTHETIC events in the request body (the function
// reads context events from the body, not the database), so no driver record
// is read or modified. Side effects are limited to the calling account's
// monthly AI-usage counter and the function's own AIProposal audit row.
//
// Expectations use local wall-clock "HH:MM" in the carrier timezone so they are
// date-independent. `mk('HH:MM')` (supplied by the harness) turns a local time
// on the run's "today" into the ISO timestamp the function expects.
// ============================================================================

const E = (status, city, state, start, end, extra = {}) => {
  const o = { status };
  if (city !== undefined) o.city = city;
  if (state !== undefined) o.state = state;
  if (start !== undefined) o.start = start;
  if (end !== undefined) o.end = end;
  return { ...o, ...extra };
};

// Synthetic timeline used by correction/delete prompts (indices are what the
// model must reference — same order the client sends).
const CORRECTION_FIXTURE = (mk) => ([
  { start_timestamp: mk('00:00'), end_timestamp: mk('06:00'), duty_status: 'OFF_DUTY', city: 'Miami', state: 'FL', remark: '' },          // 0
  { start_timestamp: mk('06:00'), end_timestamp: mk('07:00'), duty_status: 'ON_DUTY', city: 'Miami', state: 'FL', remark: 'Loading' },    // 1
  { start_timestamp: mk('07:00'), end_timestamp: mk('11:30'), duty_status: 'DRIVING', city: 'Miami', state: 'FL', remark: '' },           // 2
  { start_timestamp: mk('11:30'), end_timestamp: mk('12:00'), duty_status: 'ON_DUTY', city: 'Ocala', state: 'FL', remark: 'Fuel' },       // 3
  { start_timestamp: mk('12:00'), end_timestamp: mk('15:00'), duty_status: 'DRIVING', city: 'Ocala', state: 'FL', remark: '' },           // 4
  { start_timestamp: mk('15:00'), end_timestamp: mk('16:00'), duty_status: 'ON_DUTY', city: 'Orlando', state: 'FL', remark: 'Unloading' }, // 5
  { start_timestamp: mk('20:00'), end_timestamp: null, duty_status: 'SLEEPER_BERTH', city: 'Orlando', state: 'FL', remark: '', is_ongoing: true }, // 6
]);

// Prior verified rest so downstream HOS is calculable in HOS-violation prompts.
const RESET_FIXTURE = (mk) => ([
  { start_timestamp: mk('00:00', -1), end_timestamp: mk('05:00'), duty_status: 'OFF_DUTY', city: 'Miami', state: 'FL', remark: '' },
]);

const PROMPTS = [
  // ---- A. prompts that previously broke -----------------------------------
  { id: 'A01', cat: 'previously-broken', prompt: 'Left Miami at 8 AM and got to Orlando at 9 AM', includeCities: ['Miami', 'Orlando'], events: [E('DRIVING', 'Miami', 'FL', '08:00', '09:00', { startProv: 'explicit', endProv: 'explicit' })], routeConflict: true },
  { id: 'A02', cat: 'previously-broken', prompt: 'Left Miami around 8ish and got to Orlando about noon', includeCities: ['Miami', 'Orlando'], events: [E('DRIVING', 'Miami', 'FL', '08:00', '12:00', { tolMin: 30, startApprox: true })] },
  { id: 'A03', cat: 'previously-broken', prompt: 'Left LA at 6 and arrived in Las Vegas at 11', includeCities: ['Las Vegas'], events: [E('DRIVING', undefined, 'CA', '06:00', '11:00')], routeConflict: false },
  { id: 'A04', cat: 'previously-broken', prompt: 'Headed to Nashville', clarify: true },
  { id: 'A05', cat: 'previously-broken', prompt: 'Drove over to Hialeah', clarify: true },
  { id: 'A06', cat: 'previously-broken', prompt: 'Started driving from Miami', eventsIfPresent: true, events: [E('DRIVING', 'Miami', undefined, undefined, null, { startProv: 'inferred' })] },
  { id: 'A07', cat: 'previously-broken', prompt: 'Drove for about 3 hours', eventsIfPresent: true, events: [E('DRIVING', undefined, undefined, undefined, undefined, { startProv: 'inferred' })] },
  { id: 'A08', cat: 'here', prompt: 'I loaded here at 8', clarify: true, emptyLocation: true, eventsIfPresent: true, events: [E('ON_DUTY', '', '', '08:00')] },
  { id: 'A09', cat: 'previously-broken', prompt: 'I went to bed at 10 PM', eventsIfPresent: true, events: [{ statusAny: ['OFF_DUTY', 'SLEEPER_BERTH'], start: '22:00' }] },
  { id: 'A10', cat: 'ambiguous-city', prompt: 'I drove from Springfield to Columbia', clarify: true, stateEmpty: ['Springfield', 'Columbia'] },

  // ---- B. single events / trucking slang ----------------------------------
  { id: 'B01', cat: 'single', prompt: 'loaded from 7 to 8', count: 1, events: [E('ON_DUTY', undefined, undefined, '07:00', '08:00')] },
  { id: 'B02', cat: 'single', prompt: 'drove from 8 to 11', eventsIfPresent: true, events: [E('DRIVING', undefined, undefined, '08:00', '11:00')] },
  { id: 'B03', cat: 'single', prompt: 'unloaded for 45 minutes', eventsIfPresent: true, events: [{ status: 'ON_DUTY' }] },
  { id: 'B04', cat: 'single', prompt: 'took a 30 minute break', eventsIfPresent: true, events: [{ statusAny: ['OFF_DUTY', 'ON_DUTY', 'SLEEPER_BERTH'] }] },
  { id: 'B05', cat: 'single', prompt: 'went to sleeper at 9 PM', events: [E('SLEEPER_BERTH', undefined, undefined, '21:00')] },
  { id: 'B06', cat: 'single', prompt: 'fueled for 15 minutes', eventsIfPresent: true, events: [{ status: 'ON_DUTY' }] },
  { id: 'B07', cat: 'single', prompt: 'bumped the dock at 6', events: [E('ON_DUTY', undefined, undefined, '06:00')] },
  { id: 'B08', cat: 'single', prompt: 'scaled at 11:15', events: [E('ON_DUTY', undefined, undefined, '11:15')] },
  { id: 'B09', cat: 'single', prompt: 'shut down at 5 pm', events: [{ statusAny: ['OFF_DUTY', 'SLEEPER_BERTH'], start: '17:00' }] },
  { id: 'B10', cat: 'single', prompt: 'started my day at 6', events: [E('ON_DUTY', undefined, undefined, '06:00')] },
  { id: 'B11', cat: 'single', prompt: 'rolled out at 6:30', events: [E('DRIVING', undefined, undefined, '06:30')] },

  // ---- C. multi-event trips ----------------------------------------------
  { id: 'C01', cat: 'multi', prompt: 'loaded here and drove to Orlando', clarify: true, includeCities: ['Orlando'] },
  { id: 'C02', cat: 'multi', prompt: 'picked up in Miami then went to Jacksonville', includeCities: ['Miami', 'Jacksonville'], events: [E('ON_DUTY', 'Miami', 'FL')] },
  { id: 'C03', cat: 'multi', prompt: 'loaded in Homestead around 6 and drove to Tampa', includeCities: ['Homestead', 'Tampa'], events: [E('ON_DUTY', 'Homestead', undefined, '06:00', undefined, { tolMin: 30, startApprox: true })] },
  { id: 'C04', cat: 'multi', prompt: 'I left Atlanta at 7 this morning headed to Nashville', includeCities: ['Atlanta'], events: [E('DRIVING', 'Atlanta', 'GA', '07:00', undefined, { startProv: 'explicit' })] },
  { id: 'C05', cat: 'multi', prompt: 'got loaded in Dallas then drove to Houston', includeCities: ['Dallas', 'Houston'], events: [E('ON_DUTY', 'Dallas', 'TX')] },
  { id: 'C06', cat: 'multi', prompt: 'picked up in Phoenix and ran to Tucson', includeCities: ['Phoenix', 'Tucson'], events: [E('ON_DUTY', 'Phoenix', 'AZ')] },
  { id: 'C07', cat: 'multi', prompt: 'loaded in Chicago, drove to Indianapolis, took a 30 then kept going', includeCities: ['Chicago', 'Indianapolis'], count: { min: 4 }, events: [E('ON_DUTY', 'Chicago', 'IL'), E('DRIVING')] },
  { id: 'C08', cat: 'multi', prompt: 'I was off duty until 5 then loaded and left for Savannah', includeCities: ['Savannah'], events: [E('OFF_DUTY', undefined, undefined, undefined, '05:00'), E('ON_DUTY', undefined, undefined, '05:00'), E('DRIVING')] },
  { id: 'C09', cat: 'multi', prompt: 'started in Memphis, drove to Little Rock, unloaded, then went off duty', includeCities: ['Memphis', 'Little Rock'], count: { min: 3 } },
  { id: 'C10', cat: 'multi', prompt: 'I drove from Miami FL to Orlando FL', includeCities: ['Miami', 'Orlando'], events: [E('DRIVING', 'Miami', 'FL')] },
  { id: 'C11', cat: 'multi', prompt: 'I drove from Miami to Orlando', includeCities: ['Miami', 'Orlando'], events: [E('DRIVING', 'Miami', 'FL')] },
  { id: 'C12', cat: 'here', prompt: 'loaded here, drove there, unloaded, went to sleeper', clarify: true, emptyLocation: true },
  { id: 'C13', cat: 'multi-long', prompt: 'I was off duty until 5 AM in Homestead, went on duty for my pretrip, left at 5:30, drove to Orlando, stopped for 30 minutes, drove to Jacksonville, unloaded for an hour and then went sleeper.', count: { min: 7 }, includeCities: ['Homestead', 'Orlando', 'Jacksonville'], events: [E('OFF_DUTY', 'Homestead', undefined, undefined, '05:00'), E('ON_DUTY', 'Homestead', undefined, '05:00'), E('DRIVING', undefined, undefined, '05:30')] },
  { id: 'C14', cat: 'multi-long', prompt: 'Started in Dallas at 6 AM, did a 20 minute pretrip, drove to Houston, fueled for 15 minutes, then drove to San Antonio and shut down.', includeCities: ['Dallas', 'Houston', 'San Antonio'], count: { min: 5 }, events: [E('ON_DUTY', 'Dallas', 'TX', '06:00', '06:20'), E('DRIVING', undefined, undefined, '06:20')] },
  { id: 'C15', cat: 'multi-long', prompt: 'I loaded in Atlanta at 7, left at 8, drove to Chattanooga, stopped for lunch, then continued to Nashville and unloaded.', includeCities: ['Atlanta', 'Chattanooga', 'Nashville'], count: { min: 5 }, events: [E('ON_DUTY', 'Atlanta', 'GA', '07:00', '08:00'), E('DRIVING', undefined, undefined, '08:00')] },
  { id: 'C16', cat: 'multi-long', prompt: 'I loaded in Miami from 6 to 7, drove to Orlando, unloaded for an hour, then went sleeper.', includeCities: ['Miami', 'Orlando'], count: { min: 4 }, events: [E('ON_DUTY', 'Miami', 'FL', '06:00', '07:00'), E('DRIVING', undefined, undefined, '07:00'), E('ON_DUTY', 'Orlando', 'FL'), E('SLEEPER_BERTH')] },

  // ---- D. impossible route times (must be flagged downstream) -------------
  { id: 'D01', cat: 'impossible-route', prompt: 'I left Miami at 8 AM and arrived in Orlando at 9 AM', includeCities: ['Miami', 'Orlando'], routeConflict: true, events: [E('DRIVING', 'Miami', 'FL', '08:00', '09:00')] },
  { id: 'D02', cat: 'impossible-route', prompt: 'Left Dallas at 8 AM and got to Houston at 8:45 AM', includeCities: ['Dallas', 'Houston'], routeConflict: true, events: [E('DRIVING', 'Dallas', 'TX', '08:00', '08:45')] },
  { id: 'D03', cat: 'impossible-route', prompt: 'Left Atlanta at 8 AM and arrived in Nashville at 9 AM', includeCities: ['Atlanta', 'Nashville'], routeConflict: true, events: [E('DRIVING', 'Atlanta', 'GA', '08:00', '09:00')] },
  { id: 'D04', cat: 'impossible-route', prompt: 'Left Chicago at 8 AM and was in Indianapolis by 8:45 AM', includeCities: ['Chicago', 'Indianapolis'], routeConflict: true, events: [E('DRIVING', 'Chicago', 'IL', '08:00', '08:45')] },
  { id: 'D05', cat: 'impossible-route', prompt: 'Left Los Angeles at 8 AM and got to Las Vegas by 9:30 AM', includeCities: ['Los Angeles', 'Las Vegas'], routeConflict: true, events: [E('DRIVING', 'Los Angeles', 'CA', '08:00', '09:30')] },

  // ---- E. plausible routes (must NOT be flagged) --------------------------
  { id: 'E01', cat: 'plausible-route', prompt: 'Left Miami at 8 AM and arrived in Orlando at 1 PM', includeCities: ['Miami', 'Orlando'], routeConflict: false, events: [E('DRIVING', 'Miami', 'FL', '08:00', '13:00')] },
  { id: 'E02', cat: 'plausible-route', prompt: 'Left Dallas at 6 AM and got to Houston at 11 AM', includeCities: ['Dallas', 'Houston'], routeConflict: false, events: [E('DRIVING', 'Dallas', 'TX', '06:00', '11:00')] },
  { id: 'E03', cat: 'plausible-route', prompt: 'Left Phoenix at 9 AM and got to Tucson at 11:30 AM', includeCities: ['Phoenix', 'Tucson'], routeConflict: false, events: [E('DRIVING', 'Phoenix', 'AZ', '09:00', '11:30')] },

  // ---- F. driver-stated mileage ------------------------------------------
  { id: 'F01', cat: 'mileage', prompt: 'I drove 230 miles from Miami to Orlando, left at 8 AM and got there at 1 PM', includeCities: ['Orlando'], mileageWarn: false },
  { id: 'F02', cat: 'mileage', prompt: 'I drove 200 miles from Miami to Orlando, left at 8 AM and got there at 1 PM', includeCities: ['Orlando'], mileageWarn: false },
  { id: 'F03', cat: 'mileage', prompt: 'I drove 150 miles from Miami to Orlando, left at 8 AM and got there at 1 PM', includeCities: ['Orlando'], mileageWarn: true },
  { id: 'F04', cat: 'mileage', prompt: 'I drove 500 miles from Miami to Orlando, left at 8 AM and got there at 1 PM', includeCities: ['Orlando'], mileageWarn: true },

  // ---- G. overnight / crossing midnight -----------------------------------
  { id: 'G01', cat: 'midnight', prompt: 'I drove from Miami to Orlando from 10 PM to 4 AM', includeCities: ['Miami', 'Orlando'], events: [E('DRIVING', 'Miami', 'FL', '22:00', '04:00')] },
  { id: 'G02', cat: 'midnight', prompt: 'went sleeper at 11 PM and woke up at 7 AM', events: [E('SLEEPER_BERTH', undefined, undefined, '23:00', '07:00')] },
  { id: 'G03', cat: 'midnight', prompt: 'I was off duty from 8 PM until 6 AM in Tampa', events: [E('OFF_DUTY', 'Tampa', 'FL', '20:00', '06:00')] },
  { id: 'G04', cat: 'midnight', prompt: 'on duty at 11:30 PM loading until 12:30 AM', events: [E('ON_DUTY', undefined, undefined, '23:30', '00:30')] },

  // ---- H. corrections / deletes against existing events -------------------
  { id: 'H01', cat: 'correction', prompt: 'actually I left Miami at 8', fixture: 'correction', edit: { target: 2, start: '08:00' } },
  { id: 'H02', cat: 'correction', prompt: 'change that load time to 7:30', fixture: 'correction', clarify: 'either', edit: { target: 1 } },
  { id: 'H03', cat: 'correction', prompt: "I wasn't driving then, I was on duty", fixture: 'correction', clarify: true },
  { id: 'H04', cat: 'correction', prompt: "I wasn't driving between 7 and 11:30, I was on duty", fixture: 'correction', edit: { target: 2, status: 'ON_DUTY' } },
  { id: 'H05', cat: 'delete', prompt: 'delete that fuel stop', fixture: 'correction', del: { indices: [3] } },
  { id: 'H06', cat: 'correction', prompt: 'move my sleeper time to 10 PM', fixture: 'correction', edit: { target: 6, start: '22:00' } },
  { id: 'H07', cat: 'delete', prompt: 'delete the second driving segment', fixture: 'correction', del: { indices: [4] } },

  // ---- I. vague / bad input (must ask, not invent) ------------------------
  { id: 'I01', cat: 'vague', prompt: 'drove somewhere', clarify: true },
  { id: 'I02', cat: 'vague', prompt: 'loaded earlier', clarify: true },
  { id: 'I03', cat: 'vague', prompt: 'went there around lunch', clarify: true },
  { id: 'I04', cat: 'vague', prompt: 'I drove like 300 miles', clarify: true },
  { id: 'I05', cat: 'ambiguous-city', prompt: 'I loaded in Jacksonville', clarify: true, stateEmpty: ['Jacksonville'] },
  { id: 'I06', cat: 'vague', prompt: 'I got there at 8', clarify: true },

  // ---- J. HOS-violating proposals (facts preserved, violation reported) ---
  { id: 'J01', cat: 'hos', prompt: 'I drove from 6 AM to 5 PM with no breaks', fixture: 'reset', notRefuse: true, events: [E('DRIVING', undefined, undefined, '06:00', '17:00')], violations: ['11-Hour Driving Limit', '30-Minute Break'] },
  { id: 'J02', cat: 'hos', prompt: 'I drove from 6 AM to 8 PM and took a 30 minute break at noon', fixture: 'reset', notRefuse: true, violations: ['11-Hour Driving Limit'] },
  { id: 'J03', cat: 'hos', prompt: 'on duty at 5 AM then drove from 8 AM to 7 PM straight through', fixture: 'reset', notRefuse: true, violations: ['30-Minute Break'] },

  // ---- K. approximate / relative times ------------------------------------
  { id: 'K01', cat: 'time', prompt: 'loaded at 6:15', events: [E('ON_DUTY', undefined, undefined, '06:15', undefined, { startProv: 'explicit' })] },
  { id: 'K02', cat: 'time', prompt: 'left around 7', events: [E('DRIVING', undefined, undefined, '07:00', undefined, { tolMin: 30 })] },
  { id: 'K03', cat: 'time', prompt: 'got there around noon', clarify: true },
  { id: 'K04', cat: 'time', prompt: "I've been driving since 8", events: [E('DRIVING', undefined, undefined, '08:00', null)] },
  { id: 'K05', cat: 'time', prompt: 'I stopped 30 minutes ago', clarify: true },

  // ---- L. city/state resolution -------------------------------------------
  { id: 'L01', cat: 'location', prompt: 'loaded in Miami at 7', events: [E('ON_DUTY', 'Miami', 'FL', '07:00')] },
  { id: 'L02', cat: 'location', prompt: 'loaded in Miami FL at 7', events: [E('ON_DUTY', 'Miami', 'FL', '07:00')] },
  { id: 'L03', cat: 'location', prompt: 'loaded in Miami, Florida at 7', events: [E('ON_DUTY', 'Miami', 'FL', '07:00')] },
  { id: 'L04', cat: 'ambiguous-city', prompt: 'loaded in Portland at 7', clarify: true, stateEmpty: ['Portland'] },
];

function fixtureFor(spec, mk) {
  if (spec.fixture === 'correction') return CORRECTION_FIXTURE(mk);
  if (spec.fixture === 'reset') return RESET_FIXTURE(mk);
  return [];
}

// ===================== RUNNER (standalone; no /src imports) =====================
const EXPECTED_APP_ID = '6a861df91bc2d86b11ec06b1';
const REQUIRED_TZ = 'America/New_York';
const cfg = Object.assign({ testEmail: null, run: null, only: null, delayMs: 1500, apiBase: null }, window.LIVE_AI || {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const die = (m) => { throw new Error(`LIVE AI STRESS ABORTED: ${m}`); };
if (Array.isArray(cfg.save) && cfg.save.length) console.warn('The SAVE leg is not part of this script (Phases 1-2 only); LIVE_AI.save is ignored.');

// ---- 0. where am I? The app frame, not the Base44 editor page ----
if (/\/editor\//.test(location.pathname)) { // the editor page itself (the app runs in a separate preview frame)
  die('this looks like the Base44 EDITOR page (' + location.href + '), not the LogbookAI app frame. In DevTools switch the console context dropdown (default "top") to the preview iframe that renders the app, then paste again.');
}
const ls = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const appId = ls('base44_app_id') || new URLSearchParams(location.search).get('app_id');
if (appId !== EXPECTED_APP_ID) die(`app id in this frame is "${appId}", expected ${EXPECTED_APP_ID}. Wrong frame?`);
const token = ls('base44_access_token') || ls('token');
if (!token) die('no logged-in session found in this frame (no access token). Log in as the test account first.');
if (!cfg.testEmail) die('set window.LIVE_AI = { testEmail: "<the designated test account email>" } before pasting.');
const functionsVersion = ls('base44_functions_version');
const API = (cfg.apiBase || (location.origin + '/api')).replace(/\/$/, '');
const headers = Object.assign({ 'Content-Type': 'application/json', Accept: 'application/json', 'X-App-Id': appId, Authorization: `Bearer ${token}`, 'X-Origin-URL': location.href }, functionsVersion ? { 'Base44-Functions-Version': functionsVersion } : {});

// Same endpoints the running app's SDK client calls, with the same session token.
async function api(method, path, body) {
  const res = await fetch(`${API}/apps/${appId}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = { _nonJson: text.slice(0, 300) }; }
  return { status: res.status, ok: res.ok, data };
}

// ---- 1. identity + configuration checks (no AI quota used) ----
const meRes = await api('GET', '/entities/User/me');
if (!meRes.ok || !meRes.data || !meRes.data.email) die(`could not read the logged-in user (HTTP ${meRes.status}): ${JSON.stringify(meRes.data).slice(0, 200)}`);
const me = meRes.data;
if (me.email !== cfg.testEmail) die(`logged in as ${me.email}, but LIVE_AI.testEmail is ${cfg.testEmail}. Refusing to run on any other account.`);
if (me.role === 'admin') die('the logged-in account has role "admin". This run must use the dedicated non-admin test account.');
const carrierRes = await api('GET', '/entities/CarrierProfile?sort=-created_date&limit=1');
const carrier = carrierRes.ok && Array.isArray(carrierRes.data) ? carrierRes.data[0] : null;
const tz = carrier && carrier.home_terminal_timezone;
if (tz !== REQUIRED_TZ) die(`carrier timezone is "${tz}", expected ${REQUIRED_TZ}.`);
const cycle = carrier.hos_cycle || '70_8';
const allowance = me.ai_allowance_override;
const mode = cfg.run || 'smoke';
if (mode !== 'smoke' && !(Number(allowance) >= 100)) die(`ai_allowance_override is ${allowance}; it must be >= 100 for the full run.`);
console.log('%cLIVE AI STRESS — checks passed', 'font-weight:bold', { email: me.email, role: me.role, tz, cycle, ai_allowance_override: allowance, mode });

// ---- helpers: local wall time on "today" -> ISO ----
const offsetMs = (d) => {
  const p = {}; new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(d).forEach((x) => { if (x.type !== 'literal') p[x.type] = x.value; });
  return Date.UTC(+p.year, +p.month - 1, +p.day, p.hour === '24' ? 0 : +p.hour, +p.minute, +p.second) - d.getTime();
};
const todayLocal = new Date().toLocaleDateString('en-CA', { timeZone: tz });
const mk = (hm, dayOffset = 0) => {
  const [h, m] = hm.split(':').map(Number);
  const [y, mo, d] = todayLocal.split('-').map(Number);
  const wall = Date.UTC(y, mo - 1, d + dayOffset, h, m);
  let inst = wall; for (let i = 0; i < 2; i++) inst = wall - offsetMs(new Date(inst));
  return new Date(inst).toISOString();
};

// ---- the one real call: manualLogAssistant in interpret mode, SYNTHETIC events only ----
// A provider rate limit (HTTP 500 {"error":"Rate limit exceeded","unavailable":true}) is not a
// model result: back off and retry the SAME prompt (no usage is consumed by a failed call), so a
// burst of requests can't be scored as if the model had failed.
async function callModel(spec, fixture) {
  let r;
  for (let attempt = 0; attempt < 5; attempt++) {
    r = await api('POST', '/functions/manualLogAssistant', {
      mode: 'interpret', input: spec.prompt, source: 'typed', events: fixture, documents: [],
      currentLocation: '', tractor: '', trailer: '', hosSummary: '(synthetic stress-test context)',
    });
    const limited = !r.ok && r.status !== 429 && /rate limit/i.test(JSON.stringify(r.data || ''));
    if (!limited) break;
    const wait = 4000 * Math.pow(2, attempt);
    console.warn(`rate limited on ${spec.id}; retry ${attempt + 1}/4 in ${wait / 1000}s`);
    await sleep(wait);
  }
  return r;
}

// ---- route / mileage validation (mirrors src/lib/proposalValidation.js + statedMileage.js) ----
const routeCache = new Map();
async function routeFor(origin, destination) {
  const key = `${origin}||${destination}`;
  if (routeCache.has(key)) return routeCache.get(key);
  const r = await api('POST', '/functions/tripEstimate', { origin, destination });
  const v = r.ok && r.data && !r.data.error ? { miles: r.data.miles, hours: r.data.hours } : null;
  if (v) routeCache.set(key, v);
  return v;
}
const loc = (e) => ({ city: String((e && e.city) || '').trim(), state: String((e && e.state) || '').trim().toUpperCase() });
const fmtLoc = (l) => [l.city, l.state].filter(Boolean).join(', ');
async function routeLegs(events) {
  const sorted = events.filter((e) => e.start_timestamp).sort((a, b) => new Date(a.start_timestamp) - new Date(b.start_timestamp));
  const legs = [];
  for (let i = 0; i < sorted.length; i++) {
    const ev = sorted[i];
    if (ev.duty_status !== 'DRIVING') continue;
    let origin = null;
    for (let j = i - 1; j >= 0; j--) { if (sorted[j].duty_status === 'DRIVING') continue; if (String(sorted[j].city || '').trim()) { origin = loc(sorted[j]); break; } }
    if (!origin) origin = loc(ev);
    let destination = null;
    for (let j = i + 1; j < sorted.length; j++) { if (sorted[j].duty_status === 'DRIVING') continue; if (String(sorted[j].city || '').trim()) { destination = loc(sorted[j]); break; } }
    // mirrors getDrivingLegs: a following event wins, else the destination stated for this leg
    if (!destination && String(ev.destination_city || '').trim()) destination = loc({ city: ev.destination_city, state: ev.destination_state });
    const leg = { origin: fmtLoc(origin), destination: destination ? fmtLoc(destination) : '', ongoing: !ev.end_timestamp, evaluated: false };
    if (ev.end_timestamp && destination && leg.origin && leg.destination && leg.origin.toLowerCase() !== leg.destination.toLowerCase()) {
      const drivingHours = (new Date(ev.end_timestamp) - new Date(ev.start_timestamp)) / 3600000;
      const route = await routeFor(leg.origin, leg.destination);
      if (route) {
        const required = Math.max(route.hours, route.miles / 55); // conservative profile: 55 mph cap
        const tol = Math.max(5 / 60, 0.05 * required);
        Object.assign(leg, { evaluated: true, miles: Math.round(route.miles), drivingHours, requiredTruckHours: +required.toFixed(2), conflict: drivingHours < required - tol });
      } else leg.routeLookupFailed = true;
    }
    legs.push(leg);
  }
  return legs;
}
const MILES_RE = /(\d{1,3}(?:,\d{3})+|\d{1,4})(?:\.(\d+))?\s*(?:-\s*)?(?:statute\s+)?(?:miles?|mi)\b(?!\/)/gi;
function statedMiles(text) {
  const out = [];
  for (const m of String(text || '').matchAll(MILES_RE)) {
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 14).toLowerCase();
    if (/^\s*(?:per\s+hour|an\s+hour|\/\s*h)/.test(after)) continue;
    const whole = m[1].replace(/,/g, ''); const v = Number(m[2] ? `${whole}.${m[2]}` : whole);
    if (Number.isFinite(v) && v > 0) out.push(v);
  }
  return out;
}
function mileageWarnings(legs, prompt) {
  const stated = statedMiles(prompt); const ev = legs.filter((l) => l.evaluated);
  if (!stated.length || stated.length !== ev.length) return [];
  return ev.flatMap((l, i) => {
    const tol = Math.max(25, 0.2 * l.miles);
    return Math.abs(stated[i] - l.miles) > tol ? [{ type: 'stated_mileage_mismatch', statedMiles: stated[i], routeMiles: l.miles }] : [];
  });
}

// ---- 2. SMOKE TEST: one real call, print the structured response, verify the r3 schema/prompt is LIVE ----
const EXPECTED_PROMPT_VERSION = 'r4-2026-10-20-missing-start-time';
const SMOKE = {
  id: 'S00', cat: 'smoke', prompt: 'Left Miami at 8 AM and got to Orlando at 9 AM',
  includeCities: ['Miami', 'Orlando'], routeConflict: true,
  events: [{ status: 'DRIVING', city: 'Miami', state: 'FL', start: '08:00', end: '09:00' }],
};
if (mode === 'smoke') {
  console.log('SMOKE TEST: one real manualLogAssistant call (1 AI request), prompt: "' + SMOKE.prompt + '"');
  const r = await callModel(SMOKE, []);
  console.log('HTTP', r.status);
  const d = r.data;
  console.log('PROMPT VERSION served: ' + ((d && d.prompt_version) || 'NONE (function not redeployed with the r3 prompt)'));
  console.log('RAW STRUCTURED RESPONSE:\n' + JSON.stringify(d, null, 2));
  const structured = !!(r.ok && d && !d.error && typeof d.intent === 'string' && Array.isArray(d.proposed_events));
  const scored = structured ? evaluateLive(SMOKE, d, tz) : { pass: false, fails: [{ cat: 'shape', msg: `call failed or unstructured (HTTP ${r.status}): ${JSON.stringify(d).slice(0, 300)}` }] };
  const ev0 = (structured && d.proposed_events[0]) || {};
  const same = (a, b) => a && b && new Date(a).getTime() === new Date(b).getTime();
  let legs = [];
  if (structured && d.proposed_events.length) { try { legs = await routeLegs(d.proposed_events); } catch (e) { legs = []; } }
  const checks = {
    prompt_version: d && d.prompt_version === EXPECTED_PROMPT_VERSION ? 'PASS' : `FAIL (${(d && d.prompt_version) || 'missing'})`,
    'one DRIVING event': structured && d.proposed_events.length === 1 && ev0.duty_status === 'DRIVING' ? 'PASS' : 'FAIL',
    'origin Miami, FL': ev0.city === 'Miami' && String(ev0.state).toUpperCase() === 'FL' ? 'PASS' : `FAIL (${ev0.city}, ${ev0.state})`,
    destination_city: ev0.destination_city === 'Orlando' ? 'PASS' : `FAIL (${JSON.stringify(ev0.destination_city)})`,
    destination_state: String(ev0.destination_state || '').toUpperCase() === 'FL' ? 'PASS' : `FAIL (${JSON.stringify(ev0.destination_state)})`,
    'start 8 AM exactly': same(ev0.start_timestamp, mk('08:00')) ? 'PASS' : `FAIL (${ev0.start_timestamp})`,
    'end 9 AM exactly (times not silently corrected)': same(ev0.end_timestamp, mk('09:00')) ? 'PASS' : `FAIL (${ev0.end_timestamp})`,
    'route lookup performed': legs.some((l) => l.evaluated) ? 'PASS' : `FAIL (${JSON.stringify(legs)})`,
    'impossible travel flagged (route check; the app validator is replayed offline)': legs.some((l) => l.conflict) ? 'PASS' : 'FAIL',
  };
  console.table(checks);
  const gate = ['prompt_version', 'one DRIVING event', 'origin Miami, FL', 'destination_city', 'destination_state', 'start 8 AM exactly', 'end 9 AM exactly (times not silently corrected)'].every((k) => checks[k] === 'PASS');
  window.__liveAiSmoke = { ok: structured && gate, http: r.status, response: d, scored, checks, legs };
  window.__liveAiSmokeOk = structured && gate;
  if (structured && gate) {
    console.log(`%cSMOKE TEST PASSED — the r3 prompt/schema is live and the real model preserved origin, destination and both times. Usage: ${d.used}/${d.allowance}. Route check: ${checks['impossible travel flagged (route check; the app validator is replayed offline)']}.`, 'font-weight:bold;color:green');
    console.log('Next: rerun ONLY the previously failed IDs:  window.LIVE_AI = { testEmail: "' + cfg.testEmail + '", run: "phase1", only: [...] }  and paste this script again.');
  } else {
    console.error('SMOKE TEST DID NOT PASS — the full run stays locked. See the checks table above.');
  }
  return window.__liveAiSmoke;
}

// ---- 3. full runs (require a passed smoke test in THIS page session) ----
if (window.__liveAiSmokeOk !== true) die('run the smoke test first (paste with no LIVE_AI.run) and make sure it passes.');
let list = PROMPTS;
if (mode === 'phase1') list = PROMPTS.filter((s) => !/^H/.test(s.id));
else if (mode === 'phase2') list = PROMPTS.filter((s) => /^H/.test(s.id));
else if (mode !== 'all') die(`unknown LIVE_AI.run "${mode}" (use smoke | phase1 | phase2 | all)`);
if (Array.isArray(cfg.only)) list = list.filter((s) => cfg.only.includes(s.id));
console.log(`LIVE AI STRESS: ${list.length} prompts as ${me.email} (tz ${tz}, today ${todayLocal})`);

const rows = []; const raw = {};
for (const spec of list) {
  const fixture = fixtureFor(spec, mk);
  const r = await callModel(spec, fixture);
  const data = r.data;
  if (r.status === 429 || (data && data.limit)) { console.warn('AI quota reached — stopping.'); rows.push({ id: spec.id, cat: spec.cat, prompt: spec.prompt, pass: false, fails: ['[shape] QUOTA'], down: {} }); break; }
  const live = r.ok ? evaluateLive(spec, data, tz) : { pass: false, fails: [{ cat: 'shape', msg: `call failed (HTTP ${r.status}): ${JSON.stringify(data).slice(0, 200)}` }], clarified: false };

  let down = { routeConflict: false, warningTypes: [], legs: [] };
  let downRes = { pass: true, fails: [] };
  try {
    const evs = (data && data.proposed_events) || [];
    if (evs.length && ['add_events', 'replace_day'].includes(data.intent)) {
      const legs = await routeLegs(evs);
      down = { routeConflict: legs.some((l) => l.conflict), warningTypes: mileageWarnings(legs, spec.prompt).map((w) => w.type), legs };
    }
    // HOS/timeline/ambiguity/movement validators need the app's engine; they are replayed OFFLINE from
    // window.__liveAiResults.raw (exact response + fixture + now). Route + mileage are scored here.
    const { violations, ...inScriptSpec } = spec;
    downRes = evaluateDownstream(inScriptSpec, down);
  } catch (e) { downRes = { pass: false, fails: [{ cat: 'shape', msg: `downstream error: ${e.message}` }] }; }

  const fails = [...live.fails, ...downRes.fails];
  rows.push({ id: spec.id, cat: spec.cat, prompt: spec.prompt, pass: fails.length === 0, asked: live.clarified, expectedAsk: spec.clarify === true, fails: fails.map((f) => `[${f.cat}] ${f.msg}`), down, hosDeferred: spec.violations || null });
  raw[spec.id] = { input: spec.prompt, http: r.status, promptVersion: (data && data.prompt_version) || null, response: data, fixture, replay: { nowIso: new Date().toISOString(), tz, cycle } };
  console.log(`${fails.length ? 'FAIL' : 'PASS'}  ${spec.id}  ${spec.prompt}${fails.length ? '\n      ' + fails.map((f) => f.msg).join('\n      ') : ''}`);
  await sleep(cfg.delayMs);
}

// ---- 4. totals ----
const by = (f) => rows.filter(f).length;
const catFails = (c) => rows.reduce((n, r) => n + (r.fails || []).filter((x) => x.startsWith(`[${c}]`)).length, 0);
const totals = {
  attempted: list.length, completed: rows.length, passed: by((r) => r.pass), failed: by((r) => !r.pass),
  clarificationCorrectlyRequested: by((r) => r.expectedAsk && r.asked && r.pass),
  ambiguousLocationsCaught: by((r) => r.cat === 'ambiguous-city' && r.pass),
  impossibleTravelWarnings: by((r) => r.cat === 'impossible-route' && r.pass),
  incorrectLocationResolutions: catFails('location'), incorrectTimeInterpretations: catFails('time'),
  timelineOverlaps: catFails('timeline_overlap'), timelineGaps: catFails('timeline_gap'),
  correctionDeleteFailures: catFails('correction_delete'), routeValidationFailures: catFails('route'),
  // impossibleTravelWarnings counts D-category prompts that PASSED (i.e. destination preserved AND the
  // route check flagged the impossible leg); impossibleTravelFlagged counts those where the route check flagged.
  impossibleTravelFlagged: by((r) => r.cat === 'impossible-route' && r.down && r.down.routeConflict),
  promptVersions: [...new Set(Object.values(raw).map((x) => x.promptVersion || 'NONE'))].join(','),
  hosValidation: 'replayed offline from window.__liveAiResults.raw', saveLeg: 'not run',
};
console.table(rows.map((r) => ({ id: r.id, cat: r.cat, result: r.pass ? 'PASS' : 'FAIL', issues: (r.fails || []).join(' | ') })));
console.table(totals);
window.__liveAiResults = { meta: { email: me.email, tz, cycle, mode, ranAt: new Date().toISOString() }, totals, rows, raw };
try { if (typeof copy === 'function') copy(JSON.stringify(window.__liveAiResults)); } catch (e) { /* clipboard optional */ }
return totals;})();
