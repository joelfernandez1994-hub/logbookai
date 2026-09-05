// ============================================================================
// LogbookAI Deterministic Voice/Text Command Parser
// ----------------------------------------------------------------------------
// Parses common driver commands into proposed RODS events WITHOUT calling a
// generative model, so basic Voice Log commands do not consume the monthly AI
// allowance. When the parser is confident it returns { handled: true } with a
// list of proposed events (and any clarifications the driver must confirm).
// When it cannot confidently parse the command it returns { handled: false }
// and the caller falls back to Ask LogbookAI (generative, quota-counted).
//
// This is a PROPOSAL ENGINE — nothing here writes to the database. The driver
// reviews and confirms every field before anything is applied.
// ============================================================================

const H = 3600000;
const MIN = 60000;

const STATUS_KEYWORDS = {
  DRIVING: ['driving', 'drive', 'drove', 'drove off', 'left', 'heading out', 'on the road'],
  ON_DUTY: ['on duty', 'on-duty', 'onduty', 'fuel', 'fueled', 'fueling', 'loading', 'loaded', 'unloading', 'unloaded', 'pre-trip', 'pretrip', 'pre trip', 'post-trip', 'post trip', 'posttrip', 'inspection', 'drop', 'hook', 'bobtail', 'yard move', 'equipment change'],
  SLEEPER_BERTH: ['sleeper', 'sleeper berth', 'in the bunk', 'berth'],
  OFF_DUTY: ['off duty', 'off-duty', 'offduty', 'off', 'done for the day', 'done', 'rest'],
};

// Map an activity phrase to { duty_status, activity_type }
const ACTIVITY_MAP = [
  { re: /\bpre[-\s]?trip\b/i, status: 'ON_DUTY', activity: 'Pre-Trip' },
  { re: /\bpost[-\s]?trip\b/i, status: 'ON_DUTY', activity: 'Post-Trip' },
  { re: /\bfuel(?:ing|ed)?\b/i, status: 'ON_DUTY', activity: 'Fuel' },
  { re: /\bunload(?:ing|ed)?\b/i, status: 'ON_DUTY', activity: 'Unloading' },
  { re: /\bload(?:ing|ed)?\b/i, status: 'ON_DUTY', activity: 'Loading' },
  { re: /\bdrop(?:ped)?\b.*\bhook\b|\bhook(?:ed)?\b.*\bdrop\b|\bequipment change\b/i, status: 'ON_DUTY', activity: 'Equipment Change' },
  { re: /\bbobtail/i, status: 'ON_DUTY', activity: 'Equipment Change' },
  { re: /\byard move\b/i, status: 'ON_DUTY', activity: 'Yard Move' },
];

const US_STATES = ['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY'];

const STATE_RE = new RegExp(',?\\s*("([A-Z]{2})"|\\b([A-Z]{2})\\b)\\s*$');

// ---------------------------------------------------------------------------
// TIME PARSING
// ---------------------------------------------------------------------------
function parseTimeNumber(tok) {
  const m = tok.match(/^(\d{1,2})(?::(\d{2}))?$/);
  if (!m) return null;
  const h = Number(m[1]); const min = m[2] ? Number(m[2]) : 0;
  if (h > 23 || min > 59) return null;
  return { h, min };
}

function detectMeridian(text) {
  if (/\b(a\.?m\.?|am)\b/i.test(text)) return 'am';
  if (/\b(p\.?m\.?|pm)\b/i.test(text)) return 'pm';
  return null;
}

// Resolve an hour/minute + optional explicit meridian into a concrete Date on
// refDate's calendar day. When no meridian is given for an hour in 1-11 (the
// genuinely ambiguous range), pick whichever of the AM/PM readings lands
// CLOSEST to `refDate` instead of a fixed hour-range guess: real-time
// voice/typed logging is almost always about "now" or a moment shortly
// before/after it (e.g. "off duty at 6" said at 6:05 PM should default to
// 6 PM, not 6 AM). Still marked ambiguous so the driver reviews/confirms
// before anything is applied — this only improves the DEFAULT guess.
function resolveTimeOfDay(tn, mer, refDate, tz) {
  const h = tn.h;
  if (mer) {
    let hh = h;
    if (mer === 'pm' && hh < 12) hh += 12;
    if (mer === 'am' && hh === 12) hh = 0;
    return { date: timeOnDate(refDate, hh, tn.min, tz), ambiguous: false };
  }
  if (h === 12) return { date: timeOnDate(refDate, 12, tn.min, tz), ambiguous: false }; // noon default (unchanged)
  if (h === 0 || h >= 13) return { date: timeOnDate(refDate, h, tn.min, tz), ambiguous: false }; // already unambiguous 24h-style
  const amDate = timeOnDate(refDate, h, tn.min, tz);
  const pmDate = timeOnDate(refDate, h + 12, tn.min, tz);
  const closer = Math.abs(amDate.getTime() - refDate.getTime()) <= Math.abs(pmDate.getTime() - refDate.getTime()) ? amDate : pmDate;
  return { date: closer, ambiguous: true };
}

// Parse a single time mention in context. Returns { date, ambiguous }
function parseTime(text, refDate, tz) {
  const lower = text.toLowerCase();
  // relative "now"
  if (/\bnow\b/.test(lower)) return { date: new Date(refDate.getTime()), ambiguous: false };
  const m = lower.match(/(?:^|\s|at\s)(\d{1,2}(?::\d{2})?)\s*(a\.?m\.?|p\.?m\.?)?/);
  if (!m) return null;
  const tn = parseTimeNumber(m[1]);
  if (!tn) return null;
  const mer = m[2] ? m[2].replace(/[.\s]/g, '').toLowerCase() : detectMeridian(text);
  return resolveTimeOfDay(tn, mer, refDate, tz);
}

// ---------------------------------------------------------------------------
// TIME RANGE PARSING — "from 10 PM to 6 AM", "slept 11 to 7", "9 until 5".
// Very common trucker phrasing for sleeper/off-duty periods that previously
// silently dropped the second time (only duration, e.g. "for 8 hours", was
// understood). Each side is resolved independently via resolveTimeOfDay, and
// a range that lands at/before its own start (e.g. "10 PM to 6 AM") rolls
// the end into the next calendar day.
// ---------------------------------------------------------------------------
function parseTimeRange(text, refDate, tz) {
  const m = text.match(/(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?)\s*(?:to|until|through|-)\s*(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?)/i);
  if (!m) return null;
  const t1 = parseTime(m[1], refDate, tz);
  const t2 = parseTime(m[2], refDate, tz);
  if (!t1 || !t2) return null;
  let end = t2.date;
  if (end.getTime() <= t1.date.getTime()) end = new Date(end.getTime() + 24 * H);
  return { start: t1.date, end, ambiguous: t1.ambiguous || t2.ambiguous };
}

// Set a local H:M on the same calendar day as refDate (in tz).
function timeOnDate(refDate, h, min, tz) {
  // Use tz start-of-day then add. We rely on hosEngine.startOfDayInTz.
  // To avoid a heavy import cycle we compute via Intl formatting of refDate.
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const parts = fmt.formatToParts(refDate);
  const y = Number(parts.find(p => p.type === 'year').value);
  const mo = Number(parts.find(p => p.type === 'month').value) - 1;
  const dd = Number(parts.find(p => p.type === 'day').value);
  // local wall time -> approximate ISO by using Date.UTC then no offset correction
  // (we accept minor tz skew for a proposal; driver reviews the datetime-local field)
  return new Date(Date.UTC(y, mo, dd, h, min));
}

// ---------------------------------------------------------------------------
// DURATION PARSING
// ---------------------------------------------------------------------------
function parseDuration(text) {
  const m = text.match(/(?:for\s+)?(\d+(?:\.\d+)?)\s*(hour|hr|hours|h|min|minute|minutes)\b/i);
  if (m) {
    const n = Number(m[1]); const unit = m[2].toLowerCase();
    if (unit.startsWith('h')) return n * H;
    return n * MIN;
  }
  if (/half an hour|half hour|30 min|30min/i.test(text)) return 30 * MIN;
  if (/an hour|1 hour|one hour/i.test(text)) return H;
  if (/quarter hour|15 min|15min/i.test(text)) return 15 * MIN;
  return null;
}

// ---------------------------------------------------------------------------
// LOCATION PARSING
// ---------------------------------------------------------------------------
function parseLocation(text) {
  // "in Miami, FL" / "in Ocala" / "in Macon, GA"
  const m = text.match(/\bin\s+([A-Z][a-zA-Z]+(?:\s[A-Z][a-zA-Z]+)?)\s*,?\s*([A-Z]{2})?\b/);
  if (!m) return null;
  const city = m[1];
  const state = m[2] || '';
  return { city, state, ambiguous: !state };
}

// ---------------------------------------------------------------------------
// STATUS DETECTION
// ---------------------------------------------------------------------------
function detectStatus(text) {
  const lower = text.toLowerCase();
  // activity-specific first
  for (const a of ACTIVITY_MAP) if (a.re.test(text)) return { status: a.status, activity: a.activity };
  // explicit status keywords
  for (const s of Object.keys(STATUS_KEYWORDS)) {
    for (const kw of STATUS_KEYWORDS[s]) {
      if (lower.includes(kw)) return { status: s, activity: '' };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// EDIT DETECTION — "change my 4 PM status to sleeper"
// ---------------------------------------------------------------------------
function detectEdit(text) {
  if (/\b(change|edit|modify|update|switch|move)\b/i.test(text) && /\bto\b/i.test(text)) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// MAIN PARSER
// Splits a multi-clause command into segments and parses each into a proposed
// event. Returns { handled, events, clarifications, ambiguousFields, fallback }.
// ---------------------------------------------------------------------------
export function parseVoiceCommand(text, ctx = {}) {
  const refDate = ctx.now instanceof Date ? ctx.now : new Date();
  const tz = ctx.timezone || 'America/Chicago';
  const raw = (text || '').trim();
  if (!raw) return { handled: false, reason: 'empty' };

  const lower = raw.toLowerCase();
  const explicitTimes = raw.match(/\b\d{1,2}:\d{2}\s*(?:a\.?m\.?|p\.?m\.?)\b/gi) || [];
  if (explicitTimes.length > 2) {
    return { handled: false, reason: 'complex_timeline', fallback: 'ai' };
  }

  // Question detection → not a voice-log command; route to Ask LogbookAI.
  if (/\b(how many|do i have|why|does my|will i|can i|review my|check my|what does|what can|is it|are there|any issues|compliant)\b/i.test(lower)) {
    return { handled: false, reason: 'question', fallback: 'ai' };
  }

  // EDIT command — we can parse a single edit, but it requires matching an
  // existing event by time. Mark as handled with a proposed change + a
  // clarification asking the driver to confirm the target.
  if (detectEdit(raw)) {
    const t = parseTime(raw, refDate, tz);
    const target = detectStatus(raw);
    if (t && target) {
      return {
        handled: true,
        edit: true,
        events: [{
          start_timestamp: t.date.toISOString(),
          end_timestamp: null,
          duty_status: target.status,
          activity_type: target.activity,
          city: '', state: '', remark: target.activity || '',
          _ambiguous: { time: t.ambiguous },
        }],
        clarifications: [{ type: 'edit_target', question: `Change the status starting ${formatTime(t.date)} to ${labelStatus(target.status)}. Confirm which existing event this should replace.` }],
        ambiguousFields: t.ambiguous ? ['start_timestamp'] : [],
      };
    }
  }

  // Split into clauses. Connectors: "then", "left at", "and", ",", "after that".
  // We also handle the narrative "Started X at T1, left at T2, fueled at T3".
  const clauses = splitClauses(raw);
  const events = [];
  const clarifications = [];
  const ambiguousFields = [];
  let prevEnd = null;

  for (let i = 0; i < clauses.length; i++) {
    const clause = clauses[i];
    const status = detectStatus(clause);
    if (!status) continue;

    // Try a two-time range first ("off duty from 10 PM to 6 AM") — common
    // trucker phrasing for sleeper/off-duty periods that a single time +
    // duration can't express. Falls back to single-time + optional duration.
    const range = parseTimeRange(clause, refDate, tz);
    let start, end, timeAmbiguous;
    if (range) {
      start = range.start; end = range.end; timeAmbiguous = range.ambiguous;
    } else {
      const t = parseTime(clause, refDate, tz);
      if (!t) continue;
      const dur = parseDuration(clause);
      start = t.date;
      end = dur ? new Date(start.getTime() + dur) : null;
      timeAmbiguous = t.ambiguous;
      // If "left at" / "then" implies previous event ends at this start
      if (prevEnd && !dur) {
        // previous event with no end ends here
        const prev = events[events.length - 1];
        if (prev && !prev.end_timestamp) prev.end_timestamp = start.toISOString();
      }
    }
    const loc = parseLocation(clause) || parseLocation(raw);
    events.push({
      start_timestamp: start.toISOString(),
      end_timestamp: end ? end.toISOString() : null,
      duty_status: status.status,
      activity_type: status.activity,
      city: loc?.city || '',
      state: loc?.state || '',
      remark: status.activity || '',
      _ambiguous: { time: timeAmbiguous, location: loc?.ambiguous },
    });
    if (timeAmbiguous) ambiguousFields.push(`event_${i + 1}:start_timestamp`);
    // A bare city without a state is NOT blocking — the state is left
    // blank/inferred for the driver to review. Only simple single-intent
    // commands reach this parser, so a bare city never stops the flow.
    if (loc?.ambiguous) {
      ambiguousFields.push(`event_${i + 1}:state`);
    }
    prevEnd = end;
  }

  if (events.length === 0) {
    return { handled: false, reason: 'unrecognized', fallback: 'ai' };
  }

  return { handled: true, events, clarifications, ambiguousFields };
}

function splitClauses(text) {
  // Split on "then", "after that", "and then", "left at", commas, "and".
  return text
    .replace(/\bthen\b|\bafter that\b/gi, '|')
    .replace(/,\s*(?=(?:left|fueled|drove|started|stopped|on duty|off duty|driving|sleeper|fuel|pre-trip))/gi, '|')
    .split('|')
    .map(s => s.trim())
    .filter(Boolean);
}

export function labelStatus(s) {
  return ({ OFF_DUTY: 'Off Duty', SLEEPER_BERTH: 'Sleeper Berth', DRIVING: 'Driving', ON_DUTY: 'On Duty' })[s] || s;
}

export function formatTime(d) {
  return new Date(d).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}