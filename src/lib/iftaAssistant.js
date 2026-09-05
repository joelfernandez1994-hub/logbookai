// ============================================================================
// LogbookAI — IFTA AI assistant: deterministic natural-language command
// parser. Pure, no base44/network/DOM imports — fully unit-testable and
// intentionally self-contained rather than routed through the duty-status AI
// pipeline (manualLogAssistant/aiLayer/ProposalReview), so an IFTA command can
// never touch DutyStatusEvent or the timeline, and a bug here can never
// affect duty-status logging or HOS.
//
// This module only INTERPRETS text into a proposal or a clarification
// question. It never writes anything itself — the caller (Ifta.jsx) always
// shows the result for the driver to review, and only calls the actual write
// (setDriverMileage / recomputeDayForQuarter / FuelReceipt.create) when the
// driver explicitly taps Apply. Nothing here silently overwrites a
// driver_entered/driver_confirmed mileage row — the proposal for a mileage
// correction always names the existing value being replaced so the driver
// sees exactly what will change before applying.
// ============================================================================
import { normalizeJurisdiction } from './usStates';

const MONTHS = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4,
  may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8,
  september: 9, sep: 9, sept: 9, october: 10, oct: 10, november: 11, nov: 11,
  december: 12, dec: 12,
};
const ORDINAL_QUARTER = { first: 1, second: 2, third: 3, fourth: 4 };

function isoDate(d) { return d.toISOString().slice(0, 10); }

// Parses a date phrase ("September 4", "9/4", "2026-09-04", "today",
// "yesterday") into 'YYYY-MM-DD'. When no year is given and the resulting
// date would be in the future, assumes the most recent past occurrence —
// these are corrections to already-logged days, never future planning.
export function parseDatePhrase(phrase, { now = new Date() } = {}) {
  const p = String(phrase || '').trim().toLowerCase();
  if (!p) return null;
  if (p === 'today') return isoDate(now);
  if (p === 'yesterday') return isoDate(new Date(now.getTime() - 86400000));

  let m = p.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return isoDate(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])));

  m = p.match(/([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?/);
  if (m && MONTHS[m[1]]) {
    const month = MONTHS[m[1]];
    const day = +m[2];
    const year = m[3] ? +m[3] : now.getFullYear();
    let d = new Date(Date.UTC(year, month - 1, day));
    if (!m[3] && d.getTime() > now.getTime() + 86400000) d = new Date(Date.UTC(year - 1, month - 1, day));
    return isoDate(d);
  }

  m = p.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
  if (m) {
    const month = +m[1], day = +m[2];
    const year = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : now.getFullYear();
    let d = new Date(Date.UTC(year, month - 1, day));
    if (!m[3] && d.getTime() > now.getTime() + 86400000) d = new Date(Date.UTC(year - 1, month - 1, day));
    return isoDate(d);
  }

  return null;
}

export function currentQuarterStr(now = new Date()) {
  return `${now.getFullYear()}-Q${Math.floor(now.getMonth() / 3) + 1}`;
}

export function parseQuarterPhrase(text, { now = new Date() } = {}) {
  const yearMatch = text.match(/\b(20\d{2})\b/);
  const year = yearMatch ? +yearMatch[1] : now.getFullYear();
  let m = text.match(/\bq([1-4])\b/i);
  if (m) return `${year}-Q${m[1]}`;
  const lower = text.toLowerCase();
  for (const [word, q] of Object.entries(ORDINAL_QUARTER)) {
    if (lower.includes(`${word} quarter`)) return `${year}-Q${q}`;
  }
  return null;
}

const FUEL_RE = /\bfuel(?:ed|ing)?\b.*?(\d+(?:\.\d+)?)\s*gallons?\b.*?\bin\s+([A-Za-z][A-Za-z\s]*?)\s*,\s*([A-Za-z][A-Za-z\s]*?)(?:[.!]|$)/i;
const MILEAGE_RE = /\bchange\s+([A-Za-z][A-Za-z\s]*?)\s+mileage(?:\s+for\s+([A-Za-z0-9,\s/-]+?))?\s+to\s+(\d+(?:\.\d+)?)\s*miles?\b/i;
const RECALC_RE = /\b(?:recalculate|recompute|refresh)\b\s*(.*)/i;

function isRecognizedJurisdiction(code) {
  return typeof code === 'string' && /^[A-Z]{2}$/.test(code);
}

// Interprets one natural-language IFTA command. Returns one of:
//   { type: 'summary', quarter }
//   { type: 'unconfirmed_query', quarter }
//   { type: 'fuel_entry', proposal: { gallons, city, state, receipt_date } }
//   { type: 'mileage_correction', proposal: { jurisdiction, log_date, miles } }
//   { type: 'recalculate_day', proposal: { log_date } }
//   { type: 'clarify', for, question, partial }   -- ask ONLY for the missing fact
//   { type: 'unrecognized' }
export function parseIftaCommand(text, ctx = {}) {
  const now = ctx.now || new Date();
  const t = String(text || '').trim();
  if (!t) return { type: 'unrecognized' };

  if (/\breview\b/i.test(t) && /\bifta\b/i.test(t)) {
    const quarter = parseQuarterPhrase(t, { now }) || ctx.quarter || currentQuarterStr(now);
    return { type: 'summary', quarter };
  }

  if (/still need|needs? confirmation|need(?:s)? to be confirmed|which.*(?:mileage|jurisdiction).*confirm/i.test(t)) {
    const quarter = parseQuarterPhrase(t, { now }) || ctx.quarter || currentQuarterStr(now);
    return { type: 'unconfirmed_query', quarter };
  }

  let m = t.match(FUEL_RE);
  if (m) {
    const gallons = parseFloat(m[1]);
    const city = m[2].trim();
    const state = normalizeJurisdiction(m[3].trim());
    if (!isRecognizedJurisdiction(state)) {
      return { type: 'clarify', for: 'fuel_entry', question: `Which state was that fuel stop in? I read "${m[3].trim()}", which I don't recognize.`, partial: { gallons, city } };
    }
    if (!city) {
      return { type: 'clarify', for: 'fuel_entry', question: 'Which city was that fuel stop in?', partial: { gallons, state } };
    }
    if (!(gallons > 0)) {
      return { type: 'clarify', for: 'fuel_entry', question: 'How many gallons was that fuel purchase?', partial: { city, state } };
    }
    return { type: 'fuel_entry', proposal: { gallons, city, state, receipt_date: isoDate(now) } };
  }

  m = t.match(MILEAGE_RE);
  if (m) {
    const jurisdictionRaw = m[1].trim();
    const datePhrase = m[2] ? m[2].trim() : '';
    const miles = parseFloat(m[3]);
    const jurisdiction = normalizeJurisdiction(jurisdictionRaw);
    if (!isRecognizedJurisdiction(jurisdiction)) {
      return { type: 'clarify', for: 'mileage_correction', question: `Which state did you mean by "${jurisdictionRaw}"?`, partial: { miles, datePhrase } };
    }
    if (!datePhrase) {
      return { type: 'clarify', for: 'mileage_correction', question: `Which day's ${jurisdiction} mileage would you like to change?`, partial: { jurisdiction, miles } };
    }
    const log_date = parseDatePhrase(datePhrase, { now });
    if (!log_date) {
      return { type: 'clarify', for: 'mileage_correction', question: `What date did you mean by "${datePhrase}"?`, partial: { jurisdiction, miles } };
    }
    if (!(miles >= 0)) {
      return { type: 'clarify', for: 'mileage_correction', question: `How many miles did you mean for ${jurisdiction} on ${log_date}?`, partial: { jurisdiction, log_date } };
    }
    return { type: 'mileage_correction', proposal: { jurisdiction, log_date, miles } };
  }

  m = t.match(RECALC_RE);
  if (m) {
    const datePhrase = (m[1] || '').trim();
    if (!datePhrase) return { type: 'clarify', for: 'recalculate_day', question: 'Which day would you like to recalculate?', partial: {} };
    const log_date = parseDatePhrase(datePhrase, { now });
    if (!log_date) return { type: 'clarify', for: 'recalculate_day', question: `What date did you mean by "${datePhrase}"?`, partial: {} };
    return { type: 'recalculate_day', proposal: { log_date } };
  }

  return { type: 'unrecognized' };
}
