// ============================================================================
// LogbookAI — DETERMINISTIC STATIONARY FULL-DAY/NIGHT STATUS RULE (no AI).
// ----------------------------------------------------------------------------
// Recognizes full-day stationary duty-status prompts so a stationary location
// mention can NEVER be misread as a travel destination (the false
// DESCRIBED_DRIVING_MISSING the movement guard's provenance backstop produced
// for "off duty all day in Indianapolis Indiana" — where the LLM's state-name
// enrichment "Indianapolis Indiana" → "Indianapolis, IN" was compared as a raw
// city change). The stated location is a STATIONARY EVENT location, not a route
// destination.
//
// This is a SPECIFIC stationary rule — it does NOT weaken movement validation.
// Any genuine travel narrative ("drove to / headed to / left X for Y /
// driving from") is rejected here and falls through to the normal AI +
// deterministic movement guard, which still blocks when a described Driving
// leg is missing.
//
// Recognized (English + Spanish):
//   "<status> all day in <City, State>"    → OFF_DUTY/SLEEPER_BERTH 12AM→12AM, 24h, 0 mi
//   "<status> todo el día en <City, State>" → same
//   "log (the) entire day off duty"        → full day, location optional
//   "log entire day off duty in Miami, FL" → full day; the stated location is
//                                             preserved exactly (never substituted)
//   "off duty entire day"                  → same
//   "off duty all night in <City, State>"  → with an explicit time range: that exact range
//                                             without a range: ask for the start/end times
//                                             (never invent a 24h day)
//
// SELECTED LOG DATE: when the caller passes `selectedDate` (the log day the
// driver selected in Logs), the proposal targets THAT day — never silently
// today. Without it the rule targets today, as before.
//
// FULL-DAY COVERAGE (deterministic, when `existingEvents` is provided):
//   - Day already covered 12AM→12AM entirely by Off Duty/Sleeper → "Already
//     logged" (no proposed events, no duplicate).
//   - Day has conflicting/partial entries → intent 'replace_day' with the
//     affected entries listed for explicit driver confirmation (the replace-day
//     review card requires the labeled Replace Day & Apply). Ordinary
//     additions NEVER replace anything — only this explicitly requested
//     full-day operation may.
//
// TODAY CAP: a full-day request for TODAY records only completed time
// (midnight → now). Future hours are never saved as completed activity.
//
// The produced proposed events carry `stationary: true` so the movement guard
// (narrativeMovements.describedMovementCoverage) emits zero movement warnings
// regardless of any provenance backstop content — a belt-and-suspenders
// guarantee that a stationary location is never treated as a destination.
// ============================================================================

import { dateKeyInTz, startOfDayInTz } from './hosEngine';
import { nextLocalMidnightInTz } from './timelineEngine';
import { US_STATE_TO_CODE } from './usStates';
import { isAmbiguousCityName } from './ambiguousLocations';

const H = 3600000;

// Genuine-travel verbs — when ANY of these is present, this rule does NOT apply
// and the narrative goes through normal AI + movement validation. Mirrors the
// verbs the movement guard treats as a described driving movement.
//
// Exported as describesTravel() below so narrativeMovements.js's AI-provenance
// backstop can apply the SAME "did the driver's own words mention travel at
// all" gate — see that file for why it needs it too.
const TRAVEL_RE = /\b(?:drove|driven|driving|drive|headed|head\s+to|left|leave|leaving|arrived|arrive|continued|manej\w*|conduc\w*|viaj\w*|sal[ií]\w*)\b/i;

export function describesTravel(text) {
  return TRAVEL_RE.test(String(text || ''));
}

const FULL_DAY_RE = /\b(?:off[\s-]?duty|sleeper(?:\s+berth)?|fuera\s+de\s+servicio|litera|dormitorio)\b\s+(?:all\s+day|todo\s+el\s+d[ií]a)\b\s+(?:in|en)\s+(.+)/i;

// Bare full-day (location optional/absent): "log entire day off duty",
// "off duty entire day", "todo el día fuera de servicio", ...
const BARE_FULL_DAY_RE = new RegExp(
  '(?:\\b(?:log|record|registrar)\\s+)?\\b(?:the\\s+|my\\s+|el\\s+)?(?:entire|whole|full)\\s+day\\s+(?:as\\s+|como\\s+)?(?:off[\\s-]?duty|sleeper(?:\\s+berth)?|fuera\\s+de\\s+servicio|litera|dormitorio)\\b' +
  '|\\b(?:off[\\s-]?duty|sleeper(?:\\s+berth)?|fuera\\s+de\\s+servicio|litera|dormitorio)\\b\\s+(?:for\\s+|todo\\s+)?(?:the\\s+|el\\s+)?(?:entire|whole|full)\\s+day\\b' +
  '|todo\\s+el\\s+d[ií]a\\s+(?:fuera\\s+de\\s+servicio|en\\s+litera|en\\s+dormitorio)',
  'i'
);

const ALL_NIGHT_RE = /\b(?:off[\s-]?duty|fuera\s+de\s+servicio)\b\s+(?:all\s+night|toda\s+la\s+noche)\b\s+(?:in|en)\s+(.+)/i;

// Two clock times joined by a connector ("10 PM to 6 AM", "22:00 until 06:00").
const TIME_RANGE_RE = /(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?\s*(?:to|until|-|–|—|hasta)\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/i;

function normalizeJurisdiction(raw) {
  const s = String(raw || '').trim().toUpperCase();
  if (!s) return '';
  return US_STATE_TO_CODE[s] || s;
}

function isStateToken(tok) {
  if (!tok) return false;
  const up = tok.toUpperCase();
  if (US_STATE_TO_CODE[up]) return true;          // full state name ("Indiana")
  if (/^[A-Za-z]{2}$/.test(tok)) return true;     // 2-letter code ("IN")
  return false;
}

const CITY_RE = /^[A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,2}$/;

// Parse the leading "City, State" / "City State" from a location string, taking
// only the city + the first qualifying state token (so trailing words like a
// time range never pollute the state). Returns { city, state } or null.
function parseCityState(str) {
  const s = String(str || '').trim().replace(/[.;,]+$/, '');
  const commaM = s.match(/^([^,]+),\s*(.+)$/);
  if (commaM) {
    const city = commaM[1].trim();
    // Punctuation inside the state token (e.g. a merged "…Miami, FL, FL"
    // clarification reply) must not defeat the state match.
    const stateRaw = commaM[2].trim().split(/\s+/)[0].replace(/[^A-Za-z]/g, '');
    if (!CITY_RE.test(city)) return null;
    const code = normalizeJurisdiction(stateRaw);
    if (code.length !== 2 || !isStateToken(stateRaw)) return null;
    return { city, state: code };
  }
  // No comma: scan forward for the first qualifying state token; the city is
  // everything (capitalized place words) before it.
  const parts = s.split(/\s+/);
  for (let i = 1; i < parts.length; i++) {
    if (!isStateToken(parts[i])) continue;
    const city = parts.slice(0, i).join(' ').trim();
    if (!city || !CITY_RE.test(city)) continue;
    const code = normalizeJurisdiction(parts[i]);
    if (code.length !== 2) continue;
    return { city, state: code };
  }
  return null;
}

// ---------------------------------------------------------------------------
// LOCATION TAIL PARSING for full-day prompts. The driver's stated location is
// preserved EXACTLY — never substituted, never dropped:
//   { loc }        — "City, ST" / "City ST" parsed; use as-is
//   { needsState } — a city was stated but no state: an AMBIGUOUS city asks
//                    "which state?" deterministically (carrying the city);
//                    a unique city defers to the AI path (step-2 resolution)
//   { needsAi }    — unique city without a state: let the AI path resolve/ask
//   null           — not a recognizable location; caller decides (fall through)
// ---------------------------------------------------------------------------
export function parseLocationTail(tail) {
  const loc = parseCityState(tail);
  if (loc) return { loc };
  const bare = String(tail || '').trim().split(/[,.;]+/)[0].trim();
  if (bare && CITY_RE.test(bare)) {
    if (isAmbiguousCityName(bare)) return { needsState: true, city: bare };
    return { needsAi: true };
  }
  return null;
}

function whichStateClarification(city, targetDate, lang = 'en') {
  return {
    matched: true,
    intent: 'clarification',
    target_date: targetDate,
    interpretation: lang === 'es'
      ? `"${city}" existe en varios estados. ¿En qué estado estaba? (p. ej. ${city}, IL)`
      : `"${city}" exists in several states. Which state was it? (e.g. ${city}, IL)`,
    requires_clarification: true,
    clarification_question: lang === 'es'
      ? `¿En qué estado estaba "${city}"? (p. ej. ${city}, IL)`
      : `Which state was "${city}" in? (e.g. ${city}, IL)`,
    proposed_events: [],
    stationary: true,
    pending_location_city: city,
  };
}

// ---------------------------------------------------------------------------
// CLARIFICATION REPLY — is the driver's message a pure location answer
// ("IL", "Illinois", "in Miami, FL", "Springfield, IL")? Detection only.
// Returns { city, state } (city null for a state-only reply) or null.
// ---------------------------------------------------------------------------
export function parseLocationReply(reply) {
  const s = String(reply || '').trim().replace(/[.!]+$/, '');
  if (!s || s.length > 60) return null;
  const bareState = s.match(/^(?:in\s+|en\s+)?([A-Za-z]{2,14})$/i);
  if (bareState) {
    if (!isStateToken(bareState[1])) return null; // a plain word ("yes") is not a state
    return { city: null, state: normalizeJurisdiction(bareState[1]) };
  }
  const withCity = s.match(/^(?:in\s+|en\s+)?(.+)$/i);
  const loc = parseCityState(withCity?.[1] || '');
  if (loc) return { ...loc, replacedCity: true };
  return null;
}

// Merge a location reply back into the ORIGINAL request text so the stated
// city is preserved exactly: a state-only reply is appended after the
// original "in <City>" tail; a city+state reply replaces the tail outright.
export function mergeLocationReply(originalText, reply) {
  const orig = String(originalText || '').trim();
  if (reply?.city) return orig.replace(/\b(?:in|en)\s+[A-Z][^,]*$/i, `in ${reply.city}, ${reply.state}`);
  return `${orig}, ${reply.state}`;
}

function statusFromCue(text) {
  const t = String(text || '').toLowerCase();
  if (/\b(?:off[\s-]?duty|fuera\s+de\s+servicio)\b/.test(t)) return 'OFF_DUTY';
  if (/\b(?:sleeper|litera|dormitorio)\b/.test(t)) return 'SLEEPER_BERTH';
  return null;
}

function tzOffsetMs(date, timezone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = dtf.formatToParts(date);
  const map = {};
  parts.forEach(p => { if (p.type !== 'literal') map[p.type] = p.value; });
  let h = Number(map.hour);
  if (map.hour === '24') h = 0;
  const asIfUtc = Date.UTC(Number(map.year), Number(map.month) - 1, Number(map.day), h, Number(map.minute), Number(map.second));
  return asIfUtc - date.getTime();
}

function localTimeOnDateToIso(dateStr, hh, mm, timezone) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const wallUtc = Date.UTC(y, m - 1, d, hh, mm, 0);
  let instant = wallUtc;
  for (let i = 0; i < 2; i++) instant = wallUtc - tzOffsetMs(new Date(instant), timezone);
  return new Date(instant).toISOString();
}

function to24h(hour, minute, meridiem) {
  let h = Number(hour) % 12;
  const m = Number(minute || 0);
  const mer = String(meridiem || '').replace(/\./g, '').toLowerCase();
  if (mer && /^p/.test(mer)) h += 12;
  return [h, m];
}

function addDay(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

function fmtClockLocal(iso, timezone) {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: timezone });
}

function statusLabel(status, lang = 'en') {
  if (status === 'SLEEPER_BERTH') return lang === 'es' ? 'Sleeper' : 'Sleeper Berth';
  if (status === 'DRIVING') return lang === 'es' ? 'Manejo' : 'Driving';
  if (status === 'ON_DUTY') return lang === 'es' ? 'En servicio' : 'On Duty';
  return lang === 'es' ? 'Fuera de servicio' : 'Off Duty';
}

function stationaryEvent(status, loc, date, startIso, endIso, remark, reviewNotes = null) {
  const ev = {
    date,
    start_timestamp: startIso,
    end_timestamp: endIso,
    duty_status: status,
    city: loc.city,
    state: loc.state,
    activity_type: status === 'SLEEPER_BERTH' ? 'Sleeper' : 'Off Duty',
    remark,
    field_provenance: { start_time: 'explicit', end_time: 'explicit', status: 'explicit', city: 'explicit', state: 'explicit' },
    stationary: true,
  };
  if (reviewNotes?.length) ev.review_notes = reviewNotes;
  return ev;
}

// ---------------------------------------------------------------------------
// FULL-DAY COVERAGE ANALYSIS (deterministic) — classifies the day's EXISTING
// timeline so a full-day request never silently duplicates or overwrites:
//   empty    → nothing overlaps the day; a clean full-day addition is possible
//   fullyRest → the whole day is already Off Duty/Sleeper 12AM→12AM
//   conflict → at least one non-rest entry is recorded that day
//   partial  → only rest entries, but the day is not covered end to end
// ---------------------------------------------------------------------------
const REST_STATUSES = new Set(['OFF_DUTY', 'SLEEPER_BERTH']);

export function analyzeDayCoverage(existingEvents, dayStart, dayEnd, now = new Date()) {
  const nowMs = now.getTime();
  const segs = [];
  for (const e of (existingEvents || [])) {
    if (!e?.start_timestamp) continue;
    const s = new Date(e.start_timestamp);
    let end;
    if (e.end_timestamp) end = new Date(e.end_timestamp);
    else end = s.getTime() < nowMs ? new Date(nowMs) : s; // ongoing → through now
    if (s < dayEnd && end > dayStart) {
      segs.push({
        event: e,
        start: s < dayStart ? new Date(dayStart) : s,
        end: end > dayEnd ? new Date(dayEnd) : end,
      });
    }
  }
  if (!segs.length) return { kind: 'empty', segments: segs };
  const conflicts = segs.filter((s) => !REST_STATUSES.has(s.event.duty_status));
  if (conflicts.length) return { kind: 'conflict', segments: segs, conflicts };
  const sorted = [...segs].sort((a, b) => a.start - b.start);
  let cursor = new Date(dayStart).getTime();
  for (const s of sorted) {
    if (s.start.getTime() > cursor + 1000) return { kind: 'partial', segments: segs };
    if (s.end.getTime() > cursor) cursor = s.end.getTime();
  }
  if (cursor >= dayEnd.getTime() - 1000) return { kind: 'fullyRest', segments: segs };
  return { kind: 'partial', segments: segs };
}

// Does the EXISTING timeline's rest coverage already contain [startMs, endMs)?
export function restCoversRange(existingEvents, startMs, endMs, now = new Date()) {
  const nowMs = now.getTime();
  const ivs = [];
  for (const e of (existingEvents || [])) {
    if (!e?.start_timestamp || !REST_STATUSES.has(e.duty_status)) continue;
    const s = new Date(e.start_timestamp).getTime();
    const end = e.end_timestamp ? new Date(e.end_timestamp).getTime() : (s < nowMs ? nowMs : s);
    if (s < endMs && end > startMs) ivs.push([Math.max(s, startMs), Math.min(end, endMs)]);
  }
  ivs.sort((a, b) => a[0] - b[0]);
  let cursor = startMs;
  for (const [a, b] of ivs) {
    if (a > cursor + 1000) return false;
    if (b > cursor) cursor = b;
  }
  return cursor >= endMs - 1000;
}

// Existing full-day builder — kept exactly as before (intent 'replace_day',
// no coverage analysis) for callers that do not pass existingEvents.
function buildFullDayProposal(status, loc, targetDate, timezone) {
  const dayStart = startOfDayInTz(new Date(targetDate + 'T12:00:00Z'), timezone);
  const dayEnd = nextLocalMidnightInTz(targetDate, timezone);
  const totalHours = (dayEnd.getTime() - dayStart.getTime()) / H;
  const ev = stationaryEvent(status, loc, targetDate, dayStart.toISOString(), dayEnd.toISOString(), `${statusLabel(status)} all day`);
  return {
    matched: true,
    intent: 'replace_day',
    target_date: targetDate,
    interpretation: `This will log ${statusLabel(status)} all day in ${loc.city}, ${loc.state} — ${totalHours.toFixed(2)} hr, 0 miles, no driving.`,
    requires_clarification: false,
    clarification_question: '',
    proposed_events: [ev],
    stationary: true,
  };
}

// Unified full-day builder WITH coverage analysis (existingEvents provided).
function buildFullDay(status, loc, targetDate, timezone, { existingEvents, lang = 'en', now = new Date() }) {
  const dayStart = startOfDayInTz(new Date(targetDate + 'T12:00:00Z'), timezone);
  const dayEnd = nextLocalMidnightInTz(targetDate, timezone);
  const isToday = targetDate === dateKeyInTz(now, timezone);
  const where = loc.city ? (lang === 'es' ? ` en ${loc.city}, ${loc.state}` : ` in ${loc.city}, ${loc.state}`) : '';
  const label = statusLabel(status, lang);

  // TODAY CAP: a full-day request for today records only completed time.
  let endIso = dayEnd.toISOString();
  let cappedNote = null;
  if (isToday) {
    if (now.getTime() <= dayStart.getTime()) {
      return {
        matched: true, already_logged: false, intent: 'clarification', target_date: targetDate,
        interpretation: lang === 'es'
          ? 'El día apenas comienza; todavía no hay tiempo completado que registrar. Indica las horas exactas (p. ej. de 10 PM a 6 AM).'
          : 'Today has only just started, so there is no completed time to record yet. Tell me the exact times instead (e.g. 10 PM to 6 AM).',
        requires_clarification: true,
        clarification_question: lang === 'es'
          ? '¿A qué horas estuvo fuera de servicio hoy?'
          : 'What times were you off duty today?',
        proposed_events: [],
        stationary: true,
      };
    }
    endIso = new Date(now.getTime()).toISOString();
    cappedNote = lang === 'es'
      ? `Registrado hasta las ${fmtClockLocal(endIso, timezone)}; el resto del día aún no está registrado.`
      : `Recorded through ${fmtClockLocal(endIso, timezone)} — the rest of today is not yet logged as completed activity.`;
  }

  const coverage = analyzeDayCoverage(existingEvents, dayStart, dayEnd, now);

  if (coverage.kind === 'fullyRest') {
    return {
      matched: true, already_logged: true, intent: 'already_logged', target_date: targetDate,
      interpretation: lang === 'es'
        ? `Ya registrado: ${targetDate} ya está anotado como ${label} durante todo el día. No se creó ningún duplicado.`
        : `Already logged — ${targetDate} is already recorded as ${label} for the entire day. No duplicate was created.`,
      requires_clarification: false, clarification_question: '',
      proposed_events: [],
      stationary: true,
    };
  }

  if (coverage.kind === 'conflict' || coverage.kind === 'partial') {
    const affected = coverage.segments.map((s) =>
      `${statusLabel(s.event.duty_status, lang)} ${fmtClockLocal(s.start.toISOString(), timezone)}–${fmtClockLocal(s.end.toISOString(), timezone)}${s.event.city ? ` (${s.event.city})` : ''}`);
    const ev = stationaryEvent(status, loc, targetDate, dayStart.toISOString(), endIso, `${statusLabel(status)} all day`, cappedNote ? [{ title: 'PARTIAL DAY (TODAY)', message: cappedNote }] : null);
    return {
      matched: true, intent: 'replace_day', target_date: targetDate,
      interpretation: (lang === 'es'
        ? `Esto registrará ${label} durante todo el día${where}, reemplazando lo anotado ese día: ${affected.join('; ')}`
        : `This will log ${label} for the entire day${where}, replacing the entries currently recorded for that day: ${affected.join('; ')}`)
        + (cappedNote ? ` ${cappedNote}` : ''),
      requires_clarification: false, clarification_question: '',
      proposed_events: [ev],
      replaces_existing: affected,
      stationary: true,
    };
  }

  // Empty day → a clean full-day addition. Ordinary additions (time ranges,
  // single events) never reach this full-day replace logic; they keep the
  // existing entries and leave gaps untouched.
  const ev = stationaryEvent(status, loc, targetDate, dayStart.toISOString(), endIso, `${statusLabel(status)} all day`, cappedNote ? [{ title: 'PARTIAL DAY (TODAY)', message: cappedNote }] : null);
  return {
    matched: true, intent: 'add_events', target_date: targetDate,
    interpretation: (lang === 'es'
      ? `Esto registrará ${label} durante todo el día${where}`
      : `This will log ${label} for the entire day${where}`)
      + (isToday ? (lang === 'es'
          ? `, registrado hasta las ${fmtClockLocal(endIso, timezone)} — el resto del día no se guarda como actividad completada`
          : `, recorded through ${fmtClockLocal(endIso, timezone)} — the rest of today is not saved as completed activity`)
        : (lang === 'es' ? ' — 0 millas, sin manejo.' : ' — 0 miles, no driving.')),
    requires_clarification: false, clarification_question: '',
    proposed_events: [ev],
    stationary: true,
  };
}

/**
 * Deterministically parse a full-day / all-night stationary status prompt.
 * Options:
 *   selectedDate   — the log day selected in Logs (YYYY-MM-DD). The proposal
 *                    targets THIS day, never silently today. Omitted → today.
 *   existingEvents — the driver's logged events; enables "Already logged" and
 *                    conflict-preview behavior. Omitted → legacy behavior.
 *   lang           — 'en' | 'es' for interpretation strings.
 * Returns { matched: true, ...proposal } on a match, or { matched: false } when
 * the prompt is not a stationary full-day/night status (so the caller falls
 * through to the normal AI + validation path).
 */
export function parseStationaryDay(text, { now = new Date(), timezone = 'America/Chicago', selectedDate = null, existingEvents = null, lang = 'en' } = {}) {
  // Trailing punctuation ("...in Miami, FL.") must never break location capture.
  const t = String(text || '').trim().replace(/[.!?]+$/, '');
  if (!t) return { matched: false };
  // Never suppress genuine movement — a travel narrative goes through normal
  // AI + deterministic movement validation (still blocks a missing Driving leg).
  if (TRAVEL_RE.test(t)) return { matched: false };

  const nowDate = now instanceof Date ? now : new Date(now);
  const targetDate = selectedDate || dateKeyInTz(nowDate, timezone);

  // ---- "<status> all day in <City, State>" (EN + ES) ----
  const fullDay = t.match(FULL_DAY_RE);
  if (fullDay) {
    const status = statusFromCue(t);
    if (!status) return { matched: false };
    const parsedTail = parseLocationTail(fullDay[1]);
    // Stated city, state missing → ask which state; the city is kept and the
    // driver's reply is merged back (never substituted, no AI quota spent).
    if (parsedTail?.needsState) return { ...whichStateClarification(parsedTail.city, targetDate, lang), original_input: t };
    if (!parsedTail?.loc) return { matched: false };
    const loc = parsedTail.loc;
    if (existingEvents) return buildFullDay(status, loc, targetDate, timezone, { existingEvents, lang, now: nowDate });
    return buildFullDayProposal(status, loc, targetDate, timezone);
  }

  // ---- bare full-day, location optional: "log entire day off duty" ----
  if (BARE_FULL_DAY_RE.test(t)) {
    const status = statusFromCue(t);
    if (!status) return { matched: false };
    // A trailing "in <City, State>" ("log entire day off duty in Miami, FL")
    // is a STATED STATIONARY location — carried onto the proposed event
    // exactly as given; a stated city without a state asks, never guesses.
    let loc = { city: '', state: '' };
    const trail = t.match(/\b(?:in|en)\s+([A-Z][A-Za-z .,'-]*)$/);
    if (trail) {
      const parsedTail = parseLocationTail(trail[1]);
      if (parsedTail?.needsState) return { ...whichStateClarification(parsedTail.city, targetDate, lang), original_input: t };
      if (!parsedTail?.loc) return { matched: false };
      loc = parsedTail.loc;
    }
    if (existingEvents) return buildFullDay(status, loc, targetDate, timezone, { existingEvents, lang, now: nowDate });
    return buildFullDayProposal(status, loc, targetDate, timezone);
  }

  // ---- "off duty all night in <City, State> [from H to H]" ----
  const allNight = t.match(ALL_NIGHT_RE);
  if (allNight) {
    const loc = parseCityState(allNight[1]);
    if (!loc) return { matched: false };
    const tr = t.match(TIME_RANGE_RE);
    if (!tr) {
      // No explicit range — ask for the start/end times. Never invent a 24h day.
      return {
        matched: true,
        intent: 'clarification',
        target_date: targetDate,
        interpretation: `You described being Off Duty all night in ${loc.city}, ${loc.state} but didn't give the times. What time did the off-duty period start and end? (e.g. 10 PM to 6 AM)`,
        requires_clarification: true,
        clarification_question: `What time did your Off Duty period start and end? (e.g. 10 PM to 6 AM)`,
        proposed_events: [],
        stationary: true,
      };
    }
    const [sh, sm] = to24h(tr[1], tr[2], tr[3]);
    const [eh, em] = to24h(tr[4], tr[5], tr[6]);
    const startIso = localTimeOnDateToIso(targetDate, sh, sm, timezone);
    // If the end clock is not later than the start, the period crosses midnight.
    const endDateStr = (eh < sh || (eh === sh && em <= sm)) ? addDay(targetDate) : targetDate;
    const endIso = localTimeOnDateToIso(endDateStr, eh, em, timezone);
    const ev = stationaryEvent('OFF_DUTY', loc, targetDate, startIso, endIso, 'Off Duty all night');
    return {
      matched: true,
      intent: 'add_events',
      target_date: targetDate,
      interpretation: `This will log Off Duty from ${fmtClockLocal(startIso, timezone)} to ${fmtClockLocal(endIso, timezone)} in ${loc.city}, ${loc.state} — 0 miles, no driving.`,
      requires_clarification: false,
      clarification_question: '',
      proposed_events: [ev],
      stationary: true,
    };
  }

  return { matched: false };
}