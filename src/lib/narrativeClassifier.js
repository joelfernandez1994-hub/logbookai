// ============================================================================
// LogbookAI — narrative classification (deterministic, no AI).
// Extracted from LogAssistant.jsx so it can be imported without pulling in
// page-level UI components (which touch browser globals at import time) —
// used by the page AND directly unit-testable here.
// ============================================================================

// Words that can follow from/to/into/toward/in/at WITHOUT being a place — a
// clock time, a status or a common activity object ("to sleeper", "to bed",
// "from 8 to 11", "at the dock"). Anything else after a movement cue is treated
// as a place name.
const NOT_A_PLACE = '(?:\\d|one\\b|two\\b|three\\b|four\\b|five\\b|six\\b|seven\\b|eight\\b|nine\\b|ten\\b|half\\b|noon\\b|midnight\\b|about\\b|around\\b|now\\b|it\\b|then\\b|sleeper\\b|sleep\\b|bed\\b|driving\\b|drive\\b|duty\\b|off\\b|on\\b|work\\b|lunch\\b|dinner\\b|break\\b|rest\\b|the\\b|a\\b|an\\b|my\\b|this\\b|that\\b|today\\b|tonight\\b|home\\b|the\\s+(?:dock|scale|scales|shop|yard))';

// A travel narrative: the driver names where they came FROM / went TO / arrived
// ("left Atlanta ... headed to Nashville", "got to Orlando at 9", "arrived in
// Las Vegas", "started driving at 8 from Miami", "got there around noon").
// The deterministic single-intent parser cannot represent an origin, a
// destination or an arrival time — it silently kept ONE status + ONE time and
// dropped the rest ("Left Miami at 8 AM and got to Orlando at 9 AM" became one
// open-ended Driving event with no cities, so the impossible 1-hour Miami→
// Orlando trip was never route-checked; "left LA at 6 and arrived in Las Vegas
// at 11" stamped Las Vegas on the DEPARTURE). Such narratives must go to the AI
// + route validation so every stated fact is either kept or surfaced.
export function isTravelNarrative(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return false;
  // Deictic destination ("got there", "drove there") — a place with no name.
  if (/\b(?:got|get|getting|drove|drive|driving|ran|run|went|go|going|headed|heading|made it|pulled in)\s+there\b/.test(t)) return true;
  // Arrival in a named place.
  if (new RegExp(`\\b(?:arrived|arrive|arriving|got in|pulled in|pulled into|made it)\\s+(?:in|at|into|to)\\s+(?!${NOT_A_PLACE})[a-z]`).test(t)) return true;
  // Movement verb + preposition + place (origin or destination).
  if (new RegExp(`\\b(?:left|leave|leaving|headed|heading|drove|drive|driving|ran|run|running|rolled|rolling|went|go|going|got|get|came|come|moved)\\b[^.;!?]{0,40}?\\b(?:from|to|into|toward|towards|for)\\s+(?!${NOT_A_PLACE})[a-z]`).test(t)) return true;
  // "left <Place>" with no preposition.
  if (new RegExp(`\\b(?:left|leaving)\\s+(?!(?:at|around|about|by|early|late|on|for|out|here|home)\\b)(?!${NOT_A_PLACE})[a-z]{3,}`).test(t)) return true;
  return false;
}

// "here" / "this location" as a PLACE ("I loaded here at 8"). The app has no
// confirmed device location in the Tell flow, so "here" can never be resolved
// to a city — callers must ask instead of leaving a silent blank or a guess.
export function referencesHere(text) {
  return /\b(?:here|this (?:location|spot|place)|my (?:current )?location|current location)\b/i.test(String(text || ''))
    && !/\bhere(?:'s|\s+is)\b/i.test(String(text || ''));
}

// Detects narratives that describe more than one event/activity and should go
// straight to the AI instead of the deterministic single-intent parser.
export function isMultiEventNarrative(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return false;
  if (isTravelNarrative(text)) return true;
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
