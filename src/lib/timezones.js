// ============================================================================
// LogbookAI — Shared timezone helpers (display + suggestion only).
// ----------------------------------------------------------------------------
// The single source of truth for the log timezone is CarrierProfile.
// home_terminal_timezone (an IANA string). These helpers provide:
//   - friendly dropdown options (labels) mapped to IANA strings
//   - label + short code for the timezone indicator
//   - a state -> default IANA *suggestion* (never authoritative; some states
//     span multiple zones and intentionally return null so the driver chooses)
//
// DST correctness is guaranteed because we store IANA zones (America/New_York,
// America/Phoenix, ...), never EST/CST/MST/PST abbreviations.
// ============================================================================

// Friendly dropdown options. `value` is the IANA string that gets stored.
export const TIMEZONE_OPTIONS = [
  { value: 'America/New_York', label: 'Eastern Time', short: 'ET' },
  { value: 'America/Chicago', label: 'Central Time', short: 'CT' },
  { value: 'America/Denver', label: 'Mountain Time', short: 'MT' },
  { value: 'America/Los_Angeles', label: 'Pacific Time', short: 'PT' },
  { value: 'America/Anchorage', label: 'Alaska Time', short: 'AKT' },
  { value: 'Pacific/Honolulu', label: 'Hawaii Time', short: 'HST' },
  { value: 'America/Phoenix', label: 'Arizona Time (no DST)', short: 'AZT' },
];

const BY_IANA = Object.fromEntries(TIMEZONE_OPTIONS.map((o) => [o.value, o]));

// State -> default IANA suggestion. States that span multiple zones are
// intentionally absent so the driver must pick a city or choose manually.
const STATE_SUGGESTION = {
  FL: 'America/New_York', GA: 'America/New_York', NY: 'America/New_York',
  NC: 'America/New_York', SC: 'America/New_York', OH: 'America/New_York',
  PA: 'America/New_York', VA: 'America/New_York', WV: 'America/New_York',
  ME: 'America/New_York', MA: 'America/New_York', RI: 'America/New_York',
  NH: 'America/New_York', VT: 'America/New_York', CT: 'America/New_York',
  DE: 'America/New_York', NJ: 'America/New_York', MD: 'America/New_York',
  DC: 'America/New_York',
  IL: 'America/Chicago', MO: 'America/Chicago', MN: 'America/Chicago',
  WI: 'America/Chicago', IA: 'America/Chicago', MI: 'America/Chicago',
  AL: 'America/Chicago', MS: 'America/Chicago', LA: 'America/Chicago',
  AR: 'America/Chicago', OK: 'America/Chicago',
  CO: 'America/Denver', MT: 'America/Denver', WY: 'America/Denver',
  UT: 'America/Denver', NM: 'America/Denver',
  CA: 'America/Los_Angeles', WA: 'America/Los_Angeles',
  NV: 'America/Los_Angeles',
  AK: 'America/Anchorage',
  HI: 'Pacific/Honolulu',
  AZ: 'America/Phoenix',
};

// States known to span multiple time zones — no state-level default.
export const MULTI_ZONE_STATES = new Set([
  'TX', 'IN', 'TN', 'KY', 'ND', 'SD', 'NE', 'KS', 'ID', 'OR', 'FL',
]);

export function labelForIana(iana) {
  return (BY_IANA[iana] || {}).label || (iana || '').replace(/_/g, ' ');
}

export function shortForIana(iana) {
  return (BY_IANA[iana] || {}).short || '';
}

// The subtle indicator line text, e.g. "Eastern Time (ET)".
export function indicatorText(iana) {
  const label = labelForIana(iana);
  const short = shortForIana(iana);
  return short ? `${label} (${short})` : label;
}

// Wall-clock <-> absolute timestamp conversion in a given IANA timezone.
// Used so manually entered times are interpreted in the LOG timezone, not
// the driver's browser timezone. Returns ISO UTC strings (absolute moments).
function tzOffsetMs(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(date);
  const map = {}; parts.forEach((p) => { if (p.type !== 'literal') map[p.type] = p.value; });
  let h = Number(map.hour); if (map.hour === '24') h = 0;
  return Date.UTC(Number(map.year), Number(map.month) - 1, Number(map.day), h, Number(map.minute), Number(map.second)) - date.getTime();
}

export function wallTimeToIso(localIso, timezone) {
  if (!localIso) return null;
  const m = String(localIso).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const wallUtc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] || 0));
  let instant = wallUtc;
  for (let i = 0; i < 2; i++) instant = wallUtc - tzOffsetMs(new Date(instant), timezone);
  return new Date(instant).toISOString();
}

export function isoToWallTime(iso, timezone) {
  if (!iso) return '';
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(d);
  const map = {}; parts.forEach((p) => { if (p.type !== 'literal') map[p.type] = p.value; });
  let h = map.hour; if (h === '24') h = '00';
  return `${map.year}-${map.month}-${map.day}T${h}:${map.minute}`;
}

// Suggestion only — returns an IANA string or null (multi-zone / unknown).
// A city-level timezone (from autocomplete) always wins over this.
export function suggestForState(state) {
  const s = String(state || '').trim().toUpperCase();
  if (!s || MULTI_ZONE_STATES.has(s)) return null;
  return STATE_SUGGESTION[s] || null;
}