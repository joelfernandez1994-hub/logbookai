// ============================================================================
// LogbookAI — DESCRIBED-MOVEMENT COVERAGE (deterministic, no AI).
// ----------------------------------------------------------------------------
// Prevents an explicitly described driving leg from silently vanishing past
// Confirm & Apply. The AI interpretation occasionally omits a Driving event the
// driver described (e.g. "unloaded in Ocala, then drove to Gainesville,
// post-trip" with no Driving segment). This module extracts the movements the
// driver ACTUALLY described and verifies each has a corresponding DRIVING event
// in the proposed sequence. It never invents a Driving event from a bare city
// difference — it only blocks when the narrative/provenance explicitly
// described that movement.
//
// Detection is two-layered:
//   1. PRIMARY — deterministic regex over the original narrative text.
//   2. BACKSTOP — AI provenance (interpretation summary / location_confirmations)
//      used only when the regex finds nothing, to catch a described city
//      transition the regex missed.
// ============================================================================

function normCity(v) { return String(v == null ? '' : v).trim().toLowerCase(); }
function normState(v) { return String(v == null ? '' : v).trim().toUpperCase(); }

// A "City, ST" or bare "City" string -> { city, state }. Used to split a
// location_confirmation's `interpreted` value (which the backend always
// writes as "City, ST") BEFORE comparing, so a plain state-abbreviation
// enrichment ("Gary" -> "Gary, IN") is never mistaken for a genuine city
// change ("Gary" -> "Chicago"). Comparing the raw strings directly (as this
// module previously did) treats EVERY location_confirmation as a described
// movement, since the interpreted side almost always gains a state suffix.
function splitCityState(v) {
  const s = String(v == null ? '' : v).trim();
  const m = s.match(/^(.*?),\s*([A-Za-z]{2})$/);
  return m ? { city: m[1].trim(), state: m[2].toUpperCase() } : { city: s, state: '' };
}

// Capture a Capitalized city (1–3 words) optionally followed by ", ST". This
// regex is case-SENSITIVE (no `i` flag) so lowercase connectors ("and", "did",
// "for") terminate the match — unlike the trigger regexes below which are
// case-insensitive to catch "Drove"/"DROVE".
const CITY_RE = /^([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,2})(?:,\s*([A-Z]{2}))?\b/;

function captureCityAt(str) {
  const m = String(str || '').match(CITY_RE);
  if (!m) return null;
  return { city: m[1].trim(), state: (m[2] || '').trim() };
}

// Case-insensitive triggers (verbs), used only to LOCATE the movement; the
// city itself is captured case-sensitively via captureCityAt.
const FROM_TRIGGER = /\bdrove\s+from\s+/gi;
const TO_TRIGGER = /\b(?:drove|continued|headed|left|made\s+it)\b(?:\s+(?:driving|for|it|on))?\s+to\s+/gi;

export function extractDescribedMovements(narrative, provenance = {}) {
  const text = String(narrative || '');
  const moves = [];

  if (text) {
    // "drove from <Origin> to <Dest>"
    for (const m of text.matchAll(FROM_TRIGGER)) {
      const afterFrom = text.slice(m.index + m[0].length);
      const origin = captureCityAt(afterFrom);
      if (!origin || !origin.city) continue;
      const originText = origin.city + (origin.state ? ', ' + origin.state : '');
      const originStart = afterFrom.indexOf(originText);
      if (originStart < 0) continue;
      const rest = afterFrom.slice(originStart + originText.length);
      const toMatch = rest.match(/^\s+to\s+/i);
      if (!toMatch) continue;
      const dest = captureCityAt(rest.slice(toMatch[0].length));
      if (dest && dest.city) moves.push({ from: origin, to: dest, evidence: 'regex' });
    }
    // "... to <Dest>" after a driving verb (destination-only)
    const destSeen = new Set(moves.map(mv => normCity(mv.to.city)));
    for (const m of text.matchAll(TO_TRIGGER)) {
      const dest = captureCityAt(text.slice(m.index + m[0].length));
      if (!dest || !dest.city) continue;
      const key = normCity(dest.city);
      if (destSeen.has(key)) continue;
      destSeen.add(key);
      moves.push({ from: null, to: dest, evidence: 'regex' });
    }
  }
  if (moves.length) return moves;

  // BACKSTOP: AI provenance. Only when the regex over the original narrative
  // found nothing — use the AI's own interpretation summary / location
  // confirmations to detect a described city transition.
  const summary = String(provenance.summary || provenance.interpretation || '');
  const sm = summary.match(/\b(?:drove|driving|continued|headed)\b[^.]*?\bto\s+/i);
  if (sm) {
    const dest = captureCityAt(summary.slice(sm.index + sm[0].length));
    if (dest && dest.city) moves.push({ from: null, to: dest, evidence: 'ai_provenance' });
  }
  // Compare CITY ONLY (state stripped from both sides) so a plain state
  // enrichment ("Gary" -> "Gary, IN") is never mistaken for a genuine
  // destination change ("Gary" -> "Chicago, IL") — every location_confirmation
  // gains a state suffix by design, so comparing the raw strings previously
  // flagged EVERY confirmed location as a "described movement."
  const confirms = Array.isArray(provenance.location_confirmations) ? provenance.location_confirmations : [];
  for (const c of confirms) {
    const oRaw = String((c && c.original) || ''), intrRaw = String((c && c.interpreted) || '');
    if (!oRaw || !intrRaw) continue;
    const o = splitCityState(oRaw), intr = splitCityState(intrRaw);
    if (normCity(o.city) === normCity(intr.city)) continue; // same city, state merely added — not a movement
    moves.push({ from: null, to: { city: intr.city, state: intr.state }, evidence: 'ai_provenance' });
  }
  return moves;
}

function locMatch(eventCity, eventState, target) {
  if (!target || !target.city) return false;
  if (normCity(eventCity) !== normCity(target.city)) return false;
  if (target.state && normState(eventState) !== normState(target.state)) return false;
  return true;
}

// Is a single described movement covered by a DRIVING event in the proposed
// sequence? A DRIVING event bridges A→B when it is immediately followed by an
// event at B (the destination). If `from` is null (only the destination was
// described), any DRIVING followed by an event at B counts.
//
// An ongoing, trailing DRIVING event (no end_timestamp, nothing after it) has
// no "next" event to check — by design, since the driver hasn't arrived
// anywhere yet. If the described "destination" is just that Driving event's
// own current/starting city (e.g. an AI location confirmation that only
// canonicalized "Miami" to "Miami, FL", not a genuinely different place the
// driver said they were headed), treat it as covered: the driver described
// driving, and an open Driving event with no further destination IS that
// description — it doesn't need to prove arrival somewhere else.
export function movementCovered(proposed, movement) {
  if (!movement || !movement.to || !movement.to.city) return true;
  const sorted = [...(proposed || [])]
    .filter(p => p && p.start_timestamp)
    .sort((a, b) => new Date(a.start_timestamp) - new Date(b.start_timestamp));
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].duty_status !== 'DRIVING') continue;
    const next = sorted[i + 1];
    if (!next) {
      if (!sorted[i].end_timestamp && locMatch(sorted[i].city, sorted[i].state, movement.to)) return true;
      continue;
    }
    if (!locMatch(next.city, next.state, movement.to)) continue;
    if (movement.from && movement.from.city) {
      const prev = sorted[i - 1];
      const originMatch = locMatch(sorted[i].city, sorted[i].state, movement.from)
        || (prev && locMatch(prev.city, prev.state, movement.from));
      if (!originMatch) continue;
    }
    return true;
  }
  return false;
}

// Returns blocking warnings for every described movement the proposal fails to
// cover. Consumed by validateProposal so ProposalReview's Confirm & Apply stays
// disabled until the driver adds the missing Driving event. movementCovered()
// (above) already reconstructs each leg from the PREVIOUS meaningful
// (non-Driving) location -> the Driving interval -> the NEXT meaningful
// status-change location — it never requires both cities to sit on the
// Driving event itself (a Driving event conventionally carries only its
// ORIGIN city; the destination lives on the following non-Driving event).
// This intentionally still never blocks on a bare city difference alone —
// only when the narrative/provenance actually described that movement.
export function describedMovementCoverage(proposed, narrative, provenance = {}) {
  // A stationary full-day/night status (deterministic stationaryDayRule) treats
  // its location as a STATIONARY EVENT location, never a travel destination —
  // emit zero movement warnings regardless of any provenance backstop content.
  // This is a specific stationary rule, NOT a weakening of movement validation:
  // genuine travel narratives never reach here with the stationary flag.
  if ((proposed || []).some(p => p && p.stationary)) return [];
  const moves = extractDescribedMovements(narrative, provenance);
  const warnings = [];
  for (const m of moves) {
    if (movementCovered(proposed, m)) continue;
    const label = m.from && m.from.city
      ? `${m.from.city}${m.from.state ? ', ' + m.from.state : ''} → ${m.to.city}${m.to.state ? ', ' + m.to.state : ''}`
      : `${m.to.city}${m.to.state ? ', ' + m.to.state : ''}`;
    warnings.push({
      type: 'described_movement_missing',
      severity: 'blocking',
      title: 'DESCRIBED DRIVING MISSING',
      message: `You described driving to ${label}, but no Driving event connects to it in this proposal. Add the missing Driving event (or edit the proposal) before confirming.`,
      hint: `Evidence: ${m.evidence === 'regex' ? 'your narrative' : 'AI interpretation'}. LogbookAI will not invent a Driving event — add the actual drive you performed.`,
      movement: m,
    });
  }
  return warnings;
}