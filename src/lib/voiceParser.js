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

// Bilingual (English + Spanish) trucking vocabulary. Every phrase here is a
// real, common way drivers describe the same four canonical duty statuses —
// the driver should never need to "speak computer" to be understood. Broader
// phrases (multi-word) are safe as substring matches (checked via
// `lower.includes`), so word order/punctuation variations still match.
const STATUS_KEYWORDS = {
  DRIVING: [
    'driving', 'drive', 'drove', 'drove off', 'left', 'heading out', 'on the road',
    'rolling', 'started rolling', 'got rolling', 'pulled out', 'started back up',
    'back on the road', 'hit the road', 'took off', 'headed out',
    // Spanish
    'conduciendo', 'manejando', 'maneje', 'manejé', 'arranque', 'arranqué', 'sali', 'salí', 'en la carretera',
  ],
  ON_DUTY: [
    'on duty', 'on-duty', 'onduty', 'fuel', 'fueled', 'fueling', 'loading', 'loaded', 'unloading', 'unloaded',
    'pre-trip', 'pretrip', 'pre trip', 'post-trip', 'post trip', 'posttrip', 'inspection', 'drop', 'hook',
    'bobtail', 'yard move', 'equipment change', 'checked the truck', 'checking the truck',
    'detention', 'waiting at the shipper', 'waited at the shipper', 'waiting at the receiver', 'waited at the receiver',
    'paperwork', 'did paperwork', 'drop and hook', 'swapped trailers', 'dropped and hooked',
    // Spanish
    'en servicio', 'cargando', 'cargue', 'cargué', 'descargando', 'descargue', 'descargué',
    'revisando el camion', 'revisando el camión', 'inspeccion', 'inspección', 'papeleo',
  ],
  SLEEPER_BERTH: [
    'sleeper', 'sleeper berth', 'in the bunk', 'got in the bunk', 'berth', 'went in the sleeper',
    // Spanish
    'litera', 'en la litera', 'dormitorio',
  ],
  OFF_DUTY: [
    'off duty', 'off-duty', 'offduty', 'off', 'done for the day', 'done', 'rest',
    'called it a night', 'shut down', 'shut down for the night', 'done for the night',
    'done driving for the day', 'done driving for the night', 'calling it a day', 'calling it a night',
    // Spanish
    'fuera de servicio', 'termine por hoy', 'terminé por hoy', 'termine por la noche', 'terminé por la noche',
  ],
};

// Rest verbs that DON'T by themselves say where the driver rested. "Slept"/
// "napped"/"went to bed" could mean the truck's sleeper berth OR simply
// off-duty (a motel, a lounge, etc.) — never guess; only classify as
// SLEEPER_BERTH when the clause also names the berth/cab/truck. Otherwise
// surface it as genuinely ambiguous between OFF_DUTY and SLEEPER_BERTH for
// driver confirmation.
const AMBIGUOUS_REST_KEYWORDS = [
  'slept', 'sleep', 'sleeping', 'napped', 'napping', 'rested', 'resting',
  'went to bed', 'went to sleep', 'got up', 'woke up', 'hit the sack', 'turned in',
  // Spanish
  'dormi', 'dormí', 'durmiendo', 'me acoste', 'me acosté', 'descanse', 'descansé',
];
// Ambiguous non-driving stop with no explicit duty-status word — a lunch or
// generic "break" could be OFF_DUTY (personal time) or ON_DUTY (paid stop),
// and LogbookAI must not guess which. Same never-guess pattern as the rest
// verbs above: default to the more common real-world meaning (OFF_DUTY) but
// flag it for driver confirmation. The MANDATORY 30-minute break phrasing
// ("my 30", "took my 30") is handled separately by ACTIVITY_MAP and is not
// ambiguous — the driver named the specific FMCSA break, not a generic one.
const AMBIGUOUS_BREAK_KEYWORDS = [
  'took a break', 'stopped for lunch', 'lunch break', 'took lunch', 'stopped to eat',
  // Spanish
  'tome un descanso', 'tomé un descanso', 'pare para almorzar', 'paré para almorzar',
];
const BERTH_CONTEXT_RE = /\b(sleeper|berth|bunk|cab|truck|litera|camion|camión)\b/i;

// Map an activity phrase to { duty_status, activity_type }. Bilingual.
const ACTIVITY_MAP = [
  { re: /\bpre[-\s]?trip\b|\binspecci[oó]n previa\b/i, status: 'ON_DUTY', activity: 'Pre-Trip' },
  { re: /\bpost[-\s]?trip\b|\binspecci[oó]n final\b/i, status: 'ON_DUTY', activity: 'Post-Trip' },
  { re: /\bfuel(?:ing|ed)?\b|\bgot fuel\b|\bcombustible\b/i, status: 'ON_DUTY', activity: 'Fuel' },
  { re: /\bunload(?:ing|ed)?\b|\bdescarg(?:u[eé]|ando|a|o)\b/i, status: 'ON_DUTY', activity: 'Unloading' },
  { re: /\bload(?:ing|ed)?\b|\bcarg(?:u[eé]|ando|a|o)\b/i, status: 'ON_DUTY', activity: 'Loading' },
  { re: /\bdrop(?:ped)?\b.*\bhook\b|\bhook(?:ed)?\b.*\bdrop\b|\bequipment change\b|\bswapped trailers?\b|\bdrop and hook\b|\bdrop[-\s]?hook\b/i, status: 'ON_DUTY', activity: 'Equipment Change' },
  { re: /\bbobtail/i, status: 'ON_DUTY', activity: 'Equipment Change' },
  { re: /\byard move\b/i, status: 'ON_DUTY', activity: 'Yard Move' },
  { re: /\bdetention\b|\bwait(?:ed|ing)?\s+at\s+the\s+(?:shipper|receiver|consignee)\b/i, status: 'ON_DUTY', activity: 'Detention' },
  { re: /\bpaperwork\b|\bdid paperwork\b|\bpapeleo\b/i, status: 'ON_DUTY', activity: 'Paperwork' },
  { re: /\bchecked the truck\b|\bchecking the truck\b|\brevis(?:e|ando)\s+el\s+cami[oó]n\b/i, status: 'ON_DUTY', activity: 'Vehicle Check' },
  // The mandatory 30-minute break — extremely common trucker phrasing
  // ("stopped for my 30", "took my 30") that previously matched no keyword
  // at all and silently dropped the whole clause.
  { re: /\bmy 30\b|\btook (?:my )?30\b|\bstopped for (?:my )?30\b|\b30[-\s]?min(?:ute)?s?\s*break\b/i, status: 'OFF_DUTY', activity: '30-Minute Break' },
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

// Phrases that imply a meridian even without an explicit AM/PM. This is the
// FIRST (strongest) disambiguation tier for an hour with no explicit AM/PM.
// "Last night"/"tonight" don't shift the calendar day here (that would need
// a separate relative-date feature) — they only bias the meridian guess.
function detectContextMeridian(text) {
  const lower = text.toLowerCase();
  if (/\b(this morning|early this morning|woke up|got up)\b/.test(lower)) return 'am';
  if (/\b(this afternoon)\b/.test(lower)) return 'pm';
  if (/\b(this evening|tonight|last night)\b/.test(lower)) return 'pm';
  return null;
}

// Resolve a genuinely ambiguous hour (1-11, no explicit AM/PM) using, in
// priority order:
//   1. an explicit context phrase in the clause ("this morning", "tonight")
//   2. chronological consistency with the previous event in THIS narrative
//      (prefer whichever reading keeps moving forward, within one shift)
//   3. continuity with an existing logged event near this time (a new entry
//      usually picks up within ~2h of where the log left off)
//   4. closest-to-"now" — final fallback for a bare, context-free mention
// Always still marked ambiguous: this only improves the DEFAULT the driver
// reviews, it never skips that review.
function resolveAmbiguousHour(h, min, refDate, tz, opts = {}) {
  const amDate = timeOnDate(refDate, h, min, tz);
  const pmDate = timeOnDate(refDate, h + 12, min, tz);

  if (opts.contextMeridian === 'am') return { date: amDate, ambiguous: true, resolvedBy: 'context' };
  if (opts.contextMeridian === 'pm') return { date: pmDate, ambiguous: true, resolvedBy: 'context' };

  if (opts.anchor instanceof Date) {
    const anchorMs = opts.anchor.getTime();
    const forward = [amDate, pmDate].filter(d => d.getTime() >= anchorMs && d.getTime() - anchorMs <= 20 * H);
    if (forward.length === 1) return { date: forward[0], ambiguous: true, resolvedBy: 'chronology' };
    if (forward.length === 2) {
      const closer = Math.abs(forward[0].getTime() - anchorMs) <= Math.abs(forward[1].getTime() - anchorMs) ? forward[0] : forward[1];
      return { date: closer, ambiguous: true, resolvedBy: 'chronology' };
    }
  }

  if (opts.existingEvents?.length) {
    const boundaries = [];
    for (const e of opts.existingEvents) {
      if (e?.start_timestamp) boundaries.push(new Date(e.start_timestamp).getTime());
      if (e?.end_timestamp) boundaries.push(new Date(e.end_timestamp).getTime());
    }
    if (boundaries.length) {
      const distTo = (d) => Math.min(...boundaries.map(b => Math.abs(b - d.getTime())));
      const amDist = distTo(amDate), pmDist = distTo(pmDate);
      const NEIGHBOR_THRESHOLD_MS = 2 * H;
      if (amDist <= NEIGHBOR_THRESHOLD_MS || pmDist <= NEIGHBOR_THRESHOLD_MS) {
        return { date: amDist <= pmDist ? amDate : pmDate, ambiguous: true, resolvedBy: 'neighbor' };
      }
    }
  }

  const closer = Math.abs(amDate.getTime() - refDate.getTime()) <= Math.abs(pmDate.getTime() - refDate.getTime()) ? amDate : pmDate;
  return { date: closer, ambiguous: true, resolvedBy: 'closest_to_now' };
}

// Resolve an hour/minute + optional explicit meridian into a concrete Date on
// refDate's calendar day. An explicit meridian (or an hour outside 1-11) is
// unambiguous; otherwise delegates to resolveAmbiguousHour's tiered guess.
function resolveTimeOfDay(tn, mer, refDate, tz, opts = {}) {
  const h = tn.h;
  if (mer) {
    let hh = h;
    if (mer === 'pm' && hh < 12) hh += 12;
    if (mer === 'am' && hh === 12) hh = 0;
    return { date: timeOnDate(refDate, hh, tn.min, tz), ambiguous: false };
  }
  if (h === 12) return { date: timeOnDate(refDate, 12, tn.min, tz), ambiguous: false }; // noon default (unchanged)
  if (h === 0 || h >= 13) return { date: timeOnDate(refDate, h, tn.min, tz), ambiguous: false }; // already unambiguous 24h-style
  return resolveAmbiguousHour(h, tn.min, refDate, tz, opts);
}

// Parse an ISOLATED, already-extracted time token (e.g. "10 PM", "6", "1:15")
// with no surrounding sentence context to check against — used by
// parseTimeRange, which only ever hands this a substring its own regex
// already shaped like a time. A bare number is accepted here (unlike the
// full-clause parseTime below) because the caller already established this
// exact substring IS the time mention, not a number floating in prose.
function parseTimeToken(tok, refDate, tz, opts = {}) {
  const m = tok.trim().match(/^(\d{1,2}(?::\d{2})?)\s*(a\.?m\.?|p\.?m\.?)?$/i);
  if (!m) return null;
  const tn = parseTimeNumber(m[1]);
  if (!tn) return null;
  const mer = m[2] ? m[2].replace(/[.\s]/g, '').toLowerCase() : null;
  return resolveTimeOfDay(tn, mer, refDate, tz, opts);
}

// Parse a time mention within a full clause/sentence. Returns { date,
// ambiguous } or null. A bare 1-2 digit number is ONLY treated as a time
// when it has real time context — preceded by "at ", written with a colon
// ("1:15"), or followed by an explicit meridian ("6 PM") — never a bare
// number floating in prose (e.g. "my 30" in "stopped for my 30", the 30-
// minute break, must NOT be misread as "30 o'clock" and swallow the real
// time mentioned later in the same clause).
// `opts.anchor` (a Date) and `opts.existingEvents` feed tiers 2-3 of the
// ambiguous-hour resolution; `text` itself is checked for a context phrase.
function parseTime(text, refDate, tz, opts = {}) {
  const lower = text.toLowerCase();
  // relative "now"
  if (/\bnow\b/.test(lower)) return { date: new Date(refDate.getTime()), ambiguous: false };
  const m = lower.match(/\bat\s+(\d{1,2}(?::\d{2})?)\s*(a\.?m\.?|p\.?m\.?)?\b|(\d{1,2}:\d{2})\s*(a\.?m\.?|p\.?m\.?)?|(\d{1,2})\s*(a\.?m\.?|p\.?m\.?)\b/i);
  if (!m) return null;
  const tok = m[1] || m[3] || m[5];
  const merTok = m[2] || m[4] || m[6];
  const tn = parseTimeNumber(tok);
  if (!tn) return null;
  const mer = merTok ? merTok.replace(/[.\s]/g, '').toLowerCase() : detectMeridian(text);
  const contextMeridian = mer ? null : (opts.contextMeridian ?? detectContextMeridian(text));
  return resolveTimeOfDay(tn, mer, refDate, tz, { ...opts, contextMeridian });
}

// ---------------------------------------------------------------------------
// TIME RANGE PARSING — "from 10 PM to 6 AM", "slept 11 to 7", "9 until 5".
// Very common trucker phrasing for sleeper/off-duty periods that previously
// silently dropped the second time (only duration, e.g. "for 8 hours", was
// understood). Each side is resolved independently via resolveTimeOfDay, and
// a range that lands at/before its own start (e.g. "10 PM to 6 AM") rolls
// the end into the next calendar day.
// ---------------------------------------------------------------------------
function parseTimeRange(text, refDate, tz, opts = {}) {
  // "to/until/through/-" for explicit ranges, plus the common "went to sleep
  // at 10 and got/woke up at 6" idiom, whose connector is "and (got|woke) up"
  // rather than "to" — narrow phrasing (not a bare "and") so it doesn't
  // misfire on two genuinely separate events joined with "and".
  const m = text.match(/(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?)\s*(?:to|until|through|-|and\s+(?:got|woke)\s+up(?:\s+at)?)\s*(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?)/i);
  if (!m) return null;
  const t1 = parseTimeToken(m[1], refDate, tz, opts);
  if (!t1) return null;
  // The end side inherits the start's context AND a chronological anchor of
  // the resolved start — "11 to 7" should pick the "7" reading that comes
  // AFTER "11", same as any other chronological-consistency case.
  const t2 = parseTimeToken(m[2], refDate, tz, { ...opts, anchor: t1.date });
  if (!t2) return null;
  let end = t2.date;
  if (end.getTime() <= t1.date.getTime()) end = new Date(end.getTime() + 24 * H);
  return { start: t1.date, end, ambiguous: t1.ambiguous || t2.ambiguous };
}

// tz offset (ms to ADD to a UTC instant to get local wall-clock) at `date`,
// in `tz`. Self-contained (mirrors timelineEngine.js's tzOffsetMs) to avoid
// a heavy import cycle — this file must stay independent of the timeline
// engine per the module header.
function tzOffsetMs(date, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
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

// Set a local H:M on the same calendar day as refDate, correctly converted
// from `tz` wall-clock time to a UTC instant (was previously stamping h/min
// straight onto Date.UTC with NO offset correction — e.g. "6 PM Chicago"
// came out as 18:00 UTC instead of 23:00 UTC, silently off by the carrier's
// UTC offset on every AI-proposed event until the driver caught it in
// review). Build a UTC guess on the right calendar day, then correct using
// the offset TWICE: the first correction can land on the wrong side of a DST
// transition (its offset was sampled at the pre-correction guess, not the
// real target instant), so a second pass re-samples the offset at the
// corrected instant and re-applies it. Verified empirically against the
// 2026-03-08 US spring-forward transition, where a single pass is off by a
// full hour for any local time after 3 AM that day.
function timeOnDate(refDate, h, min, tz) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const parts = fmt.formatToParts(refDate);
  const y = Number(parts.find(p => p.type === 'year').value);
  const mo = Number(parts.find(p => p.type === 'month').value) - 1;
  const dd = Number(parts.find(p => p.type === 'day').value);
  const utcGuess = Date.UTC(y, mo, dd, h, min);
  const firstPass = new Date(utcGuess - tzOffsetMs(new Date(utcGuess), tz));
  return new Date(utcGuess - tzOffsetMs(firstPass, tz));
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

// Status/duty-status words that must never be mistaken for a city name after
// "to" in an edit command ("change my status to Sleeper").
const STATUS_WORD_RE = /^(off duty|sleeper|sleeper berth|driving|on duty)$/i;

// "change my last fuel stop TO Orlando" — edit commands describe a new
// location with "to <City>" rather than "in <City>". Only used by the edit
// branch (not the general clause parser) to avoid misreading an ordinary
// "drove to Orlando" narrative clause as a location-only edit.
function parseLocationAfterTo(text) {
  const m = text.match(/\bto\s+([A-Z][a-zA-Z]+(?:\s[A-Z][a-zA-Z]+)?)\s*,?\s*([A-Z]{2})?\b/);
  if (!m || STATUS_WORD_RE.test(m[1])) return null;
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
  // Ambiguous rest verb ("slept", "rested") with no berth/cab/truck context —
  // never silently assume the sleeper berth. Default to OFF_DUTY (the more
  // common real-world meaning: a motel, a rest area, etc.) but flag it so the
  // caller surfaces a clarification and the driver picks between OFF_DUTY and
  // SLEEPER_BERTH before anything is applied.
  for (const kw of AMBIGUOUS_REST_KEYWORDS) {
    if (lower.includes(kw)) {
      if (BERTH_CONTEXT_RE.test(text)) return { status: 'SLEEPER_BERTH', activity: '' };
      return { status: 'OFF_DUTY', activity: '', statusAmbiguous: true, statusCandidates: ['OFF_DUTY', 'SLEEPER_BERTH'] };
    }
  }
  // Ambiguous generic break/lunch — could be OFF_DUTY (personal time) or
  // ON_DUTY (paid, non-driving). Never guess; default to the more common
  // real-world meaning (OFF_DUTY) and flag for driver confirmation. Distinct
  // from the mandatory-30 phrasing above, which is unambiguous.
  for (const kw of AMBIGUOUS_BREAK_KEYWORDS) {
    if (lower.includes(kw)) {
      return { status: 'OFF_DUTY', activity: 'Break', statusAmbiguous: true, statusCandidates: ['OFF_DUTY', 'ON_DUTY'] };
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
  // The per-clause loop below (plus the new time-range support) already
  // handles an arbitrary number of simple single-status clauses, so this cap
  // only needs to catch genuinely complex multi-leg narratives (several
  // distinct stops/activities woven together) and defer those to the AI
  // rather than risk misreading one. Raised from 2 → 4 so everyday sequences
  // like "off duty at 6, pre-trip at 6:15, driving at 6:30" or a single
  // sleeper/off-duty time RANGE (which alone counts as 2 explicit mentions)
  // resolve deterministically instead of always burning AI quota.
  const explicitTimes = raw.match(/\b\d{1,2}:\d{2}\s*(?:a\.?m\.?|p\.?m\.?)\b/gi) || [];
  if (explicitTimes.length > 4) {
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
    const t = parseTime(raw, refDate, tz, { existingEvents: ctx.events || [] });
    const target = detectStatus(raw);
    const loc = parseLocation(raw) || parseLocationAfterTo(raw);
    // A target status isn't required when the edit is purely about location/
    // metadata ("change my last fuel stop to Orlando") — only require SOME
    // identifiable target: a status/activity keyword, a new location, or both.
    if (t && (target || loc)) {
      const changeDesc = [
        target ? `${labelStatus(target.status)}${target.activity ? ` (${target.activity})` : ''}` : null,
        loc?.city ? `${loc.city}${loc.state ? `, ${loc.state}` : ''}` : null,
      ].filter(Boolean).join(' — ');
      return {
        handled: true,
        edit: true,
        events: [{
          start_timestamp: t.date.toISOString(),
          end_timestamp: null,
          duty_status: target?.status || '',
          activity_type: target?.activity || '',
          city: loc?.city || '', state: loc?.state || '', remark: target?.activity || '',
          _ambiguous: { time: t.ambiguous, location: loc?.ambiguous },
        }],
        clarifications: [{ type: 'edit_target', question: `Change the event around ${formatTime(t.date)} to ${changeDesc || '(review the fields below)'}. Confirm which existing event this should replace.` }],
        ambiguousFields: [t.ambiguous && 'start_timestamp', loc?.ambiguous && 'state'].filter(Boolean),
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
  // Chronological anchor for ambiguous-hour resolution (tier 2): the START of
  // the most recently resolved event in THIS narrative. Existing logged
  // events (tier 3) are constant across the whole narrative.
  let anchor = null;
  const existingEvents = ctx.events || [];

  for (let i = 0; i < clauses.length; i++) {
    const clause = clauses[i];
    const status = detectStatus(clause);
    if (!status) continue;

    const timeOpts = { anchor, existingEvents };
    // Try a two-time range first ("off duty from 10 PM to 6 AM") — common
    // trucker phrasing for sleeper/off-duty periods that a single time +
    // duration can't express. Falls back to single-time + optional duration.
    const range = parseTimeRange(clause, refDate, tz, timeOpts);
    let start, end, timeAmbiguous;
    if (range) {
      start = range.start; end = range.end; timeAmbiguous = range.ambiguous;
    } else {
      const t = parseTime(clause, refDate, tz, timeOpts);
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
      _ambiguous: { time: timeAmbiguous, location: loc?.ambiguous, duty_status: !!status.statusAmbiguous },
    });
    if (timeAmbiguous) ambiguousFields.push(`event_${i + 1}:start_timestamp`);
    // A bare city without a state is NOT blocking — the state is left
    // blank/inferred for the driver to review. Only simple single-intent
    // commands reach this parser, so a bare city never stops the flow.
    if (loc?.ambiguous) {
      ambiguousFields.push(`event_${i + 1}:state`);
    }
    if (status.statusAmbiguous) {
      ambiguousFields.push(`event_${i + 1}:duty_status`);
      clarifications.push({
        type: 'status_ambiguous',
        question: `Was "${clause.trim()}" resting in the sleeper berth, or off duty (e.g. a motel/rest area)? Confirm before applying.`,
      });
    }
    anchor = start;
    prevEnd = end;
  }

  if (events.length === 0) {
    return { handled: false, reason: 'unrecognized', fallback: 'ai' };
  }

  return { handled: true, events, clarifications, ambiguousFields };
}

function splitClauses(text) {
  // Split on "then", "after that", "and then", "left at", commas, and "and"
  // when immediately followed by a new-activity verb ("and started driving",
  // "and stopped"). Deliberately excludes "and got/woke up" — that phrase is
  // the connector for a same-clause sleep RANGE (parseTimeRange), not a new
  // clause, and a bare "and" is never split (too easy to misfire on plain
  // descriptive text, e.g. "Miami and Fort Lauderdale").
  return text
    .replace(/\bthen\b|\bafter that\b/gi, '|')
    .replace(/,\s*(?=(?:left|fueled|drove|started|stopped|on duty|off duty|driving|sleeper|fuel|pre-trip))/gi, '|')
    .replace(/\band\s+(?=(?:started|left|drove|stopped|resumed|continued|went)\b)/gi, '|')
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