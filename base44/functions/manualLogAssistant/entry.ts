import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

// ============================================================================
// LogbookAI Manual Log Assistant — OpenAI-backed interpretation layer.
// ----------------------------------------------------------------------------
// This function ONLY interprets natural language and reasons about factual
// corrections / future plans. It NEVER calculates authoritative HOS clocks —
// the client-side deterministic engine does that and passes a computed summary
// in as context. AI output is always a PROPOSAL for driver review. OpenAI
// never writes to the database; only the canonical timelineWriter does.
//
// Modes:
//   interpret          — driver describes the day → structured intent + events
//   make_legal_past    — find genuine factual errors/omissions in actual RODS
//   make_legal_future  — build an HOS-compliant future plan (not actual events)
//
// Quota: only a SUCCESSFUL OpenAI call increments the monthly AIUsageLog.
// Deterministic actions never reach this function. If OpenAI is unavailable,
// no usage is consumed and the client keeps the driver's typed request.
// ============================================================================

const UNAVAILABLE_MSG = 'LogbookAI is temporarily unavailable. Your request has not been applied.';

// Echoed on every interpret response so a test run can prove WHICH prompt/schema
// revision actually served the call (the live stress test found prompt edits
// that were not verifiably deployed). Bump when the prompt or schema changes.
// r4-2026-10-20: missing driving start times must never default to midnight or
// "now"; unrequested OFF_DUTY/SLEEPER events are forbidden; bare-hour meridiem
// times ("8 AM", "midnight") are now extracted as deterministic explicit facts.
const PROMPT_VERSION = 'r4-2026-10-20-missing-start-time';

// The strict output schema requires city/state strings, so the model sometimes
// writes a literal placeholder for an unknown location. A placeholder is not a
// place: normalize it to '' (mirrors src/lib/locationPlaceholders.js).
function cleanLoc(v) {
  const s = String(v == null ? '' : v).trim();
  return s.split(/\s*,\s*/).every((x) => /^(?:unknown|unk|n\/?a|none|null|undefined|unspecified|not specified|not provided|tbd|tba|\?+|[-–—]+)$/i.test(x)) && s ? '' : s;
}

// Indexed so an edit/delete proposal can point back at a SPECIFIC existing
// event by position (edit_target_index / delete_target_indices) rather than
// only a fuzzy time-based description. The index is into the FULL `events`
// array the client sent (not just the last 60 shown here) — note the visible
// window still only shows the most recent 60 for prompt size, so the index
// offset accounts for that.
function eventSummary(events) {
  const all = events || [];
  const windowStart = Math.max(0, all.length - 60);
  return all.slice(windowStart).map((e, i) =>
    `[${windowStart + i}] ${e.start_timestamp || ''} → ${e.end_timestamp || 'ongoing'} | ${e.duty_status} | ${e.city || ''} ${e.state || ''} | ${e.remark || ''} | unit ${e.tractor_number || ''}/${e.trailer_numbers || ''}`
  ).join('\n');
}

function docSummary(docs) {
  return (docs || []).slice(0, 30).map(d =>
    `${d.category || ''} | ${d.receipt_date || d.log_date || ''} ${d.receipt_time || ''} | ${d.vendor || ''} | ${d.city || ''} ${d.state || ''} | ${d.file_url ? 'file attached' : ''}`
  ).join('\n');
}

// ---------------------------------------------------------------------------
// Structured-output schema for the interpret mode (OpenAI strict json_schema).
// ---------------------------------------------------------------------------
const INTERPRET_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    intent: { type: 'string', enum: ['add_events', 'edit_events', 'delete_events', 'replace_day', 'question', 'hos_question', 'clarification'] },
    target_date: { type: 'string' },
    requires_clarification: { type: 'boolean' },
    clarification_question: { type: 'string' },
    summary: { type: 'string' },
    refuses_fabrication: { type: 'boolean' },
    pretrip_ask: { type: 'boolean' },
    // Only populated for intent "delete_events" — the [index] (from RECENT
    // ACTUAL EVENTS) of each existing event the driver wants removed.
    delete_target_indices: { type: 'array', items: { type: 'integer' } },
    proposed_events: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          start_time: { type: 'string' },
          end_time: { type: ['string', 'null'] },
          status: { type: 'string', enum: ['OFF_DUTY', 'SLEEPER', 'SLEEPER_BERTH', 'DRIVING', 'ON_DUTY'] },
          city: { type: 'string' },
          state: { type: 'string' },
          // DRIVING only: where the drive ARRIVES, when the driver stated or
          // clearly implied it. city/state above are where the event STARTS.
          // Empty strings when there is no stated destination (or not DRIVING).
          destination_city: { type: 'string' },
          destination_state: { type: 'string' },
          activity: { type: 'string' },
          remark: { type: 'string' },
          ambiguous_fields: { type: 'array', items: { type: 'string' } },
          field_provenance: {
            type: 'object', additionalProperties: false,
            properties: {
              start_time: { type: 'string', enum: ['explicit', 'inferred'] },
              end_time: { type: 'string', enum: ['explicit', 'inferred'] },
              status: { type: 'string', enum: ['explicit', 'inferred'] },
              city: { type: 'string', enum: ['explicit', 'inferred'] },
              state: { type: 'string', enum: ['explicit', 'inferred'] },
            },
            required: ['start_time', 'end_time', 'status', 'city', 'state'],
          },
          adjustments: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                field: { type: 'string', enum: ['start_time', 'end_time', 'status', 'city', 'state'] },
                original_stated_value: { type: 'string' },
                adjusted_value: { type: 'string' },
                reason: { type: 'string' },
              },
              required: ['field', 'original_stated_value', 'adjusted_value', 'reason'],
            },
          },
          // Only for intent "edit_events": the [index] (from RECENT ACTUAL
          // EVENTS) of the existing event THIS proposed event replaces. -1
          // when you cannot confidently identify a single existing event —
          // in that case also set requires_clarification=true. Irrelevant
          // (leave -1) for add_events/replace_day.
          edit_target_index: { type: 'integer' },
        },
        required: ['start_time', 'end_time', 'status', 'city', 'state', 'destination_city', 'destination_state', 'activity', 'remark', 'ambiguous_fields', 'field_provenance', 'adjustments', 'edit_target_index'],
      },
    },
    clarifications: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          type: { type: 'string' },
          question: { type: 'string' },
          field: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
        },
        required: ['type', 'question', 'field', 'options'],
      },
    },
    location_confirmations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { original: { type: 'string' }, interpreted: { type: 'string' } },
        required: ['original', 'interpreted'],
      },
    },
  },
  required: ['intent', 'target_date', 'requires_clarification', 'clarification_question', 'summary', 'refuses_fabrication', 'pretrip_ask', 'delete_target_indices', 'proposed_events', 'clarifications', 'location_confirmations'],
};

// Response shapes for make_legal_past / make_legal_future, matching the JSON
// shape each prompt already describes to the model (see buildPastPrompt /
// buildFuturePrompt below). Passed as response_json_schema to InvokeLLM.
const PAST_SCHEMA = {
  type: 'object',
  properties: {
    analysis: { type: 'string' },
    factual_corrections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          description: { type: 'string' },
          evidence: { type: 'string' },
          before_event: { type: 'string' },
          after_event: { type: 'string' },
          resolves_violation: { type: 'boolean' },
          question_for_driver: { type: 'string' },
          event_index: { type: 'number' },
          proposed_event: {
            type: 'object',
            properties: {
              start_timestamp: { type: 'string' },
              end_timestamp: { type: 'string' },
              duty_status: { type: 'string' },
              city: { type: 'string' },
              state: { type: 'string' },
              remark: { type: 'string' },
              activity_type: { type: 'string' },
            },
          },
        },
      },
    },
    violations_remain: {
      type: 'array',
      items: { type: 'object', properties: { rule: { type: 'string' }, message: { type: 'string' } } },
    },
    refuses_fabrication: { type: 'boolean' },
  },
};

const FUTURE_SCHEMA = {
  type: 'object',
  properties: {
    plan: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          sequence: { type: 'number' },
          type: { type: 'string' },
          start_offset_min: { type: 'number' },
          duration_min: { type: 'number' },
          duty_status: { type: 'string' },
          label: { type: 'string' },
          city: { type: 'string' },
          state: { type: 'string' },
        },
      },
    },
    feasibility: { type: 'string' },
    departure_time: { type: 'string' },
    earliest_eta: { type: 'string' },
    notes: { type: 'string' },
    refuses_fabrication: { type: 'boolean' },
  },
};

function buildInterpretSystem() {
  return `You are LogbookAI, an AI assistant that helps a commercial driver build a MANUAL Record of Duty Status (RODS). LogbookAI is NOT an ELD. The driver describes their day in natural language; you interpret it into proposed structured duty-status events. The driver reviews and confirms before anything is saved. Your goal is a COMPLETE proposal — never leave the driver's narrative unfinished or block on a minor missing detail.

LANGUAGE:
- The driver may write in English or Spanish (or mix them). Understand either natively — do not require translation and do not ask the driver to switch languages.
- Regardless of the input language, "status" MUST always be one of the exact English enum values OFF_DUTY, SLEEPER (or SLEEPER_BERTH), DRIVING, ON_DUTY — never translate or localize these codes; they are stored exactly as returned. "Fuera de servicio" -> OFF_DUTY, "conduciendo"/"manejando" -> DRIVING, "en servicio" -> ON_DUTY, "litera"/"dormitorio" -> SLEEPER_BERTH.
- Write summary and clarification_question in the SAME language the driver used for THIS message, so the driver reads the response in their own language. If the message is English, or its language is unclear (short fragments like "left around 7" or "I loaded here at 8"), answer in ENGLISH. Only switch to Spanish when the driver's own message is clearly Spanish. activity/remark may also be in that language. This is presentation only — it never changes the fixed English status/field names in the schema.
- summary describes a PROPOSAL the driver has not yet saved — nothing is written to the log until the driver taps Apply. NEVER phrase summary as something already done ("I have logged...", "I've recorded...", "Logged your day...", "Processed your log...", or the Spanish equivalents "He registrado..."/"Ya guardé..."). Always use forward-looking / proposal language instead ("Here's what I'll log if you approve:", "This will record...", "Ready to add:", or the Spanish "Esto registrará..."/"Voy a proponer...").

ABSOLUTE SAFETY RULES:
- NEVER fabricate an activity the driver did not describe (sleeper, off-duty, fuel, breaks, pre-trips, inspections, locations, driving). You MAY infer a reasonable best-guess for an unstated DETAIL the driver clearly implied, but never invent an activity that was not part of the narrative.
- NEVER convert Driving to another status, or alter an explicitly stated time/location/status, merely to make a log HOS-compliant. Preserve the facts; let the deterministic compliance review surface any violation.
- NEVER invent a pre-trip. If the driver describes driving but did not mention a pre-trip, do NOT add a pre-trip event (the deterministic review will offer one).
- NEVER add an OFF_DUTY or SLEEPER_BERTH event the driver did not describe (assumed rest, day padding, "obvious" sleep). If the driver described rest, log exactly what they described; otherwise return no such event.
- MISSING DRIVING START TIME: when the driver describes DRIVING without stating a start time, NEVER default the start to 00:00 (midnight) or to the current time — a placeholder must never masquerade as the actual driving start. If a reliable anchor exists (a prior event's end, an explicit sequence point), use it and mark start_time field_provenance "inferred", naming its source in summary. If NO reliable anchor exists, set requires_clarification=true, ask ONE question for the start time, and still return your best-guess proposal with start_time marked "inferred" and listed in ambiguous_fields. A driving start of exactly 00:00 that the driver did not state is ALWAYS wrong.
- If the driver DOES say they did a pre-trip (or "pre-trip inspection") but does not state how long it took, default its duration to 15 minutes — LogbookAI's standard pre-trip duration, not a claimed federal requirement. Mark that event's end_time (and start_time if likewise unstated) field_provenance "inferred", add it to ambiguous_fields, and say in summary that a 15-minute default was used. If the driver states an explicit duration or end time for the pre-trip, use that instead and mark it "explicit".
- A DRIVING segment the driver says is current/ongoing ("then I started driving", "then go to driving", no stated arrival) MUST be proposed with end_time=null and status=DRIVING marked "explicit" — it does not need a destination. Do NOT invent a destination city for it, and do NOT copy the start city into destination_city just to appear complete; city/state should simply be its own starting location, and destination_city/destination_state stay EMPTY.
- DRIVING DESTINATION: when the driver states or clearly implies where a DRIVING segment ARRIVES ("drove to Orlando", "left Miami ... got to Orlando at 9", "from Miami to Orlando", "headed to Tampa", "arrived in Houston"), set that DRIVING event's destination_city/destination_state to the arrival place, resolved by the same LOCATION PRECEDENCE as any other location. city/state remain where the segment STARTS (the origin). NEVER drop a stated destination and NEVER move it into city. Do NOT create an extra On Duty/Off Duty event at the destination unless the driver described one (that would fabricate an activity), and never change the driver's stated departure/arrival times to make the trip look feasible. If the driver named no destination for a segment, leave destination_city and destination_state empty.
- UNKNOWN LOCATION: when a city or state is unknown, return the EMPTY STRING "" — never the words "Unknown", "N/A", "None" or any placeholder — and follow LOCATION PRECEDENCE step 4 (ask).
- OVERNIGHT RANGES: a stated range whose end clock time is earlier than its start ("from 10 PM to 4 AM") crosses midnight — the end is on the NEXT calendar date. An end must never precede its start.
- DEPARTURE WORDS: "left", "departed", "pulled out", "rolled out", "headed out" mean the driver started DRIVING at that time (status DRIVING, explicit) — not On Duty.
- You do NOT calculate HOS. A deterministic HOS summary is provided for context only. Your job is to interpret what the driver said, not to compute clock math.
- LOCATION PRECEDENCE (this is the ONLY rule for deciding any event's city/state; it supersedes every other mention of inferring a location in this prompt). Apply in this order; the FIRST step that applies wins:
  1. EXPLICIT: a city/state the driver stated. Mark field_provenance "explicit".
  2. STRONG CONTEXT: a location the narrative's own route or the RECENT ACTUAL EVENTS establish unambiguously ("Houston, TX -> San Antonio -> Laredo" implies San Antonio, TX and Laredo, TX; an unnamed stop between two named cities on the same road; the same state as an adjacent explicit city). Mark "inferred".
  3. CURRENT LOCATION: the CURRENT LOCATION line, used ONLY for "here" / "this location" / "my location" / "current location", and ONLY when that line is not "(unknown)". Mark "inferred".
  4. ASK: otherwise leave city and state EMPTY for that event, list them in ambiguous_fields, and set requires_clarification=true with ONE question (which city/state?).
  NEVER invent a location solely to complete the proposal. NEVER resolve "here" from the location of a recent event; "there" with no earlier-named destination goes straight to step 4. A city name that exists in several US states (Springfield, Columbia, Portland, Charleston, Columbus, Jackson, Kansas City, Jacksonville, Lexington, Richmond, Greenville, Salem, Wilmington, Aurora, Lancaster, Lincoln, Athens, Alexandria, Arlington, Homestead, and similar) with no state given is NOT strong context unless an explicit state or an adjacent same-state city decides it — otherwise it goes to step 4 (leave state empty, ask which state). Unique well-known cities (Miami, Orlando, Dallas, Houston, Atlanta, ...) may still be resolved at step 2.
- VAGUE INPUT: a duration or distance ("about 3 hours", "300 miles") is NOT a clock time. When the driver gives no start time, end time, or usable anchor ("drove somewhere", "loaded earlier", "I drove like 300 miles", "I got there at 8" with no known destination), do not invent times or places — set requires_clarification=true with ONE targeted question (when / where) and return proposed_events=[] unless a reasonable, clearly-labeled inferred proposal exists.
- MULTIPLE LOCATIONS: when the narrative names more than one city, apply each stated city/state ONLY to the event(s) the driver's own wording clearly links it to (e.g. "drove to Miami, then loaded in Orlando"). Never assign a stated location to an unrelated activity by sentence order or guesswork: when the wording does not clearly link a location to an activity, leave that event's city and state EMPTY, list them in ambiguous_fields, set requires_clarification=true with ONE targeted question, and still return the partial best-guess proposal for the events whose locations ARE clear. Never silently substitute a different city or state for one the driver stated.

INTENT (choose exactly one):
- "add_events": the driver is describing new activity to log (the normal case).
- "edit_events": the driver wants to CHANGE one or more specific existing events (a time, location, status, or duration correction — "change my last fuel stop to 8:15", "that was Jacksonville, not Orlando", "make the fuel stop 30 minutes", "I actually started driving at 7, not 6:45"). Each proposed_events entry you return for this intent is the FULL CORRECTED event (not just the changed field), and its edit_target_index MUST be set to the [index] of the exact RECENT ACTUAL EVENTS line it replaces (see REFERENCE RESOLUTION). If you cannot confidently identify a single existing event, set edit_target_index to -1 on that entry AND requires_clarification=true, and still return your best-guess proposed event.
- "delete_events": the driver wants to REMOVE one or more specific existing events ("delete the second fuel stop", "remove that break"). Set proposed_events=[] and populate delete_target_indices with the [index] of each RECENT ACTUAL EVENTS line to remove. If you cannot confidently identify which event, leave delete_target_indices=[] and set requires_clarification=true with a targeted clarification_question instead of guessing.
- "replace_day": the driver wants to redo an entire day/trip ("redo my day", "start my log over for August 20"). Provide the full replacement event set for that day.
- "question": a non-HOS question about their log.
- "hos_question": an HOS question ("how many hours do I have", "can I drive", "do I have a violation", "can I make it to X tonight"). Do NOT propose events; answer in summary using the deterministic HOS context provided. For a destination-feasibility question, use only the mileage/route information you are given in context — NEVER invent a distance, drive time, or ETA yourself.
- "clarification": ONLY when a single missing detail MATERIALLY prevents any legal interpretation AND no reasonable inference exists. Set requires_clarification=true, ask ONE targeted question in clarification_question, and STILL return your best-guess proposed_events so the driver can proceed.

REFERENCE RESOLUTION:
- Resolve "earlier", "yesterday", "today", "my fuel stop", "my pre-trip", "the 4 PM stop", "my last stop", "the second fuel stop", etc. using the numbered RECENT ACTUAL EVENTS list (each line is prefixed "[N] ...") and the provided TODAY/NOW. target_date is the calendar date (YYYY-MM-DD) the described activity falls on.
- SELECTED LOG DATE: when the context provides one, the driver opened the assistant from a SPECIFIC log day in the Logs screen. When the driver's request does not EXPLICITLY name a different date, target_date MUST be the SELECTED LOG DATE, and every event with an unstated date falls on it. Only when the driver explicitly names another date ("yesterday", "August 20") may you use it — and say in summary that the proposal targets that other date instead of the one being edited. NEVER silently target a date the driver did not select or state; when no SELECTED LOG DATE is provided and the driver's words give no date, target TODAY.
- For edit_events/delete_events, the index N from that same "[N] ..." prefix is EXACTLY what edit_target_index / delete_target_indices expects — never invent an index outside the numbers actually shown, and never guess an index when more than one event could plausibly match (use -1 / omit it and ask instead).
- If a referenced event is ambiguous or cannot be safely identified, set requires_clarification=true and ask in clarification_question, but still return a best-guess proposal when possible.

COMPLETENESS-FIRST INFERENCE:
- Every activity the driver describes MUST appear as a proposed event. NEVER drop a described activity for lack of an exact time.
- For an approximate time ("around 3", "about 11"), INFER a reasonable exact timestamp from context (sequence, route travel time, prior event end, the deterministic HOS summary). Mark the field in ambiguous_fields with field_provenance "inferred". Do NOT block on approximate time alone.
- For an unstated location, follow LOCATION PRECEDENCE above (explicit, then strong route/timeline context, then CURRENT LOCATION for "here", then ASK). Completeness applies to ACTIVITIES and TIMES, never to locations: an unresolved location is left empty and asked about, not guessed. Mark city/state "inferred" when not explicitly stated.
- Mark genuinely driver-stated values field_provenance "explicit"; mark only genuinely unstated/inferred values "inferred". Never present an inferred value as explicit.

EXPLICIT FACTS, PROVENANCE, AND ADJUSTMENTS:
- Explicit times, duty statuses, cities, and states stated by the driver are facts. Preserve them exactly.
- Never drop an explicit state transition. "Started driving" and "continued driving" each produce a DRIVING segment.
- If two explicit facts create a small continuity conflict, use the full sequence, stated durations, realistic route/truck travel when available, and the deterministic HOS context to find the smallest realistic adjustment. Put every changed explicit field in adjustments with original_stated_value, adjusted_value, and a plain-language reason.
- HOS must NEVER be used as a reason to rewrite an explicit fact to make a log compliant. Preserve the facts; let the deterministic compliance review show the violation.
- Set requires_clarification only when a single missing detail MATERIALLY affects legality AND no reasonable inference exists. In that case ask ONE question and still return your best-guess proposal.

MULTI-STEP:
- Preserve every explicit state transition in chronological order; never collapse or omit Driving between On Duty activities.
- Events should form a continuous state machine without overlap; continuity never overrides explicit facts — use a visible adjustment or ask.
- Fuel occurs after the Driving segment that reached the fuel stop; unloading occurs after the Driving segment that reached the destination.
- A complete reconstruction of an entire day (from midnight or "off duty until" through "rest of the day") uses intent="replace_day". A final open-ended status keeps end_time=null and carries forward; never create an artificial midnight end.
- A clarification is a rare exception, not the default: the normal path is a complete, inferred-where-needed proposal the driver can confirm in one tap.

OUTPUT TIME CONTRACT:
- start_time and end_time are LOCAL WALL-CLOCK ISO strings in the provided home terminal timezone, with NO Z and NO UTC offset (example: "2026-08-20T06:15:00").
- Do not convert local times to UTC. The server performs exactly one timezone conversion after your response.
- target_date is the local calendar date in that same timezone. Resolve "yesterday" from TODAY (local), not from UTC.
- status is one of OFF_DUTY, SLEEPER (or SLEEPER_BERTH), DRIVING, ON_DUTY.
- activity is a short label (Pre-Trip, Fuel, Loading, Unloading, Drop/Hook, Break, Sleeper, Driving, Equipment Change). remark is free text.
- ambiguous_fields lists field names you inferred (e.g. ["start_timestamp","state"]).
- If a request would hide a violation by falsifying records, set refuses_fabrication=true with proposed_events=[] and explain in summary.`;
}

function buildInterpretUser(input, ctx) {
  // A clarification reply is interpreted TOGETHER with the request it answers,
  // so every city/state the earlier request stated carries across replies and
  // is applied exactly as stated — never substituted or re-guessed.
  const clarificationNote = ctx.clarificationOf?.originalInput
    ? `\n\nCLARIFICATION REPLY: this message answers your earlier question${ctx.clarificationOf.question ? ` ("${ctx.clarificationOf.question}")` : ''} about the earlier request: "${ctx.clarificationOf.originalInput}". Interpret the reply TOGETHER with that earlier request as ONE request — combine them, carry over every detail the earlier request stated (especially any city/state), apply each stated city/state to the matching events exactly as stated, and never substitute a different city or state. If the reply instead describes a separate new activity, treat it on its own and ignore the earlier request.`
    : '';
  return `DRIVER: ${ctx.userName}
CARRIER: ${ctx.carrierName} | Cycle ${ctx.cycle} | Home terminal TZ: ${ctx.timezone}
TODAY (local): ${ctx.todayLocal} | NOW (ISO UTC): ${ctx.nowIso}
SELECTED LOG DATE: ${ctx.selectedLogDate || '(none — the driver opened the assistant without a specific log day; default to TODAY only when the request names no date)'}
CURRENT LOCATION: ${ctx.currentLocation || '(unknown)'}
CURRENT EQUIPMENT: tractor ${ctx.tractor || '(none)'} / trailer ${ctx.trailer || '(none)'}

DETERMINISTIC HOS CONTEXT (authoritative — do not recompute):
${ctx.hosSummary}

RECENT ACTUAL EVENTS (use these to resolve references like "earlier", "my fuel stop", "the 4 PM stop"):
${eventSummary(ctx.events) || '(none)'}
${clarificationNote}

DRIVER SAID: "${input}"`;
}

function buildPastPrompt(input, ctx) {
  return `You are LogbookAI reviewing a driver's ACTUAL RODS for genuine factual errors or omissions that may explain an HOS violation. You are NOT an ELD. You NEVER fabricate events to remove a violation.

ABSOLUTE RULES:
- Only suggest changes that reflect something the driver actually reported or that a supporting document supports (fuel receipt, BOL timestamp, prior voice/text statement).
- NEVER manufacture sleeper, off-duty, fuel stops, breaks, locations, loading, inspections, or equipment changes merely to eliminate a violation.
- NEVER convert Driving to another status just to remove a violation unless there is factual evidence the truck was actually stopped/doing that activity.
- If no factual correction can resolve a violation, say so explicitly (violations_remain).
- Every suggested correction must include a question_for_driver that the driver must confirm before it is applied.

Respond ONLY as a JSON object with this shape:
{
  "analysis": string,
  "factual_corrections": [{ "description": string, "evidence": string, "before_event": string, "after_event": string, "resolves_violation": boolean, "question_for_driver": string, "event_index": number, "proposed_event": { "start_timestamp": string, "end_timestamp": string, "duty_status": string, "city": string, "state": string, "remark": string, "activity_type": string } }],
  "violations_remain": [{ "rule": string, "message": string }],
  "refuses_fabrication": boolean
}

DRIVER: ${ctx.userName} | Cycle ${ctx.cycle} | TZ ${ctx.timezone}
NOW (ISO UTC): ${ctx.nowIso}

DETERMINISTIC HOS CONTEXT (authoritative):
${ctx.hosSummary}

ACTUAL EVENTS (with any violations flagged):
${eventSummary(ctx.events) || '(none)'}

SUPPORTING DOCUMENTS / RECEIPTS (factual evidence):
${docSummary(ctx.documents) || '(none)'}

DRIVER SAID: "${input}"`;
}

function buildFuturePrompt(input, ctx) {
  return `You are LogbookAI helping a driver plan FUTURE activity to comply with FMCSA HOS. You are NOT an ELD. You produce a PROPOSED PLAN, not actual log entries.

ABSOLUTE RULES:
- Planned events are NOT logged. Label everything as planned.
- Never treat future rest as already completed.
- Use the deterministic HOS context (authoritative current clocks) as the starting point.
- If the requested arrival cannot be achieved legally, set feasibility="not_feasible" and provide the earliest reasonable compliant ETA.
- Never suggest speeding or falsifying records.

Respond ONLY as a JSON object with this shape:
{
  "plan": [{ "sequence": number, "type": "drive|onduty|break|sleeper|offduty|fuel", "start_offset_min": number, "duration_min": number, "duty_status": "OFF_DUTY|SLEEPER_BERTH|DRIVING|ON_DUTY", "label": string, "city": string, "state": string }],
  "feasibility": "feasible|not_feasible",
  "departure_time": string (ISO),
  "earliest_eta": string (ISO),
  "notes": string,
  "refuses_fabrication": boolean
}

DRIVER: ${ctx.userName} | Cycle ${ctx.cycle} | TZ ${ctx.timezone}
NOW (ISO UTC): ${ctx.nowIso}
CURRENT LOCATION: ${ctx.currentLocation || '(unknown)'}

DETERMINISTIC HOS CONTEXT (authoritative current clocks):
${ctx.hosSummary}

ORIGIN: ${ctx.origin || ctx.currentLocation || '(unknown)'}
DESTINATION: ${ctx.destination || '(unknown)'}
REQUESTED ARRIVAL: ${ctx.requestedArrival || '(not specified)'}

DRIVER SAID: "${input}"`;
}

function normalizeStatus(s) {
  return s === 'SLEEPER' ? 'SLEEPER_BERTH' : s;
}

function timezoneOffsetMs(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date);
  const values = {};
  for (const part of parts) if (part.type !== 'literal') values[part.type] = part.value;
  const hour = values.hour === '24' ? 0 : Number(values.hour);
  return Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day), hour, Number(values.minute), Number(values.second)) - date.getTime();
}

function localWallTimeToIso(value, timezone) {
  if (!value) return null;
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return null;
  const wallUtc = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6] || 0));
  let instant = wallUtc;
  for (let i = 0; i < 2; i++) instant = wallUtc - timezoneOffsetMs(new Date(instant), timezone);
  return new Date(instant).toISOString();
}

// Both 12-hour readings of a bare hour/minute mention (e.g. "2:45" -> 02:45
// and 14:45). When the narrative states an explicit meridiem ("2:45 PM"),
// only that one reading is returned — no ambiguity to preserve. When it
// doesn't, the driver themselves left it ambiguous (relying on the day's
// chronology, e.g. "stopped in Des Moines around 2:45" obviously afternoon)
// — so the guard must accept EITHER reading rather than the extractor
// guessing AM and rejecting a perfectly correct PM proposal as "dropped".
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

// A time mention immediately preceded by an approximation qualifier
// ("around 8:20", "about 5:45", Spanish "cerca de las"/"aproximadamente") is
// the driver's own ESTIMATE, not a hard fact the AI must reproduce exactly.
// It is still tracked (never silently dropped from consideration — the
// driver did state it) but flagged `approximate: true` so aiLayer's guard
// matches it with tolerance and never hard-blocks on it alone.
const APPROX_QUALIFIER_RE = /\b(?:about|around|near|roughly|approximately|circa|ish|cerca de(?: las?)?|alrededor(?: de(?: las?)?)?|a eso de(?: las?)?|aproximadamente|casi)\s*$/i;
function isApproximateMention(text, matchIndex) {
  const lookback = text.slice(Math.max(0, matchIndex - 20), matchIndex);
  return APPROX_QUALIFIER_RE.test(lookback);
}

// Colon times ("8:30", "8:30 AM") plus bare-hour meridiem times ("8 AM",
// "9 pm") and the word "midnight". A bare number WITHOUT a meridiem
// ("drove 8 hours", "300 miles") is never a time fact — only a meridiem or
// a colon makes digits a clock reading. The bare-hour pattern refuses a
// match whose digits are part of a preceding colon time ("8:30" -> "30 am").
function extractExplicitFacts(input) {
  const text = String(input || '');
  const times = [
    ...text.matchAll(/\b(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?)?\b/gi),
    ...text.matchAll(/(?<![:\d])(\d{1,2})\s*(a\.?m\.?|p\.?m\.?)\b/gi),
    ...text.matchAll(/\bmidnight\b/gi),
  ].map(m => {
    if (/^midnight$/i.test(m[0])) return { raw: m[0], normalized: '00:00', candidates: ['00:00'], approximate: isApproximateMention(text, m.index) };
    const candidates = clockCandidates(m[1], m[2] || '0', m[3]);
    return { raw: m[0], normalized: candidates[0], candidates, approximate: isApproximateMention(text, m.index) };
  });
  const locations = [...text.matchAll(/\b([A-Z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]*){0,3}),\s*([A-Z]{2})\b/g)]
    .map(m => ({ raw: m[0], city: m[1].trim(), state: m[2].toUpperCase() }));
  // Bilingual (English + Spanish) so the explicit-fact guard is equally
  // meaningful regardless of which language the driver wrote in — this is
  // detection only, never the source of the stored status (that always comes
  // from the model's fixed English enum output).
  const statusPatterns = [
    ['SLEEPER_BERTH', /\b(?:sleeper|sleeper berth|litera|dormitorio)\b/gi],
    ['OFF_DUTY', /\b(?:off[ -]?duty|fuera de servicio)\b/gi],
    ['ON_DUTY', /\b(?:on[ -]?duty|en servicio)\b/gi],
    ['DRIVING', /\b(?:driving|drove|drive|conduciendo|manejando|manej[oó])\b/gi],
  ];
  const statuses = statusPatterns.flatMap(([status, pattern]) => [...text.matchAll(pattern)].map(m => ({ raw: m[0], status })));
  return { times, locations, statuses };
}

function mapInterpret(parsed, source, timezone, originalInput) {
  const proposed_events = (parsed.proposed_events || []).map((p) => {
    const start = localWallTimeToIso(p.start_time, timezone);
    const end = localWallTimeToIso(p.end_time, timezone);
    return {
      date: parsed.target_date || (p.start_time ? p.start_time.slice(0, 10) : ''),
      start_timestamp: start || '',
      end_timestamp: end,
      start_time_local: p.start_time || '',
      end_time_local: p.end_time || null,
      duty_status: normalizeStatus(p.status),
      city: cleanLoc(p.city),
      state: cleanLoc(p.state),
      destination_city: cleanLoc(p.destination_city),
      destination_state: cleanLoc(p.destination_state),
      activity_type: normalizeStatus(p.status) === 'OFF_DUTY' && /sleeper/i.test(p.activity || '') ? 'Off Duty' : (p.activity || ''),
      remark: normalizeStatus(p.status) === 'OFF_DUTY' && /sleeper/i.test(p.remark || '') ? 'Off Duty' : (p.remark || p.activity || ''),
      ambiguous_fields: p.ambiguous_fields || [],
      field_provenance: p.field_provenance || {},
      adjustments: p.adjustments || [],
      // -1 (the model's "no confident target" sentinel, kept as a plain
      // integer for strict-schema compatibility) normalizes to null here.
      edit_target_index: Number.isInteger(p.edit_target_index) && p.edit_target_index >= 0 ? p.edit_target_index : null,
      source,
    };
  });
  return {
    prompt_version: PROMPT_VERSION,
    intent: parsed.intent || 'add_events',
    target_date: parsed.target_date || '',
    requires_clarification: !!parsed.requires_clarification,
    clarification_question: parsed.clarification_question || '',
    interpretation: parsed.summary || '',
    summary: parsed.summary || '',
    proposed_events,
    clarifications: parsed.clarifications || [],
    location_confirmations: parsed.location_confirmations || [],
    deterministic_explicit_facts: extractExplicitFacts(originalInput),
    original_input: originalInput,
    pretrip_ask: !!parsed.pretrip_ask,
    refuses_fabrication: !!parsed.refuses_fabrication,
    delete_target_indices: Array.isArray(parsed.delete_target_indices) ? parsed.delete_target_indices.filter((i) => Number.isInteger(i) && i >= 0) : [],
  };
}

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const mode = body.mode || 'interpret';
    const input = (body.input || '').trim();
    if (!input) return Response.json({ error: 'Empty input' }, { status: 400 });
    const source = body.source === 'voice' ? 'voice' : 'typed';

    // --- AI usage enforcement (backend) ---
    const settingsList = await base44.entities.AppSettings.filter({ settings_key: 'global' });
    const settings = settingsList[0] || { ai_enabled_global: true, default_ai_allowance: 20 };
    if (!settings.ai_enabled_global) {
      return Response.json({ error: 'AI functionality is currently disabled by the administrator.', disabled: true }, { status: 403 });
    }
    if (user.ai_disabled) {
      return Response.json({ error: 'AI is disabled for your account.', disabled: true }, { status: 403 });
    }
    const allowance = (user.ai_allowance_override != null ? user.ai_allowance_override : settings.default_ai_allowance) || 20;
    const month = new Date().toISOString().slice(0, 7);
    const usageList = await base44.entities.AIUsageLog.filter({ month });
    const usage = usageList[0];
    const used = usage ? usage.count : 0;
    if (used >= allowance) {
      return Response.json({
        error: "You've used your free AI Assistant requests for this month. You can continue using LogbookAI manually with full HOS calculations, log editing, certification and Inspection Mode.",
        limit: true, used, allowance,
      }, { status: 429 });
    }

    const carrierList = await base44.entities.CarrierProfile.list('-created_date', 1);
    const carrier = carrierList[0] || null;
    // Carrier home-terminal timezone is the single source of truth for encoding
    // proposed timestamps. If it is missing or not a valid IANA tz, refuse to
    // generate a proposal (do NOT default to America/Chicago or the device tz) —
    // the client surfaces a configuration-required message. No AI usage is
    // consumed when the carrier profile is not configured.
    const homeTz = carrier?.home_terminal_timezone || '';
    let tzValid = false;
    if (homeTz) {
      try { Intl.DateTimeFormat('en-US', { timeZone: homeTz }); tzValid = true; } catch { tzValid = false; }
    }
    if (!tzValid) {
      return Response.json({
        error: 'Carrier home-terminal timezone not configured — set it before generating a proposal.',
        configuration_required: true,
        unavailable: true,
        proposed_events: [],
        interpretation: '',
        summary: 'Carrier home-terminal timezone not configured.',
        intent: 'clarification',
        target_date: '',
        requires_clarification: true,
        clarification_question: 'Set your carrier home-terminal timezone in Carrier settings, then describe your day again.',
      }, { status: 400 });
    }
    const ctx = {
      userName: user.full_name || '',
      carrierName: carrier?.carrier_name || '',
      cycle: carrier?.hos_cycle || '70_8',
      timezone: homeTz,
      nowIso: new Date().toISOString(),
      todayLocal: new Date().toLocaleDateString('en-CA', { timeZone: homeTz }),
      currentLocation: body.currentLocation || '',
      tractor: body.tractor || '',
      trailer: body.trailer || '',
      events: body.events || [],
      documents: body.documents || [],
      hosSummary: body.hosSummary || '(not provided)',
      origin: body.origin || '',
      destination: body.destination || '',
      requestedArrival: body.requestedArrival || '',
      selectedLogDate: body.selected_date || '',
      clarificationOf: body.clarification_of || null,
    };

    // Route through Base44's own managed LLM integration — same mechanism
    // aiAssistant/entry.ts and extractDocument/entry.ts already use — instead
    // of a raw OpenAI fetch requiring a manually-configured OPENAI_API_KEY
    // secret (and a hardcoded, non-existent model id). No secret to provision;
    // InvokeLLM picks the model and returns an already-parsed JS object.
    let prompt, responseSchema;
    if (mode === 'make_legal_past') {
      prompt = buildPastPrompt(input, ctx);
      responseSchema = PAST_SCHEMA;
    } else if (mode === 'make_legal_future') {
      prompt = buildFuturePrompt(input, ctx);
      responseSchema = FUTURE_SCHEMA;
    } else {
      prompt = `${buildInterpretSystem()}\n\n${buildInterpretUser(input, ctx)}`;
      responseSchema = INTERPRET_SCHEMA;
    }

    let parsed;
    try {
      parsed = await base44.asServiceRole.integrations.Core.InvokeLLM({
        prompt,
        response_json_schema: responseSchema,
        model: 'automatic',
      });
    } catch (e) {
      console.log('INVOKE_LLM_ERROR', String(e?.message || e).slice(0, 500));
      return Response.json({ error: UNAVAILABLE_MSG, unavailable: true }, { status: 503 });
    }
    if (!parsed || typeof parsed !== 'object') {
      return Response.json({ error: UNAVAILABLE_MSG, unavailable: true }, { status: 503 });
    }

    // Only a successful interpretation consumes a request.
    const newCount = used + 1;
    if (usage) {
      await base44.entities.AIUsageLog.update(usage.id, { count: newCount, last_used_at: new Date().toISOString() });
    } else {
      await base44.entities.AIUsageLog.create({ month, count: 1, last_used_at: new Date().toISOString() });
    }

    const result = mode === 'interpret' ? mapInterpret(parsed, source, ctx.timezone, input) : parsed;

    // Persist every interpret result as an AIProposal so a future dropped
    // Driving leg (or any omitted event) is provable from stored data without
    // re-running the model. Audit-only — never blocks the response.
    if (mode === 'interpret') {
      try {
        await base44.entities.AIProposal.create({
          request_text: input,
          request_type: source,
          interpretation: result.interpretation || result.summary || '',
          proposed_changes: {
            intent: result.intent,
            target_date: result.target_date,
            proposed_events: result.proposed_events,
            location_confirmations: result.location_confirmations,
            clarifications: result.clarifications,
          },
          status: 'pending',
        });
      } catch (e) { /* audit-only; do not block the driver's response */ }
    }

    return Response.json({ ...result, mode, used: newCount, allowance });
  } catch (error) {
    return Response.json({ error: error.message || UNAVAILABLE_MSG, unavailable: true }, { status: 500 });
  }
}