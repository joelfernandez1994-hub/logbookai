// ============================================================================
// LogbookAI — LIVE-AI STRESS PROMPT SET (78 prompts) with structured
// expectations, scored by liveAiEvaluator.js. Run with
// scripts/liveAiStress.console.js in a logged-in app tab.
//
// Nothing here writes to any table: the harness calls manualLogAssistant in
// `interpret` mode with SYNTHETIC events in the request body (the function
// reads context events from the body, not the database), so no driver record
// is read or modified. Side effects are limited to the calling account's
// monthly AI-usage counter and the function's own AIProposal audit row.
//
// Expectations use local wall-clock "HH:MM" in the carrier timezone so they are
// date-independent. `mk('HH:MM')` (supplied by the harness) turns a local time
// on the run's "today" into the ISO timestamp the function expects.
// ============================================================================

const E = (status, city, state, start, end, extra = {}) => {
  const o = { status };
  if (city !== undefined) o.city = city;
  if (state !== undefined) o.state = state;
  if (start !== undefined) o.start = start;
  if (end !== undefined) o.end = end;
  return { ...o, ...extra };
};

// Synthetic timeline used by correction/delete prompts (indices are what the
// model must reference — same order the client sends).
export const CORRECTION_FIXTURE = (mk) => ([
  { start_timestamp: mk('00:00'), end_timestamp: mk('06:00'), duty_status: 'OFF_DUTY', city: 'Miami', state: 'FL', remark: '' },          // 0
  { start_timestamp: mk('06:00'), end_timestamp: mk('07:00'), duty_status: 'ON_DUTY', city: 'Miami', state: 'FL', remark: 'Loading' },    // 1
  { start_timestamp: mk('07:00'), end_timestamp: mk('11:30'), duty_status: 'DRIVING', city: 'Miami', state: 'FL', remark: '' },           // 2
  { start_timestamp: mk('11:30'), end_timestamp: mk('12:00'), duty_status: 'ON_DUTY', city: 'Ocala', state: 'FL', remark: 'Fuel' },       // 3
  { start_timestamp: mk('12:00'), end_timestamp: mk('15:00'), duty_status: 'DRIVING', city: 'Ocala', state: 'FL', remark: '' },           // 4
  { start_timestamp: mk('15:00'), end_timestamp: mk('16:00'), duty_status: 'ON_DUTY', city: 'Orlando', state: 'FL', remark: 'Unloading' }, // 5
  { start_timestamp: mk('20:00'), end_timestamp: null, duty_status: 'SLEEPER_BERTH', city: 'Orlando', state: 'FL', remark: '', is_ongoing: true }, // 6
]);

// Prior verified rest so downstream HOS is calculable in HOS-violation prompts.
export const RESET_FIXTURE = (mk) => ([
  { start_timestamp: mk('00:00', -1), end_timestamp: mk('05:00'), duty_status: 'OFF_DUTY', city: 'Miami', state: 'FL', remark: '' },
]);

export const PROMPTS = [
  // ---- A. prompts that previously broke -----------------------------------
  { id: 'A01', cat: 'previously-broken', prompt: 'Left Miami at 8 AM and got to Orlando at 9 AM', includeCities: ['Miami', 'Orlando'], events: [E('DRIVING', 'Miami', 'FL', '08:00', '09:00', { startProv: 'explicit', endProv: 'explicit' })], routeConflict: true },
  { id: 'A02', cat: 'previously-broken', prompt: 'Left Miami around 8ish and got to Orlando about noon', includeCities: ['Miami', 'Orlando'], events: [E('DRIVING', 'Miami', 'FL', '08:00', '12:00', { tolMin: 30, startApprox: true })] },
  { id: 'A03', cat: 'previously-broken', prompt: 'Left LA at 6 and arrived in Las Vegas at 11', includeCities: ['Las Vegas'], events: [E('DRIVING', undefined, 'CA', '06:00', '11:00')], routeConflict: false },
  { id: 'A04', cat: 'previously-broken', prompt: 'Headed to Nashville', clarify: true },
  { id: 'A05', cat: 'previously-broken', prompt: 'Drove over to Hialeah', clarify: true },
  { id: 'A06', cat: 'previously-broken', prompt: 'Started driving from Miami', eventsIfPresent: true, events: [E('DRIVING', 'Miami', undefined, undefined, null, { startProv: 'inferred' })] },
  { id: 'A07', cat: 'previously-broken', prompt: 'Drove for about 3 hours', eventsIfPresent: true, events: [E('DRIVING', undefined, undefined, undefined, undefined, { startProv: 'inferred' })] },
  { id: 'A08', cat: 'here', prompt: 'I loaded here at 8', clarify: true, emptyLocation: true, eventsIfPresent: true, events: [E('ON_DUTY', '', '', '08:00')] },
  { id: 'A09', cat: 'previously-broken', prompt: 'I went to bed at 10 PM', eventsIfPresent: true, events: [{ statusAny: ['OFF_DUTY', 'SLEEPER_BERTH'], start: '22:00' }] },
  { id: 'A10', cat: 'ambiguous-city', prompt: 'I drove from Springfield to Columbia', clarify: true, stateEmpty: ['Springfield', 'Columbia'] },

  // ---- B. single events / trucking slang ----------------------------------
  { id: 'B01', cat: 'single', prompt: 'loaded from 7 to 8', count: 1, events: [E('ON_DUTY', undefined, undefined, '07:00', '08:00')] },
  { id: 'B02', cat: 'single', prompt: 'drove from 8 to 11', eventsIfPresent: true, events: [E('DRIVING', undefined, undefined, '08:00', '11:00')] },
  { id: 'B03', cat: 'single', prompt: 'unloaded for 45 minutes', eventsIfPresent: true, events: [{ status: 'ON_DUTY' }] },
  { id: 'B04', cat: 'single', prompt: 'took a 30 minute break', eventsIfPresent: true, events: [{ statusAny: ['OFF_DUTY', 'ON_DUTY', 'SLEEPER_BERTH'] }] },
  { id: 'B05', cat: 'single', prompt: 'went to sleeper at 9 PM', events: [E('SLEEPER_BERTH', undefined, undefined, '21:00')] },
  { id: 'B06', cat: 'single', prompt: 'fueled for 15 minutes', eventsIfPresent: true, events: [{ status: 'ON_DUTY' }] },
  { id: 'B07', cat: 'single', prompt: 'bumped the dock at 6', events: [E('ON_DUTY', undefined, undefined, '06:00')] },
  { id: 'B08', cat: 'single', prompt: 'scaled at 11:15', events: [E('ON_DUTY', undefined, undefined, '11:15')] },
  { id: 'B09', cat: 'single', prompt: 'shut down at 5 pm', events: [{ statusAny: ['OFF_DUTY', 'SLEEPER_BERTH'], start: '17:00' }] },
  { id: 'B10', cat: 'single', prompt: 'started my day at 6', events: [E('ON_DUTY', undefined, undefined, '06:00')] },
  { id: 'B11', cat: 'single', prompt: 'rolled out at 6:30', events: [E('DRIVING', undefined, undefined, '06:30')] },

  // ---- C. multi-event trips ----------------------------------------------
  { id: 'C01', cat: 'multi', prompt: 'loaded here and drove to Orlando', clarify: true, includeCities: ['Orlando'] },
  { id: 'C02', cat: 'multi', prompt: 'picked up in Miami then went to Jacksonville', includeCities: ['Miami', 'Jacksonville'], events: [E('ON_DUTY', 'Miami', 'FL')] },
  { id: 'C03', cat: 'multi', prompt: 'loaded in Homestead around 6 and drove to Tampa', includeCities: ['Homestead', 'Tampa'], events: [E('ON_DUTY', 'Homestead', undefined, '06:00', undefined, { tolMin: 30, startApprox: true })] },
  { id: 'C04', cat: 'multi', prompt: 'I left Atlanta at 7 this morning headed to Nashville', includeCities: ['Atlanta'], events: [E('DRIVING', 'Atlanta', 'GA', '07:00', undefined, { startProv: 'explicit' })] },
  { id: 'C05', cat: 'multi', prompt: 'got loaded in Dallas then drove to Houston', includeCities: ['Dallas', 'Houston'], events: [E('ON_DUTY', 'Dallas', 'TX')] },
  { id: 'C06', cat: 'multi', prompt: 'picked up in Phoenix and ran to Tucson', includeCities: ['Phoenix', 'Tucson'], events: [E('ON_DUTY', 'Phoenix', 'AZ')] },
  { id: 'C07', cat: 'multi', prompt: 'loaded in Chicago, drove to Indianapolis, took a 30 then kept going', includeCities: ['Chicago', 'Indianapolis'], count: { min: 4 }, events: [E('ON_DUTY', 'Chicago', 'IL'), E('DRIVING')] },
  { id: 'C08', cat: 'multi', prompt: 'I was off duty until 5 then loaded and left for Savannah', includeCities: ['Savannah'], events: [E('OFF_DUTY', undefined, undefined, undefined, '05:00'), E('ON_DUTY', undefined, undefined, '05:00'), E('DRIVING')] },
  { id: 'C09', cat: 'multi', prompt: 'started in Memphis, drove to Little Rock, unloaded, then went off duty', includeCities: ['Memphis', 'Little Rock'], count: { min: 3 } },
  { id: 'C10', cat: 'multi', prompt: 'I drove from Miami FL to Orlando FL', includeCities: ['Miami', 'Orlando'], events: [E('DRIVING', 'Miami', 'FL')] },
  { id: 'C11', cat: 'multi', prompt: 'I drove from Miami to Orlando', includeCities: ['Miami', 'Orlando'], events: [E('DRIVING', 'Miami', 'FL')] },
  { id: 'C12', cat: 'here', prompt: 'loaded here, drove there, unloaded, went to sleeper', clarify: true, emptyLocation: true },
  { id: 'C13', cat: 'multi-long', prompt: 'I was off duty until 5 AM in Homestead, went on duty for my pretrip, left at 5:30, drove to Orlando, stopped for 30 minutes, drove to Jacksonville, unloaded for an hour and then went sleeper.', count: { min: 7 }, includeCities: ['Homestead', 'Orlando', 'Jacksonville'], events: [E('OFF_DUTY', 'Homestead', undefined, undefined, '05:00'), E('ON_DUTY', 'Homestead', undefined, '05:00'), E('DRIVING', undefined, undefined, '05:30')] },
  { id: 'C14', cat: 'multi-long', prompt: 'Started in Dallas at 6 AM, did a 20 minute pretrip, drove to Houston, fueled for 15 minutes, then drove to San Antonio and shut down.', includeCities: ['Dallas', 'Houston', 'San Antonio'], count: { min: 6 }, events: [E('ON_DUTY', 'Dallas', 'TX', '06:00', '06:20'), E('DRIVING', undefined, undefined, '06:20')] },
  { id: 'C15', cat: 'multi-long', prompt: 'I loaded in Atlanta at 7, left at 8, drove to Chattanooga, stopped for lunch, then continued to Nashville and unloaded.', includeCities: ['Atlanta', 'Chattanooga', 'Nashville'], count: { min: 5 }, events: [E('ON_DUTY', 'Atlanta', 'GA', '07:00', '08:00'), E('DRIVING', undefined, undefined, '08:00')] },
  { id: 'C16', cat: 'multi-long', prompt: 'I loaded in Miami from 6 to 7, drove to Orlando, unloaded for an hour, then went sleeper.', includeCities: ['Miami', 'Orlando'], count: { min: 4 }, events: [E('ON_DUTY', 'Miami', 'FL', '06:00', '07:00'), E('DRIVING', undefined, undefined, '07:00'), E('ON_DUTY', 'Orlando', 'FL'), E('SLEEPER_BERTH')] },

  // ---- D. impossible route times (must be flagged downstream) -------------
  { id: 'D01', cat: 'impossible-route', prompt: 'I left Miami at 8 AM and arrived in Orlando at 9 AM', includeCities: ['Miami', 'Orlando'], routeConflict: true, events: [E('DRIVING', 'Miami', 'FL', '08:00', '09:00')] },
  { id: 'D02', cat: 'impossible-route', prompt: 'Left Dallas at 8 AM and got to Houston at 8:45 AM', includeCities: ['Dallas', 'Houston'], routeConflict: true, events: [E('DRIVING', 'Dallas', 'TX', '08:00', '08:45')] },
  { id: 'D03', cat: 'impossible-route', prompt: 'Left Atlanta at 8 AM and arrived in Nashville at 9 AM', includeCities: ['Atlanta', 'Nashville'], routeConflict: true, events: [E('DRIVING', 'Atlanta', 'GA', '08:00', '09:00')] },
  { id: 'D04', cat: 'impossible-route', prompt: 'Left Chicago at 8 AM and was in Indianapolis by 8:45 AM', includeCities: ['Chicago', 'Indianapolis'], routeConflict: true, events: [E('DRIVING', 'Chicago', 'IL', '08:00', '08:45')] },
  { id: 'D05', cat: 'impossible-route', prompt: 'Left Los Angeles at 8 AM and got to Las Vegas by 9:30 AM', includeCities: ['Los Angeles', 'Las Vegas'], routeConflict: true, events: [E('DRIVING', 'Los Angeles', 'CA', '08:00', '09:30')] },

  // ---- E. plausible routes (must NOT be flagged) --------------------------
  { id: 'E01', cat: 'plausible-route', prompt: 'Left Miami at 8 AM and arrived in Orlando at 1 PM', includeCities: ['Miami', 'Orlando'], routeConflict: false, events: [E('DRIVING', 'Miami', 'FL', '08:00', '13:00')] },
  { id: 'E02', cat: 'plausible-route', prompt: 'Left Dallas at 6 AM and got to Houston at 11 AM', includeCities: ['Dallas', 'Houston'], routeConflict: false, events: [E('DRIVING', 'Dallas', 'TX', '06:00', '11:00')] },
  { id: 'E03', cat: 'plausible-route', prompt: 'Left Phoenix at 9 AM and got to Tucson at 11:30 AM', includeCities: ['Phoenix', 'Tucson'], routeConflict: false, events: [E('DRIVING', 'Phoenix', 'AZ', '09:00', '11:30')] },

  // ---- F. driver-stated mileage ------------------------------------------
  { id: 'F01', cat: 'mileage', prompt: 'I drove 230 miles from Miami to Orlando, left at 8 AM and got there at 1 PM', includeCities: ['Orlando'], mileageWarn: false },
  { id: 'F02', cat: 'mileage', prompt: 'I drove 200 miles from Miami to Orlando, left at 8 AM and got there at 1 PM', includeCities: ['Orlando'], mileageWarn: false },
  { id: 'F03', cat: 'mileage', prompt: 'I drove 150 miles from Miami to Orlando, left at 8 AM and got there at 1 PM', includeCities: ['Orlando'], mileageWarn: true },
  { id: 'F04', cat: 'mileage', prompt: 'I drove 500 miles from Miami to Orlando, left at 8 AM and got there at 1 PM', includeCities: ['Orlando'], mileageWarn: true },

  // ---- G. overnight / crossing midnight -----------------------------------
  { id: 'G01', cat: 'midnight', prompt: 'I drove from Miami to Orlando from 10 PM to 4 AM', includeCities: ['Miami', 'Orlando'], events: [E('DRIVING', 'Miami', 'FL', '22:00', '04:00')] },
  { id: 'G02', cat: 'midnight', prompt: 'went sleeper at 11 PM and woke up at 7 AM', events: [E('SLEEPER_BERTH', undefined, undefined, '23:00', '07:00')] },
  { id: 'G03', cat: 'midnight', prompt: 'I was off duty from 8 PM until 6 AM in Tampa', events: [E('OFF_DUTY', 'Tampa', 'FL', '20:00', '06:00')] },
  { id: 'G04', cat: 'midnight', prompt: 'on duty at 11:30 PM loading until 12:30 AM', events: [E('ON_DUTY', undefined, undefined, '23:30', '00:30')] },

  // ---- H. corrections / deletes against existing events -------------------
  { id: 'H01', cat: 'correction', prompt: 'actually I left Miami at 8', fixture: 'correction', edit: { target: 2, start: '08:00' } },
  { id: 'H02', cat: 'correction', prompt: 'change that load time to 7:30', fixture: 'correction', clarify: 'either', edit: { target: 1 } },
  { id: 'H03', cat: 'correction', prompt: "I wasn't driving then, I was on duty", fixture: 'correction', clarify: true },
  { id: 'H04', cat: 'correction', prompt: "I wasn't driving between 7 and 11:30, I was on duty", fixture: 'correction', edit: { target: 2, status: 'ON_DUTY' } },
  { id: 'H05', cat: 'delete', prompt: 'delete that fuel stop', fixture: 'correction', del: { indices: [3] } },
  { id: 'H06', cat: 'correction', prompt: 'move my sleeper time to 10 PM', fixture: 'correction', edit: { target: 6, start: '22:00' } },
  { id: 'H07', cat: 'delete', prompt: 'delete the second driving segment', fixture: 'correction', del: { indices: [4] } },

  // ---- I. vague / bad input (must ask, not invent) ------------------------
  { id: 'I01', cat: 'vague', prompt: 'drove somewhere', clarify: true },
  { id: 'I02', cat: 'vague', prompt: 'loaded earlier', clarify: true },
  { id: 'I03', cat: 'vague', prompt: 'went there around lunch', clarify: true },
  { id: 'I04', cat: 'vague', prompt: 'I drove like 300 miles', clarify: true },
  { id: 'I05', cat: 'ambiguous-city', prompt: 'I loaded in Jacksonville', clarify: true, stateEmpty: ['Jacksonville'] },
  { id: 'I06', cat: 'vague', prompt: 'I got there at 8', clarify: true },

  // ---- J. HOS-violating proposals (facts preserved, violation reported) ---
  { id: 'J01', cat: 'hos', prompt: 'I drove from 6 AM to 5 PM with no breaks', fixture: 'reset', notRefuse: true, events: [E('DRIVING', undefined, undefined, '06:00', '17:00')], violations: ['11-Hour Driving Limit', '30-Minute Break'] },
  { id: 'J02', cat: 'hos', prompt: 'I drove from 6 AM to 8 PM and took a 30 minute break at noon', fixture: 'reset', notRefuse: true, violations: ['11-Hour Driving Limit'] },
  { id: 'J03', cat: 'hos', prompt: 'on duty at 5 AM then drove from 8 AM to 7 PM straight through', fixture: 'reset', notRefuse: true, violations: ['30-Minute Break'] },

  // ---- K. approximate / relative times ------------------------------------
  { id: 'K01', cat: 'time', prompt: 'loaded at 6:15', events: [E('ON_DUTY', undefined, undefined, '06:15', undefined, { startProv: 'explicit' })] },
  { id: 'K02', cat: 'time', prompt: 'left around 7', events: [E('DRIVING', undefined, undefined, '07:00', undefined, { tolMin: 30 })] },
  { id: 'K03', cat: 'time', prompt: 'got there around noon', clarify: true },
  { id: 'K04', cat: 'time', prompt: "I've been driving since 8", events: [E('DRIVING', undefined, undefined, '08:00', null)] },
  { id: 'K05', cat: 'time', prompt: 'I stopped 30 minutes ago', clarify: true },

  // ---- L. city/state resolution -------------------------------------------
  { id: 'L01', cat: 'location', prompt: 'loaded in Miami at 7', events: [E('ON_DUTY', 'Miami', 'FL', '07:00')] },
  { id: 'L02', cat: 'location', prompt: 'loaded in Miami FL at 7', events: [E('ON_DUTY', 'Miami', 'FL', '07:00')] },
  { id: 'L03', cat: 'location', prompt: 'loaded in Miami, Florida at 7', events: [E('ON_DUTY', 'Miami', 'FL', '07:00')] },
  { id: 'L04', cat: 'ambiguous-city', prompt: 'loaded in Portland at 7', clarify: true, stateEmpty: ['Portland'] },
];

export function fixtureFor(spec, mk) {
  if (spec.fixture === 'correction') return CORRECTION_FIXTURE(mk);
  if (spec.fixture === 'reset') return RESET_FIXTURE(mk);
  return [];
}
