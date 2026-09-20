// ============================================================================
// LogbookAI — AMBIGUOUS CITY GUARD (deterministic, no AI, no network).
// ----------------------------------------------------------------------------
// Real-driver bug class: a city name that exists in several US states
// ("Springfield", "Columbia", "Kansas City", ...) is spoken WITHOUT a state
// ("I drove from Springfield to Columbia"). The AI prompt's completeness-first
// inference used to be free to silently pick a state, and the routing layer
// (Nominatim, limit=1) then geocodes whichever place ranks first — so the log,
// the mileage and the route-time check all quietly describe the WRONG trip.
//
// This module flags any proposed event whose city is on the curated
// multi-state list AND whose state is not established by:
//   1. the driver's own words (an explicit "City, ST" / "City ST" / "City,
//      Illinois" mention in the narrative), OR
//   2. context — another event (proposed or already logged) with an explicit
//      state where that neighbor's city is itself unambiguous, and the
//      ambiguous event carries that same state.
// A state the model merely marked "inferred" with no such support does NOT
// count. The caller surfaces a BLOCKING "which state?" warning so the driver
// picks — LogbookAI never chooses for them.
//
// Deliberately CURATED, not exhaustive: only names where no single state
// dominates. Unique-dominant cities (Miami, Orlando, Dallas, Houston, ...) are
// intentionally absent so a bare "Miami" still resolves without a question.
// ============================================================================
import { US_STATE_TO_CODE } from './usStates';

export const AMBIGUOUS_CITY_NAMES = new Set([
  'springfield', 'columbia', 'portland', 'charleston', 'columbus', 'jackson', 'kansas city',
  'jacksonville', 'lexington', 'richmond', 'greenville', 'salem', 'wilmington', 'aurora',
  'peoria', 'glendale', 'lancaster', 'franklin', 'clinton', 'lincoln', 'manchester', 'newark',
  'athens', 'alexandria', 'arlington', 'auburn', 'bristol', 'dover', 'florence', 'marion',
  'monroe', 'newport', 'oxford', 'rochester', 'washington', 'georgetown', 'hamilton', 'milford',
  'burlington', 'union', 'fairview', 'homestead', 'madison', 'cleveland', 'birmingham',
  'riverside', 'centerville', 'chester', 'mount vernon', 'princeton', 'shelby', 'troy',
]);

const VALID_CODES = new Set(Object.values(US_STATE_TO_CODE));
const norm = (v) => String(v == null ? '' : v).trim().toLowerCase().replace(/\s+/g, ' ');
const stateCode = (v) => {
  const s = String(v == null ? '' : v).trim().toUpperCase();
  if (!s) return '';
  if (US_STATE_TO_CODE[s]) return US_STATE_TO_CODE[s];
  return VALID_CODES.has(s) ? s : '';
};

export function isAmbiguousCityName(city) {
  return AMBIGUOUS_CITY_NAMES.has(norm(city));
}

// Did the driver's own narrative pin this city to a state? Matches
// "Springfield, IL", "Springfield IL", "Springfield, Illinois",
// "Springfield Illinois" (case-insensitive on the city).
export function narrativeStatesCity(narrative, city) {
  const text = String(narrative || '');
  const c = String(city || '').trim();
  if (!text || !c) return false;
  const esc = c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  const re = new RegExp(`\\b${esc}\\b\\s*,?\\s*([A-Za-z]{2}(?![A-Za-z])|[A-Za-z]+(?:\\s+[A-Za-z]+)?)`, 'gi');
  for (const m of text.matchAll(re)) {
    const tail = m[1].trim();
    // Two-letter token must be UPPER in the source to count as a state code
    // ("in" / "to" / "at" are not states); a full state name may be any case.
    if (/^[A-Za-z]{2}$/.test(tail)) {
      if (tail === tail.toUpperCase() && stateCode(tail)) return true;
      continue;
    }
    if (US_STATE_TO_CODE[tail.toUpperCase()]) return true;
    const first = tail.split(/\s+/)[0];
    if (US_STATE_TO_CODE[first.toUpperCase()]) return true;
  }
  return false;
}

function contextSupportsState(ev, others) {
  const st = stateCode(ev.state);
  if (!st) return false;
  return (others || []).some((o) => o && o !== ev
    && o.city && !isAmbiguousCityName(o.city)
    && stateCode(o.state) === st
    && (!o.field_provenance || o.field_provenance.state !== 'inferred'));
}

// Returns [{ city, state, eventIndex, reason }] — one entry per distinct
// ambiguous city that lacks a supported state.
export function findAmbiguousCityIssues(proposed, existing = [], narrative = '') {
  const events = proposed || [];
  const context = [...(existing || []), ...events];
  const seen = new Set();
  const issues = [];
  events.forEach((ev, idx) => {
    if (!ev || !ev.city || !isAmbiguousCityName(ev.city)) return;
    const key = norm(ev.city);
    if (seen.has(key)) return;
    if (narrativeStatesCity(narrative, ev.city)) return;
    const st = stateCode(ev.state);
    const explicitState = st && ev.field_provenance && ev.field_provenance.state === 'explicit';
    // An "explicit" state is only trusted if the narrative actually states it
    // (the model can mislabel provenance); with no narrative available
    // (re-validation of an already-reviewed proposal) fall back to the flag.
    if (explicitState && !narrative) return;
    if (st && contextSupportsState(ev, context)) return;
    seen.add(key);
    issues.push({
      city: ev.city,
      state: st,
      eventIndex: idx,
      reason: st
        ? `"${ev.city}" exists in several states and "${st}" was not stated by you.`
        : `"${ev.city}" exists in several states and no state was given.`,
    });
  });
  return issues;
}
