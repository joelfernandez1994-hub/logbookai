// ============================================================================
// LogbookAI — SHARED GPS + reverse-geocoding service.
// ----------------------------------------------------------------------------
// The single location resolver used by Change Duty Status, Add Event, Edit
// Event, and anywhere else that needs "use my current location". Do NOT
// re-implement geolocation or call the reverseGeocode backend directly from a
// component — import resolveCurrentLocation / normalizeState here so every
// caller standardizes to "City, ST" (e.g. "Homestead, FL").
// ============================================================================

import { base44 } from '@/api/base44Client';

// Full state name -> 2-letter USPS abbreviation. Nominatim returns full names
// ("Florida"), so a naive slice(0,2) would yield "FL" for Florida but "TE" for
// Texas. This map is the correct, exhaustive normalization.
const STATE_NAME_TO_ABBR = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', 'district of columbia': 'DC',
  florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL',
  indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA',
  maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
  mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR',
  pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD',
  tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA',
  'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
};

// Normalize any state value (full name, abbreviation, or malformed) to a
// 2-letter uppercase USPS code. Returns '' when it cannot be resolved.
export function normalizeState(value) {
  if (!value) return '';
  const v = String(value).trim();
  if (!v) return '';
  if (/^[A-Za-z]{2}$/.test(v)) return v.toUpperCase();
  const key = v.toLowerCase();
  if (STATE_NAME_TO_ABBR[key]) return STATE_NAME_TO_ABBR[key];
  // Unknown full name — fall back to the first two letters uppercased so the
  // field is never left blank, but callers should treat this as review-needed.
  return v.slice(0, 2).toUpperCase();
}

// Resolve the device's current location to { city, state } with state
// standardized to a 2-letter abbreviation. Returns { city, state, error? }.
// On any failure returns { error } so the caller can show a manual-entry hint.
export async function resolveCurrentLocation({ timeout = 10000 } = {}) {
  if (typeof navigator === 'undefined' || !navigator?.geolocation) {
    return { error: 'Coordinates unavailable: location services are not available on this device.' };
  }
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(async (pos) => {
      const latitude = pos?.coords?.latitude;
      const longitude = pos?.coords?.longitude;
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        resolve({ city: '', state: '', error: 'Coordinates unavailable: the device did not return a valid position.' });
        return;
      }
      try {
        const res = await base44.functions.invoke('reverseGeocode', { latitude, longitude });
        const data = res?.data || res || {};
        if (data.error) {
          resolve({ city: '', state: '', error: `Reverse-geocoding failure: ${data.error}` });
          return;
        }
        const city = (data.city || data.town || data.village || '').trim();
        const state = normalizeState(data.state || data.region || '');
        if (!city || !state) {
          resolve({ city: '', state: '', error: 'Reverse-geocoding failure: city and state were not found for these coordinates.' });
          return;
        }
        resolve({ city, state, latitude, longitude, error: null });
      } catch (e) {
        const detail = e?.response?.data?.error || e?.message || '';
        const isReverseFailure = !!e?.response;
        resolve({
          city: '', state: '',
          error: isReverseFailure
            ? `Reverse-geocoding failure: ${detail || 'the location service rejected the request.'}`
            : `Network error while resolving location${detail ? `: ${detail}` : '.'}`,
        });
      }
    }, (error) => {
      if (error?.code === 1) resolve({ city: '', state: '', error: 'Location permission denied. Enable location access and try again.' });
      else if (error?.code === 2) resolve({ city: '', state: '', error: 'Coordinates unavailable: the device could not determine its position.' });
      else if (error?.code === 3) resolve({ city: '', state: '', error: 'Coordinates unavailable: location lookup timed out.' });
      else resolve({ city: '', state: '', error: `Coordinates unavailable${error?.message ? `: ${error.message}` : '.'}` });
    }, { enableHighAccuracy: true, timeout, maximumAge: 30000 });
  });
}