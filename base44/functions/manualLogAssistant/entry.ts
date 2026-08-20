import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { secrets } from 'base44:runtime';

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

const OPENAI_MODEL = 'gpt-4o-mini';
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const UNAVAILABLE_MSG = 'LogbookAI is temporarily unavailable. Your request has not been applied.';

function eventSummary(events) {
  return (events || []).slice(-60).map(e =>
    `${e.start_timestamp || ''} → ${e.end_timestamp || 'ongoing'} | ${e.duty_status} | ${e.city || ''} ${e.state || ''} | ${e.remark || ''} | unit ${e.tractor_number || ''}/${e.trailer_numbers || ''}`
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
    intent: { type: 'string', enum: ['add_events', 'edit_events', 'replace_day', 'question', 'hos_question', 'clarification'] },
    target_date: { type: 'string' },
    requires_clarification: { type: 'boolean' },
    clarification_question: { type: 'string' },
    summary: { type: 'string' },
    refuses_fabrication: { type: 'boolean' },
    pretrip_ask: { type: 'boolean' },
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
          activity: { type: 'string' },
          remark: { type: 'string' },
          ambiguous_fields: { type: 'array', items: { type: 'string' } },
        },
        required: ['start_time', 'end_time', 'status', 'city', 'state', 'activity', 'remark', 'ambiguous_fields'],
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
  required: ['intent', 'target_date', 'requires_clarification', 'clarification_question', 'summary', 'refuses_fabrication', 'pretrip_ask', 'proposed_events', 'clarifications', 'location_confirmations'],
};

function buildInterpretSystem() {
  return `You are LogbookAI, an AI assistant that helps a commercial driver build a MANUAL Record of Duty Status (RODS). LogbookAI is NOT an ELD. The driver provides the facts; you organize them into proposed structured duty-status events. The driver reviews and confirms before anything is saved.

ABSOLUTE SAFETY RULES:
- NEVER fabricate events that did not occur (sleeper, off-duty, fuel, breaks, pre-trips, inspections, locations, driving).
- NEVER convert Driving to another status merely to eliminate an HOS violation.
- NEVER invent a pre-trip. If the driver describes driving but did not mention a pre-trip, set pretrip_ask=true and ask — do NOT add a pre-trip event.
- You do NOT calculate HOS. A deterministic HOS summary is provided for context only. Your job is to interpret what the driver said, not to compute clock math.

INTENT (choose exactly one):
- "add_events": the driver is describing new activity to log (the normal case).
- "edit_events": the driver wants to change specific existing events. Use the RECENT ACTUAL EVENTS to identify the target by time; if you cannot tell which event, set requires_clarification=true.
- "replace_day": the driver wants to redo an entire day/trip ("redo my day", "start my log over for August 20"). Provide the full replacement event set for that day.
- "question": a non-HOS question about their log.
- "hos_question": an HOS question ("how many hours do I have", "can I drive", "do I have a violation"). Do NOT propose events; answer in summary using the deterministic HOS context provided.
- "clarification": you need information before you can propose anything. Set requires_clarification=true and put the question in clarification_question with proposed_events=[].

REFERENCE RESOLUTION:
- Resolve "earlier", "yesterday", "today", "my fuel stop", "my pre-trip", "the 4 PM stop", etc. using the RECENT ACTUAL EVENTS and the provided TODAY/NOW. target_date is the calendar date (YYYY-MM-DD) the described activity falls on.
- If a referenced event is ambiguous or cannot be safely identified, set requires_clarification=true and ask in clarification_question.

NO INVENTED EXACT TIMES:
- For an approximate time ("around 3", "about 11"), if an exact timestamp is required to alter the legal record, set requires_clarification=true and ask the driver to confirm the exact time in clarification_question. You may ALSO propose a best-guess event with "start_timestamp" listed in ambiguous_fields, but never present a guessed time as certain.

MULTI-STEP:
- Preserve every explicit state transition in chronological order. "started driving" and "continued driving" MUST each produce a DRIVING segment; never collapse or omit Driving between On Duty activities.
- Events must NOT overlap and must form one continuous state machine: each event's end_time equals the next event's start_time.
- Fuel occurs after the Driving segment that reached the fuel stop; unloading occurs after the Driving segment that reached the destination.
- A complete reconstruction of an entire day (from midnight or "off duty until" through "rest of the day") uses intent="replace_day", starts at local 00:00, and ends at local 00:00 the following day. Do not leave the final event ongoing for a completed past day.
- Infer an omitted state from an unambiguous route context (Houston, TX → San Antonio → Laredo means San Antonio, TX and Laredo, TX). Ask only when genuinely ambiguous.
- If fuel/arrival/stop time is unknown and required, set requires_clarification=true and ask.

OUTPUT TIME CONTRACT:
- start_time and end_time are LOCAL WALL-CLOCK ISO strings in the provided home terminal timezone, with NO Z and NO UTC offset (example: "2026-08-20T06:15:00").
- Do not convert local times to UTC. The server performs exactly one timezone conversion after your response.
- target_date is the local calendar date in that same timezone. Resolve "yesterday" from TODAY (local), not from UTC.
- status is one of OFF_DUTY, SLEEPER (or SLEEPER_BERTH), DRIVING, ON_DUTY.
- activity is a short label (Pre-Trip, Fuel, Loading, Unloading, Drop/Hook, Break, Sleeper, Driving, Equipment Change). remark is free text.
- ambiguous_fields lists field names you guessed (e.g. ["start_timestamp","state"]).
- If a request would hide a violation by falsifying records, set refuses_fabrication=true with proposed_events=[] and explain in summary.`;
}

function buildInterpretUser(input, ctx) {
  return `DRIVER: ${ctx.userName}
CARRIER: ${ctx.carrierName} | Cycle ${ctx.cycle} | Home terminal TZ: ${ctx.timezone}
TODAY (local): ${ctx.todayLocal} | NOW (ISO UTC): ${ctx.nowIso}
CURRENT LOCATION: ${ctx.currentLocation || '(unknown)'}
CURRENT EQUIPMENT: tractor ${ctx.tractor || '(none)'} / trailer ${ctx.trailer || '(none)'}

DETERMINISTIC HOS CONTEXT (authoritative — do not recompute):
${ctx.hosSummary}

RECENT ACTUAL EVENTS (use these to resolve references like "earlier", "my fuel stop", "the 4 PM stop"):
${eventSummary(ctx.events) || '(none)'}

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

function mapInterpret(parsed, source, timezone) {
  const proposed_events = (parsed.proposed_events || []).map((p) => {
    const start = localWallTimeToIso(p.start_time, timezone);
    const end = localWallTimeToIso(p.end_time, timezone);
    return {
      date: parsed.target_date || (p.start_time ? p.start_time.slice(0, 10) : ''),
      start_timestamp: start || '',
      end_timestamp: end,
      duty_status: normalizeStatus(p.status),
      city: p.city || '',
      state: p.state || '',
      activity_type: normalizeStatus(p.status) === 'OFF_DUTY' && /sleeper/i.test(p.activity || '') ? 'Off Duty' : (p.activity || ''),
      remark: normalizeStatus(p.status) === 'OFF_DUTY' && /sleeper/i.test(p.remark || '') ? 'Off Duty' : (p.remark || p.activity || ''),
      ambiguous_fields: p.ambiguous_fields || [],
      source,
    };
  });
  return {
    intent: parsed.intent || 'add_events',
    target_date: parsed.target_date || '',
    requires_clarification: !!parsed.requires_clarification,
    clarification_question: parsed.clarification_question || '',
    interpretation: parsed.summary || '',
    summary: parsed.summary || '',
    proposed_events,
    clarifications: parsed.clarifications || [],
    location_confirmations: parsed.location_confirmations || [],
    pretrip_ask: !!parsed.pretrip_ask,
    refuses_fabrication: !!parsed.refuses_fabrication,
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
    const ctx = {
      userName: user.full_name || '',
      carrierName: carrier?.carrier_name || '',
      cycle: carrier?.hos_cycle || '70_8',
      timezone: carrier?.home_terminal_timezone || 'America/Chicago',
      nowIso: new Date().toISOString(),
      todayLocal: new Date().toLocaleDateString('en-CA', { timeZone: carrier?.home_terminal_timezone || 'America/Chicago' }),
      currentLocation: body.currentLocation || '',
      tractor: body.tractor || '',
      trailer: body.trailer || '',
      events: body.events || [],
      documents: body.documents || [],
      hosSummary: body.hosSummary || '(not provided)',
      origin: body.origin || '',
      destination: body.destination || '',
      requestedArrival: body.requestedArrival || '',
    };

    let messages, responseFormat, maxTokens;
    if (mode === 'make_legal_past') {
      messages = [
        { role: 'system', content: 'You are LogbookAI. Respond ONLY with a single JSON object, no prose.' },
        { role: 'user', content: buildPastPrompt(input, ctx) },
      ];
      responseFormat = { type: 'json_object' };
      maxTokens = 2000;
    } else if (mode === 'make_legal_future') {
      messages = [
        { role: 'system', content: 'You are LogbookAI. Respond ONLY with a single JSON object, no prose.' },
        { role: 'user', content: buildFuturePrompt(input, ctx) },
      ];
      responseFormat = { type: 'json_object' };
      maxTokens = 2000;
    } else {
      messages = [
        { role: 'system', content: buildInterpretSystem() },
        { role: 'user', content: buildInterpretUser(input, ctx) },
      ];
      responseFormat = { type: 'json_schema', json_schema: { name: 'logbook_interpret', strict: true, schema: INTERPRET_SCHEMA } };
      maxTokens = 1600;
    }

    const apiKey = secrets.get('OPENAI_API_KEY');
    if (!apiKey) {
      return Response.json({ error: UNAVAILABLE_MSG, unavailable: true }, { status: 503 });
    }

    const oaResp = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages,
        response_format: responseFormat,
        temperature: 0.2,
        max_tokens: maxTokens,
      }),
    });
    if (!oaResp.ok) {
      const dbg = await oaResp.text().catch(() => '');
      console.log('OPENAI_HTTP', oaResp.status, String(dbg).slice(0, 500));
      return Response.json({ error: UNAVAILABLE_MSG, unavailable: true }, { status: 503 });
    }
    const oaData = await oaResp.json();
    const content = oaData?.choices?.[0]?.message?.content;
    if (!content) {
      return Response.json({ error: UNAVAILABLE_MSG, unavailable: true }, { status: 503 });
    }
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      return Response.json({ error: UNAVAILABLE_MSG, unavailable: true }, { status: 503 });
    }

    // Only a successful interpretation consumes a request.
    const newCount = used + 1;
    if (usage) {
      await base44.entities.AIUsageLog.update(usage.id, { count: newCount, last_used_at: new Date().toISOString() });
    } else {
      await base44.entities.AIUsageLog.create({ month, count: 1, last_used_at: new Date().toISOString() });
    }

    const result = mode === 'interpret' ? mapInterpret(parsed, source, ctx.timezone) : parsed;
    return Response.json({ ...result, mode, used: newCount, allowance });
  } catch (error) {
    return Response.json({ error: error.message || UNAVAILABLE_MSG, unavailable: true }, { status: 500 });
  }
}