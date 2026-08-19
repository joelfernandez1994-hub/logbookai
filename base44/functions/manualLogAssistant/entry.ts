import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

// ============================================================================
// LogbookAI Manual Log Assistant — AI interpretation layer.
// ----------------------------------------------------------------------------
// This function ONLY interprets natural language and reasons about factual
// corrections / future plans. It NEVER calculates authoritative HOS clocks —
// the client-side deterministic engine does that and passes a computed summary
// in as context. AI output is always a PROPOSAL for driver review.
//
// Modes:
//   interpret          — driver describes the day → proposed structured events
//   make_legal_past    — find genuine factual errors/omissions in actual RODS
//   make_legal_future  — build an HOS-compliant future plan (not actual events)
// ============================================================================

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

function buildInterpretPrompt(input, ctx) {
  return `You are LogbookAI, an AI assistant that helps a commercial driver build a MANUAL Record of Duty Status (RODS). LogbookAI is NOT an ELD. The driver provides the facts; you organize them into proposed structured duty-status events. The driver reviews and confirms before anything is saved.

ABSOLUTE SAFETY RULES:
- NEVER fabricate events that did not occur (sleeper, off-duty, fuel, breaks, pre-trips, inspections, locations, driving).
- NEVER convert Driving to another status merely to eliminate an HOS violation.
- NEVER invent a pre-trip. If the driver describes driving but did not mention a pre-trip, set pretrip_ask=true and ask — do NOT add a pre-trip event.
- For approximate times ("around 3"), propose a best-guess time and mark the field in ambiguous_fields so the driver can review it.
- For uncertain voice city/state, add a location_confirmations entry asking the driver to confirm.
- You do NOT calculate HOS. A deterministic HOS summary is provided for context only.

DRIVER: ${ctx.userName}
CARRIER: ${ctx.carrierName} | Cycle ${ctx.cycle} | Home terminal TZ: ${ctx.timezone}
TODAY (local): ${ctx.todayLocal} | NOW (ISO): ${ctx.nowIso}
CURRENT LOCATION: ${ctx.currentLocation || '(unknown)'}
CURRENT EQUIPMENT: tractor ${ctx.tractor || '(none)'} / trailer ${ctx.trailer || '(none)'}

DETERMINISTIC HOS CONTEXT (authoritative — do not recompute):
${ctx.hosSummary}

RECENT ACTUAL EVENTS:
${eventSummary(ctx.events) || '(none)'}

DRIVER SAID: "${input}"

Interpret the driver's description into PROPOSED structured events for review. Each event: date (YYYY-MM-DD), start_timestamp (ISO), end_timestamp (ISO or null if still ongoing), duty_status (OFF_DUTY|SLEEPER_BERTH|DRIVING|ON_DUTY), city, state, activity_type (e.g. Pre-Trip, Fuel, Loading, Unloading, Drop/Hook, Break, Sleeper, Driving), remark, tractor_number, trailer_numbers (comma string), confidence (high|medium|low), ambiguous_fields (array of field names that are guesses), source (typed|voice).
If the driver describes an equipment change (drop/hook, trailer swap, bobtail), produce an ON_DUTY event with activity_type "Equipment Change" and put before/after trailers in remark (e.g. "Dropped 123, hooked 456").
If a request would hide a violation by falsifying records, set refuses_fabrication=true and explain in interpretation with proposed_events=[].`;
}

function buildPastPrompt(input, ctx) {
  return `You are LogbookAI reviewing a driver's ACTUAL RODS for genuine factual errors or omissions that may explain an HOS violation. You are NOT an ELD. You NEVER fabricate events to remove a violation.

ABSOLUTE RULES:
- Only suggest changes that reflect something the driver actually reported or that a supporting document supports (fuel receipt, BOL timestamp, prior voice/text statement).
- NEVER manufacture sleeper, off-duty, fuel stops, breaks, locations, loading, inspections, or equipment changes merely to eliminate a violation.
- NEVER convert Driving to another status just to remove a violation unless there is factual evidence the truck was actually stopped/doing that activity.
- If no factual correction can resolve a violation, say so explicitly (violations_remain).
- Every suggested correction must include a question_for_driver that the driver must confirm before it is applied.

DRIVER: ${ctx.userName} | Cycle ${ctx.cycle} | TZ ${ctx.timezone}
NOW (ISO): ${ctx.nowIso}

DETERMINISTIC HOS CONTEXT (authoritative):
${ctx.hosSummary}

ACTUAL EVENTS (with any violations flagged):
${eventSummary(ctx.events) || '(none)'}

SUPPORTING DOCUMENTS / RECEIPTS (factual evidence):
${docSummary(ctx.documents) || '(none)'}

DRIVER SAID: "${input}"

Identify possible logging errors. For each, output a factual_correction with: description, evidence (which document/statement supports it), before_event (the current event summary), after_event (proposed corrected event summary), resolves_violation (boolean), question_for_driver (must be answered yes before applying), event_index (which actual event it relates to, 0-based, or -1 if a missing event). If the violation cannot be resolved factually, list it in violations_remain. Set refuses_fabrication=true if the request asked you to hide a violation.`;
}

function buildFuturePrompt(input, ctx) {
  return `You are LogbookAI helping a driver plan FUTURE activity to comply with FMCSA HOS. You are NOT an ELD. You produce a PROPOSED PLAN, not actual log entries.

ABSOLUTE RULES:
- Planned events are NOT logged. Label everything as planned.
- Never treat future rest as already completed.
- Use the deterministic HOS context (authoritative current clocks) as the starting point.
- If the requested arrival cannot be achieved legally, set feasibility="not_feasible" and provide the earliest reasonable compliant ETA.
- Never suggest speeding or falsifying records.

DRIVER: ${ctx.userName} | Cycle ${ctx.cycle} | TZ ${ctx.timezone}
NOW (ISO): ${ctx.nowIso}
CURRENT LOCATION: ${ctx.currentLocation || '(unknown)'}

DETERMINISTIC HOS CONTEXT (authoritative current clocks):
${ctx.hosSummary}

ROUTE (if provided): ${ctx.route || '(none)'}
ORIGIN: ${ctx.origin || ctx.currentLocation || '(unknown)'}
DESTINATION: ${ctx.destination || '(unknown)'}
REQUESTED ARRIVAL: ${ctx.requestedArrival || '(not specified)'}

DRIVER SAID: "${input}"

Produce an HOS-compliant plan as ordered steps. Each step: sequence, type (drive|onduty|break|sleeper|offduty|fuel), start_offset_min (minutes from now), duration_min, duty_status (OFF_DUTY|SLEEPER_BERTH|DRIVING|ON_DUTY), label, city, state. Provide feasibility, departure_time (ISO), earliest_eta (ISO), and notes. Set refuses_fabrication=true if asked to falsify.`;
}

const SCHEMAS = {
  interpret: {
    type: 'object',
    properties: {
      interpretation: { type: 'string' },
      proposed_events: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            date: { type: 'string' }, start_timestamp: { type: 'string' }, end_timestamp: { type: 'string' },
            duty_status: { type: 'string' }, city: { type: 'string' }, state: { type: 'string' },
            activity_type: { type: 'string' }, remark: { type: 'string' },
            tractor_number: { type: 'string' }, trailer_numbers: { type: 'string' },
            confidence: { type: 'string' }, ambiguous_fields: { type: 'array', items: { type: 'string' } },
            source: { type: 'string' },
          },
        },
      },
      clarifications: {
        type: 'array',
        items: { type: 'object', properties: { type: { type: 'string' }, question: { type: 'string' }, field: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } } },
      },
      pretrip_ask: { type: 'boolean' },
      location_confirmations: { type: 'array', items: { type: 'object', properties: { original: { type: 'string' }, interpreted: { type: 'string' } } } },
      refuses_fabrication: { type: 'boolean' },
    },
  },
  make_legal_past: {
    type: 'object',
    properties: {
      analysis: { type: 'string' },
      factual_corrections: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            description: { type: 'string' }, evidence: { type: 'string' },
            before_event: { type: 'string' }, after_event: { type: 'string' },
            resolves_violation: { type: 'boolean' }, question_for_driver: { type: 'string' },
            event_index: { type: 'number' },
            proposed_event: { type: 'object', properties: {
              start_timestamp: { type: 'string' }, end_timestamp: { type: 'string' }, duty_status: { type: 'string' },
              city: { type: 'string' }, state: { type: 'string' }, remark: { type: 'string' }, activity_type: { type: 'string' },
            } },
          },
        },
      },
      violations_remain: { type: 'array', items: { type: 'object', properties: { rule: { type: 'string' }, message: { type: 'string' } } } },
      refuses_fabrication: { type: 'boolean' },
    },
  },
  make_legal_future: {
    type: 'object',
    properties: {
      plan: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            sequence: { type: 'number' }, type: { type: 'string' }, start_offset_min: { type: 'number' },
            duration_min: { type: 'number' }, duty_status: { type: 'string' }, label: { type: 'string' },
            city: { type: 'string' }, state: { type: 'string' },
          },
        },
      },
      feasibility: { type: 'string' }, departure_time: { type: 'string' }, earliest_eta: { type: 'string' },
      notes: { type: 'string' }, refuses_fabrication: { type: 'boolean' },
    },
  },
};

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const mode = body.mode || 'interpret';
    const input = (body.input || '').trim();
    if (!input) return Response.json({ error: 'Empty input' }, { status: 400 });

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
      route: body.route || '',
      origin: body.origin || '',
      destination: body.destination || '',
      requestedArrival: body.requestedArrival || '',
    };

    const prompt =
      mode === 'make_legal_past' ? buildPastPrompt(input, ctx) :
      mode === 'make_legal_future' ? buildFuturePrompt(input, ctx) :
      buildInterpretPrompt(input, ctx);

    const result = await base44.asServiceRole.integrations.Core.InvokeLLM({
      prompt,
      response_json_schema: SCHEMAS[mode] || SCHEMAS.interpret,
      model: 'automatic',
    });

    const newCount = used + 1;
    if (usage) {
      await base44.entities.AIUsageLog.update(usage.id, { count: newCount, last_used_at: new Date().toISOString() });
    } else {
      await base44.entities.AIUsageLog.create({ month, count: 1, last_used_at: new Date().toISOString() });
    }

    return Response.json({ ...result, mode, used: newCount, allowance });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}