// ============================================================================
// LogbookAI — placeholder location text (pure).
// ----------------------------------------------------------------------------
// The AI's strict output schema makes `city`/`state` required strings, so when
// a location is genuinely unknown the live model sometimes writes a literal
// placeholder ("Unknown", "N/A") instead of the empty string the prompt asks
// for (seen live: "I loaded here at 8" -> city "Unknown", state "Unknown").
// A placeholder is NOT a place: left in, it would be logged as "Unknown,
// Unknown", treated as a usable route endpoint, and hide the missing-location
// state from the review. Every AI-supplied city/state goes through here.
// ============================================================================

const PLACEHOLDER = /^(?:unknown|unk|n\/?a|none|null|undefined|unspecified|not specified|not provided|tbd|tba|\?+|[-–—]+)$/i;

export function isPlaceholderLocation(value) {
  const s = String(value == null ? '' : value).trim();
  if (!s) return false;
  // "Unknown, Unknown" / "N/A, N/A" written into a single field.
  return s.split(/\s*,\s*/).every((part) => PLACEHOLDER.test(part));
}

// '' for empty or placeholder text; otherwise the trimmed text unchanged.
export function cleanLocationText(value) {
  const s = String(value == null ? '' : value).trim();
  return isPlaceholderLocation(s) ? '' : s;
}
