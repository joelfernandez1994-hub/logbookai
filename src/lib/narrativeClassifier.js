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
  // Spanish equivalents of the same structural cues.
  if (/\bmanej[eé]\s+desde\b|\bcontinu[eé]\s+(?:hasta|manejando)\b/.test(t)) return true;
  if (/\bresto del d[ií]a\b|\btermin[eé]\s+por\s+(?:hoy|el d[ií]a)\b/.test(t)) return true;
  const hasDriving = /\b(driv|drove|drive|manej|conduc)\b/.test(t);
  const hasOtherActivity = /\b(fuel|fueled|load|loaded|unload|unloaded|lunch|post[-\s]?trip|pre[-\s]?trip|sleeper|break|inspection|drop|hook|combustible|cargu[eé]|descargu[eé]|litera|descanso|inspecci[oó]n)\b/.test(t);
  if (hasDriving && hasOtherActivity) return true;
  const concepts = [
    'driving', 'drove', 'fuel', 'fueled', 'load', 'loaded', 'unload', 'unloaded', 'pre-trip', 'pretrip',
    'post-trip', 'posttrip', 'sleeper', 'off duty', 'off-duty', 'on duty', 'on-duty', 'lunch', 'break', 'inspection',
    // Spanish
    'manejando', 'manej[eé]', 'conduciendo', 'combustible', 'cargu[eé]', 'descargu[eé]', 'litera',
    'fuera de servicio', 'en servicio', 'descanso', 'inspecci[oó]n',
  ];
  let distinct = 0;
  for (const c of concepts) if (new RegExp(`\\b${c}\\b`).test(t)) distinct++;
  return distinct >= 2;
}
