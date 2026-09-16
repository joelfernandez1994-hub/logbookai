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
//   "off duty all night in <City, State>"  → with an explicit time range: that exact range
//                                             without a range: ask for the start/end times
//                                             (never invent a 24h day)
//
// The produced proposed events carry `stationary: true` so the movement guard
// (narrativeMovements.describedMovementCoverage) emits zero movement warnings
// regardless of any provenance backstop content — a belt-and-suspenders
// guarantee that a stationary location is never treated as a destination.
// ============================================================================

import { dateKeyInTz, startOfDayInTz } from './hosEngine';
import { nextLocalMidnightInTz } from './timelineEngine';
import { US_STATE_TO_CODE } from './usStates';

const H = 3600000;

// Genuine-travel verbs — when ANY of these is present, this rule does NOT apply
// and the narrative goes through normal AI + movement validation. Mirrors the
// verbs the movement guard treats as a described driving movement.
const TRAVEL_RE = /\b(?:drove|driven|driving|drive|headed|head\s+to|left|leave|leaving|arrived|arrive|continued|manej\w*|conduc\w*|viaj\w*|sal[ií]\w*)\b/i;

const FULL_DAY_RE = /\b(?:off[\s-]?duty|sleeper(?:\s+berth)?|fuera\s+de\s+servicio|litera|dormitorio)\b\s+(?:all\s+day|todo\s+el\s+d[ií]a)\b\s+(?:in|en)\s+(.+)/i;
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
    const stateRaw = commaM[2].trim().split(/\s+/)[0];
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

function statusLabel(status) {
  return status === 'SLEEPER_BERTH' ? 'Sleeper Berth' : 'Off Duty';
}

function stationaryEvent(status, loc, date, startIso, endIso, remark) {
  return {
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
}

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

/**
 * Deterministically parse a full-day / all-night stationary status prompt.
 * Returns { matched: true, ...proposal } on a match, or { matched: false } when
 * the prompt is not a stationary full-day/night status (so the caller falls
 * through to the normal AI + validation path).
 */
export function parseStationaryDay(text, { now = new Date(), timezone = 'America/Chicago' } = {}) {
  const t = String(text || '').trim();
  if (!t) return { matched: false };
  // Never suppress genuine movement — a travel narrative goes through normal
  // AI + deterministic movement validation (still blocks a missing Driving leg).
  if (TRAVEL_RE.test(t)) return { matched: false };

  const nowDate = now instanceof Date ? now : new Date(now);
  const targetDate = dateKeyInTz(nowDate, timezone);

  // ---- "<status> all day in <City, State>" (EN + ES) ----
  const fullDay = t.match(FULL_DAY_RE);
  if (fullDay) {
    const status = statusFromCue(t);
    if (!status) return { matched: false };
    const loc = parseCityState(fullDay[1]);
    if (!loc) return { matched: false };
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