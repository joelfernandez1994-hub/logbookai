const text = `I was off duty in Gary until about 5:45 this morning. I did my pretrip and rolled out around 6.

I stopped in Joliet around 8:20 for fuel, was on duty there about 20 minutes, then got back on the road.

I made it to Davenport around 11:30, took my 30 off duty, and started rolling again at noon.

Got to Des Moines around 2:45, went on duty to unload and do paperwork for about 30 minutes, then went off duty for about an hour.

Around 4:15 I went back on duty for a quick equipment check, about 15 minutes, then started driving again around 4:30.

Stopped in Omaha around 7 for fuel, was on duty there about 20 minutes, then got back on the road.

I got to Lincoln around 8:15, did a 15-minute post-trip, then went off duty for the night around 8:30.`;

function clockCandidates(hour, minute, meridiem) {
  const h12 = Number(hour) % 12;
  const mm = String(Number(minute)).padStart(2, '0');
  const am = `${String(h12).padStart(2, '0')}:${mm}`;
  const pm = `${String(h12 + 12).padStart(2, '0')}:${mm}`;
  if (meridiem) {
    const isPm = /^p/i.test(meridiem.replace(/\./g, ''));
    return [isPm ? pm : am];
  }
  return am === pm ? [am] : [am, pm];
}
const APPROX_QUALIFIER_RE = /\b(?:about|around|near|roughly|approximately|circa|ish|cerca de(?: las?)?|aproximadamente|casi)\s*$/i;
function isApproximateMention(text, matchIndex) {
  const lookback = text.slice(Math.max(0, matchIndex - 20), matchIndex);
  return APPROX_QUALIFIER_RE.test(lookback);
}
function extractExplicitFacts(input) {
  const text = String(input || '');
  const times = [...text.matchAll(/\b(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?)?\b/gi)]
    .map(m => {
      const candidates = clockCandidates(m[1], m[2], m[3]);
      return { raw: m[0], normalized: candidates[0], candidates, approximate: isApproximateMention(text, m.index) };
    });
  return { times };
}

// Real proposed_events from AIProposal 6a9e227b418ac923c41c60fc
const events = [
  { start_time_local: '2026-09-06T00:00:00', end_time_local: '2026-09-06T05:45:00' },
  { start_time_local: '2026-09-06T05:45:00', end_time_local: '2026-09-06T06:00:00' },
  { start_time_local: '2026-09-06T06:00:00', end_time_local: '2026-09-06T08:20:00' },
  { start_time_local: '2026-09-06T08:20:00', end_time_local: '2026-09-06T08:40:00' },
  { start_time_local: '2026-09-06T08:40:00', end_time_local: '2026-09-06T11:30:00' },
  { start_time_local: '2026-09-06T11:30:00', end_time_local: '2026-09-06T12:00:00' },
  { start_time_local: '2026-09-06T12:00:00', end_time_local: '2026-09-06T14:45:00' },
  { start_time_local: '2026-09-06T14:45:00', end_time_local: '2026-09-06T15:15:00' },
  { start_time_local: '2026-09-06T15:15:00', end_time_local: '2026-09-06T16:15:00' },
  { start_time_local: '2026-09-06T16:15:00', end_time_local: '2026-09-06T16:30:00' },
  { start_time_local: '2026-09-06T16:30:00', end_time_local: '2026-09-06T19:00:00' },
  { start_time_local: '2026-09-06T19:00:00', end_time_local: '2026-09-06T19:20:00' },
  { start_time_local: '2026-09-06T19:20:00', end_time_local: '2026-09-07T00:15:00' },  // wait local should stay same-day format; using as-is for clock extraction only
  { start_time_local: '2026-09-06T20:15:00', end_time_local: '2026-09-06T20:30:00' },
  { start_time_local: '2026-09-06T20:30:00', end_time_local: null },
];

function clockFromLocal(value) {
  const match = String(value || '').match(/T(\d{2}):(\d{2})/);
  return match ? `${match[1]}:${match[2]}` : '';
}
function canonicalClockBoundaries(events) {
  const set = new Set();
  for (const event of events) {
    const s = clockFromLocal(event.start_time_local);
    const e = clockFromLocal(event.end_time_local);
    if (s) set.add(s);
    if (e) set.add(e);
  }
  return set;
}
function clockToMinutes(hhmm) {
  const m = String(hhmm || '').match(/^(\d{2}):(\d{2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
function nearestBoundaryDeltaMin(candidates, boundaryMinutes) {
  let min = Infinity;
  for (const c of candidates) {
    const cm = clockToMinutes(c);
    if (cm == null) continue;
    for (const bm of boundaryMinutes) min = Math.min(min, Math.abs(cm - bm));
  }
  return min;
}
const APPROX_TOLERANCE_MIN = 30;

const facts = extractExplicitFacts(text);
const boundaries = canonicalClockBoundaries(events);
const boundaryMinutes = [...boundaries].map(clockToMinutes).filter(n => n != null);

console.log('boundaries:', [...boundaries].sort());
let blocked = 0, approxReview = 0;
for (const fact of facts.times) {
  const exactMatch = fact.candidates.some(c => boundaries.has(c));
  if (exactMatch) { console.log('OK      ', fact.raw, '->', fact.candidates); continue; }
  if (fact.approximate) {
    const delta = nearestBoundaryDeltaMin(fact.candidates, boundaryMinutes);
    if (delta <= APPROX_TOLERANCE_MIN) { console.log('OK(tol) ', fact.raw, '->', fact.candidates, 'delta', delta); continue; }
    console.log('REVIEW  ', fact.raw, '->', fact.candidates, 'delta', delta);
    approxReview++;
    continue;
  }
  console.log('BLOCKED ', fact.raw, '->', fact.candidates);
  blocked++;
}
console.log('total blocked:', blocked, 'total review:', approxReview);
