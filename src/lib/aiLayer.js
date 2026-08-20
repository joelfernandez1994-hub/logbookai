// ============================================================================
// LogbookAI — AI-layer client helpers (deterministic, no AI, no DB writes).
// ----------------------------------------------------------------------------
// These helpers sit between the OpenAI-backed backend response and the
// canonical timeline writer. They validate / normalize the structured intent
// the backend returns and decide how the UI must present and apply it.
//
// Nothing here calls an LLM or writes to the database. OpenAI only interprets;
// the canonical writer (timelineWriter.js) is the only thing that persists.
// ============================================================================

import { startOfDayInTz } from './hosEngine';

export const DUTY_STATUSES = ['OFF_DUTY', 'SLEEPER_BERTH', 'DRIVING', 'ON_DUTY'];
const INTENTS = ['add_events', 'edit_events', 'replace_day', 'question', 'hos_question', 'clarification'];

export function normalizeStatus(s) {
  if (!s) return '';
  const u = String(s).toUpperCase();
  return u === 'SLEEPER' ? 'SLEEPER_BERTH' : u;
}

// Is this intent a question that must be answered deterministically (no Apply)?
export function isQuestionIntent(intent) {
  return intent === 'question' || intent === 'hos_question';
}

// Should the UI offer an Apply button for this proposal?
export function shouldOfferApply(proposal) {
  if (!proposal) return false;
  if (isQuestionIntent(proposal.intent)) return false;
  if (proposal.refuses_fabrication) return false;
  return Array.isArray(proposal.proposed_events) && proposal.proposed_events.length > 0;
}

// The day range [dayStart, dayEnd) a replace_day proposal replaces.
export function replaceDayRange(targetDate, tz) {
  const date = targetDate || new Date().toISOString().slice(0, 10);
  const dayStart = startOfDayInTz(new Date(date + 'T12:00:00'), tz);
  const dayEnd = new Date(dayStart.getTime() + 24 * 3600000);
  return { dayStart, dayEnd };
}

// Validate + normalize an interpret response from the backend. Returns
// { valid, errors, normalized }. Defensively coerces SLEEPER→SLEEPER_BERTH,
// start_time→start_timestamp, end_time→end_timestamp so the UI/writer always
// receive one canonical shape even if the backend mapping drifts.
export function validateInterpretResult(data) {
  const errors = [];
  if (!data || typeof data !== 'object') return { valid: false, errors: ['No response.'], normalized: null };

  const intent = data.intent && INTENTS.includes(data.intent) ? data.intent : 'add_events';
  if (data.intent && !INTENTS.includes(data.intent)) errors.push(`Unknown intent "${data.intent}"`);

  const proposed = Array.isArray(data.proposed_events) ? data.proposed_events : [];
  const normalizedEvents = proposed.map((p, i) => {
    const start = p.start_timestamp || p.start_time || '';
    const end = p.end_timestamp != null ? p.end_timestamp : (p.end_time != null ? p.end_time : null);
    const status = normalizeStatus(p.duty_status || p.status);
    if (!start) errors.push(`Event ${i + 1} is missing a start time.`);
    if (!DUTY_STATUSES.includes(status)) errors.push(`Event ${i + 1} has an invalid duty status "${status}".`);
    return {
      date: start ? start.slice(0, 10) : '',
      start_timestamp: start,
      end_timestamp: end || null,
      duty_status: status,
      city: p.city || '',
      state: p.state || '',
      activity_type: p.activity_type || p.activity || '',
      remark: p.remark || p.activity_type || p.activity || '',
      ambiguous_fields: p.ambiguous_fields || [],
      source: p.source || 'typed',
    };
  });

  const normalized = {
    intent,
    target_date: data.target_date || '',
    requires_clarification: !!data.requires_clarification,
    clarification_question: data.clarification_question || '',
    interpretation: data.interpretation || data.summary || '',
    summary: data.summary || data.interpretation || '',
    proposed_events: normalizedEvents,
    clarifications: Array.isArray(data.clarifications) ? data.clarifications : [],
    location_confirmations: Array.isArray(data.location_confirmations) ? data.location_confirmations : [],
    pretrip_ask: !!data.pretrip_ask,
    refuses_fabrication: !!data.refuses_fabrication,
  };

  return { valid: errors.length === 0, errors, normalized };
}