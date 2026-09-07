// ============================================================================
// LogbookAI — EVENT REFERENCE RESOLUTION (deterministic, no AI).
// ----------------------------------------------------------------------------
// Resolves a natural-language reference to an existing logged event, so a
// driver can correct/delete something WITHOUT restating the whole day:
//   "change my last fuel stop to 8:15"
//   "the second fuel stop"
//   "that was Jacksonville, not Orlando"     (falls back to "the last event")
//   "delete the second fuel stop"
//   "the 4 PM stop"
// This module NEVER guesses when genuinely ambiguous — it returns enough
// information (candidates, ambiguous flag) for the caller to ask the driver
// which event, rather than silently picking the wrong one. It never mutates
// anything; it only identifies which existing event a reference is about.
// ============================================================================

const ORDINAL_WORDS = {
  first: 0, '1st': 0, primera: 0, primer: 0,
  second: 1, '2nd': 1, segunda: 1, segundo: 1,
  third: 2, '3rd': 2, tercera: 2, tercero: 2,
  fourth: 3, '4th': 3, cuarta: 3, cuarto: 3,
  fifth: 4, '5th': 4, quinta: 4, quinto: 4,
};

// Activity keyword -> matcher against an event's duty_status/activity_type/
// remark. Bilingual (English + Spanish) so a reference resolves the same way
// regardless of which language the driver used to originally describe it or
// is now using to refer back to it.
const ACTIVITY_MATCHERS = [
  { key: 'fuel', re: /\bfuel|combustible|gas(?:olina)?\b/i, test: (e) => /fuel|combustible/i.test(`${e.activity_type || ''} ${e.remark || ''}`) },
  { key: 'pretrip', re: /\bpre[-\s]?trip\b/i, test: (e) => /pre.?trip/i.test(`${e.activity_type || ''} ${e.remark || ''}`) },
  { key: 'posttrip', re: /\bpost[-\s]?trip\b/i, test: (e) => /post.?trip/i.test(`${e.activity_type || ''} ${e.remark || ''}`) },
  { key: 'break', re: /\b30\b|\bbreak\b|descanso\b/i, test: (e) => /30.?min|break|descanso/i.test(`${e.activity_type || ''} ${e.remark || ''}`) },
  { key: 'unloading', re: /\bunload(?:ing)?\b|descarga/i, test: (e) => /unload|descarg/i.test(`${e.activity_type || ''} ${e.remark || ''}`) },
  { key: 'loading', re: /\bload(?:ing)?\b|\bcarga\b/i, test: (e) => /^load|\bloading\b|\bcarga\b/i.test(`${e.activity_type || ''} ${e.remark || ''}`) && !/unload|descarg/i.test(`${e.activity_type || ''} ${e.remark || ''}`) },
  { key: 'sleeper', re: /\bsleeper\b|\blitera\b/i, test: (e) => e.duty_status === 'SLEEPER_BERTH' },
  { key: 'off_duty', re: /\boff[-\s]?duty\b|fuera de servicio/i, test: (e) => e.duty_status === 'OFF_DUTY' },
  { key: 'driving', re: /\bdriving\b|\bdrove\b|manej/i, test: (e) => e.duty_status === 'DRIVING' },
];

function detectActivityKeyword(text) {
  for (const m of ACTIVITY_MATCHERS) if (m.re.test(text)) return m;
  return null;
}

function detectOrdinal(text) {
  const lower = text.toLowerCase();
  if (/\blast\b|\búltima?\b/.test(lower) && !/second to last|next to last/.test(lower)) return 'last';
  for (const [word, idx] of Object.entries(ORDINAL_WORDS)) {
    if (new RegExp(`\\b${word}\\b`, 'i').test(lower)) return idx;
  }
  return null;
}

// A bare time mention used to pick the closest matching event, e.g.
// "the 4 PM stop". Reuses the same tolerant token shape as voiceParser.
function detectTimeMention(text) {
  const m = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?\b/i);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  if (h > 23 || min > 59) return null;
  if (m[3]) {
    const pm = /^p/i.test(m[3].replace(/\./g, ''));
    h = h % 12 + (pm ? 12 : 0);
  }
  return { h, min, explicitMeridian: !!m[3] };
}

function localClock(iso, tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz || 'UTC', hour12: false, hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(iso));
    const map = {};
    parts.forEach((p) => { if (p.type !== 'literal') map[p.type] = p.value; });
    return { h: Number(map.hour) % 24, min: Number(map.minute) };
  } catch {
    return null;
  }
}

function minutesOfDay(h, min) { return h * 60 + min; }

// Short human-readable label for a clarification question or confirmation.
export function describeEvent(e, tz) {
  const clock = e.start_timestamp ? localClock(e.start_timestamp, tz) : null;
  const time = clock ? new Date(0, 0, 0, clock.h, clock.min).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '';
  const label = e.activity_type || e.remark || (e.duty_status || '').replace('_', ' ');
  const loc = [e.city, e.state].filter(Boolean).join(', ');
  return [time, label, loc].filter(Boolean).join(' — ');
}

// Finds the most recent event whose city matches `city` (case-insensitive).
// Used for corrections like "that was Jacksonville, not Orlando" — resolves
// against the WRONG value ("Orlando") to find precisely which logged event
// needs the fix, rather than guessing from recency alone.
export function findEventByCity(events, city) {
  const needle = String(city || '').trim().toLowerCase();
  if (!needle) return null;
  const matches = (events || [])
    .filter((e) => e && e.start_timestamp && String(e.city || '').trim().toLowerCase() === needle)
    .sort((a, b) => new Date(a.start_timestamp) - new Date(b.start_timestamp));
  return matches[matches.length - 1] || null;
}

// Resolve `referenceText` against `events` (chronologically ordered, most
// recent last). Returns:
//   { candidates, activityKey, ordinal, resolved, ambiguous, reason }
// `resolved` is the single best-guess event (or null); `ambiguous` is true
// when more than one candidate remains AND no ordinal/time narrowed it down —
// callers should ask the driver in that case rather than silently applying
// the guess.
export function resolveEventReference(events, referenceText, opts = {}) {
  const tz = opts.tz || 'UTC';
  const all = (events || [])
    .filter((e) => e && e.start_timestamp)
    .slice()
    .sort((a, b) => new Date(a.start_timestamp) - new Date(b.start_timestamp));

  const text = String(referenceText || '');
  const activityMatcher = detectActivityKeyword(text);
  const ordinal = detectOrdinal(text);
  const timeMention = detectTimeMention(text);

  let pool = activityMatcher ? all.filter((e) => activityMatcher.test(e)) : all.slice();

  if (!pool.length) {
    return { candidates: [], activityKey: activityMatcher?.key || null, ordinal, resolved: null, ambiguous: false, reason: 'no_matching_events' };
  }

  // Ordinal narrows first — "last" = most recent, "second" = pool[1], etc.
  if (ordinal === 'last') {
    return { candidates: pool, activityKey: activityMatcher?.key || null, ordinal, resolved: pool[pool.length - 1], ambiguous: false, reason: 'ordinal_last' };
  }
  if (typeof ordinal === 'number') {
    const picked = pool[ordinal];
    return { candidates: pool, activityKey: activityMatcher?.key || null, ordinal, resolved: picked || null, ambiguous: false, reason: picked ? 'ordinal_index' : 'ordinal_out_of_range' };
  }

  // A time mention narrows to the closest matching event by local clock time.
  if (timeMention) {
    const target = minutesOfDay(timeMention.h, timeMention.min);
    let best = null; let bestDist = Infinity;
    for (const e of pool) {
      const clock = localClock(e.start_timestamp, tz);
      if (!clock) continue;
      const dist = Math.abs(minutesOfDay(clock.h, clock.min) - target);
      if (dist < bestDist) { bestDist = dist; best = e; }
    }
    if (best && bestDist <= 90) {
      return { candidates: pool, activityKey: activityMatcher?.key || null, ordinal, resolved: best, ambiguous: false, reason: 'time_match' };
    }
  }

  // No ordinal/time narrowing: default to the most recent match (the common
  // real-world meaning of "the fuel stop"/"that"), but flag ambiguous when
  // more than one candidate exists so the caller can choose to confirm.
  return {
    candidates: pool,
    activityKey: activityMatcher?.key || null,
    ordinal,
    resolved: pool[pool.length - 1],
    ambiguous: pool.length > 1,
    reason: pool.length > 1 ? 'defaulted_to_most_recent' : 'single_match',
  };
}
