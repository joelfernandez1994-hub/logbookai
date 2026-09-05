// ============================================================================
// LogbookAI — narrative classification (deterministic, no AI).
// Extracted from LogAssistant.jsx so it can be imported without pulling in
// page-level UI components (which touch browser globals at import time) —
// used by the page AND directly unit-testable here.
// ============================================================================

// Detects narratives that describe more than one event/activity and should go
// straight to the AI instead of the deterministic single-intent parser.
export function isMultiEventNarrative(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return false;
  if (/\bdrove\s+from\b/.test(t) || /\bcontinued\s+to\b/.test(t) || /\bcontinued\s+driving\b/.test(t)) return true;
  if (/\brest of (?:the )?day\b/.test(t) || /\bdone for the day\b/.test(t) || /\bend of (?:the )?day\b/.test(t)) return true;
  const hasDriving = /\b(driv|drove|drive)\b/.test(t);
  const hasOtherActivity = /\b(fuel|fueled|load|loaded|unload|unloaded|lunch|post[-\s]?trip|pre[-\s]?trip|sleeper|break|inspection|drop|hook)\b/.test(t);
  if (hasDriving && hasOtherActivity) return true;
  const concepts = ['driving', 'drove', 'fuel', 'fueled', 'load', 'loaded', 'unload', 'unloaded', 'pre-trip', 'pretrip', 'post-trip', 'posttrip', 'sleeper', 'off duty', 'off-duty', 'on duty', 'on-duty', 'lunch', 'break', 'inspection'];
  let distinct = 0;
  for (const c of concepts) if (new RegExp(`\\b${c}\\b`).test(t)) distinct++;
  return distinct >= 2;
}
