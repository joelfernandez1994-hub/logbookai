// ============================================================================
// LogbookAI — DETERMINISTIC ROUTE-FEASIBILITY QUESTIONS ("Can I make it to
// Atlanta tonight?"). No AI call, no log changes — a pure planning answer.
// ----------------------------------------------------------------------------
// Combines:
//   - current location (driver profile / last logged event)
//   - REAL road route/mileage (the same tripEstimate-backed fetchRoute used
//     by Trip Planner and route reasonableness checks — never LLM-guessed
//     mileage)
//   - the driver's ACTUAL current HOS availability (deterministic hosEngine
//     output, via the same earliestLegalEta simulator the "Future Plan" tab
//     already uses)
// to answer a feasibility question directly, for free, without touching the
// duty-status timeline. This is a QUESTION, never a proposal — nothing here
// is ever applied to the log.
// ============================================================================

// Matches "can I make it to Atlanta", "will I make it to Atlanta tonight",
// "can I get to Dallas by 8", "can I reach Houston today". Bilingual.
const FEASIBILITY_RE = /\b(?:can|could|will)\s+i\s+(?:make\s+it|get|arrive|reach)\s+(?:to|in)\s+([a-zA-Z][a-zA-Z .'-]*?)(?:,\s*([a-zA-Z]{2}))?\s*(?:\btonight\b|\btoday\b|\bby\b|\bbefore\b|[.?!]|$)/i;
const FEASIBILITY_RE_ES = /\b(?:puedo|podr[ée]|llegar[ée]?)\s+(?:llegar\s+)?(?:a|hasta)\s+([a-zA-Z][a-zA-Z .'-]*?)(?:,\s*([a-zA-Z]{2}))?\s*(?:\besta\s+noche\b|\bhoy\b|[.?!]|$)/i;

export function detectFeasibilityQuestion(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const m = raw.match(FEASIBILITY_RE) || raw.match(FEASIBILITY_RE_ES);
  if (!m) return null;
  const city = m[1].trim().replace(/\s+/g, ' ');
  // Reject a match that's really just a status/junk phrase, or too short to
  // plausibly be a city name.
  if (city.length < 3 || /^(there|here|home|work)$/i.test(city)) return null;
  return { city, state: (m[2] || '').toUpperCase() };
}

function fmtHM(hours) {
  if (hours == null || !Number.isFinite(hours)) return '--';
  const totalMin = Math.round(hours * 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h === 0 ? `${m} min` : (m === 0 ? `${h} hr` : `${h} hr ${m} min`);
}

// { text, currentLocation: {city,state}, hos, now, fetchRouteFn, truckEtaHoursFn,
//   earliestLegalEtaFn, isSpanish } -> { handled, answer } | { handled: false }
// `handled: false` means the caller should fall back to Ask LogbookAI (AI) —
// e.g. the destination couldn't be confidently parsed, or the current
// location is unknown, or the road route couldn't be resolved.
export async function answerFeasibilityQuestion(text, {
  currentLocation, hos, now = new Date(), fetchRouteFn, truckEtaHoursFn, earliestLegalEtaFn, isSpanish = false,
} = {}) {
  const dest = detectFeasibilityQuestion(text);
  if (!dest) return { handled: false, reason: 'not_a_feasibility_question' };
  if (!currentLocation?.city) return { handled: false, reason: 'no_current_location' };
  if (!hos?.calculable) return { handled: false, reason: 'hos_not_calculable' };

  const origin = `${currentLocation.city}, ${currentLocation.state || ''}`.trim();
  const destination = `${dest.city}${dest.state ? ', ' + dest.state : ''}`;
  let route = null;
  try { route = await fetchRouteFn(origin, destination); } catch { route = null; }
  if (!route || !Number.isFinite(route.miles)) return { handled: false, reason: 'route_unavailable' };

  const driveHours = truckEtaHoursFn(route);
  if (!Number.isFinite(driveHours)) return { handled: false, reason: 'no_drive_time' };

  const legal = earliestLegalEtaFn(hos, driveHours * 3600000, now);
  if (!legal?.eta) return { handled: false, reason: 'eta_not_calculable' };

  const restStops = (legal.segments || []).filter((s) => s.type !== 'drive').length;
  const etaLocal = legal.eta.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const milesTxt = Math.round(route.miles);

  const en = restStops === 0
    ? `Yes — ${destination} is about ${milesTxt} mi / ${fmtHM(driveHours)} of driving from ${origin}, and your current HOS covers it without a required rest. Estimated arrival around ${etaLocal}.`
    : `Not without a required rest stop first: ${destination} is about ${milesTxt} mi / ${fmtHM(driveHours)} of driving from ${origin}, which exceeds your currently available hours. Earliest legally compliant arrival, including required rest, is around ${etaLocal}.`;
  const es = restStops === 0
    ? `Sí — ${destination} está a unas ${milesTxt} mi / ${fmtHM(driveHours)} de manejo desde ${origin}, y sus horas de servicio actuales lo permiten sin descanso obligatorio. Llegada estimada alrededor de las ${etaLocal}.`
    : `No sin un descanso obligatorio primero: ${destination} está a unas ${milesTxt} mi / ${fmtHM(driveHours)} de manejo desde ${origin}, lo cual excede sus horas disponibles actuales. La llegada legal más temprana, incluyendo el descanso requerido, es alrededor de las ${etaLocal}.`;

  return {
    handled: true,
    answer: isSpanish ? es : en,
    destination, origin, miles: route.miles, driveHours, eta: legal.eta, requiresRest: restStops > 0,
  };
}
