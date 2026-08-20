import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

function buildPrompt(command, events, user, carrierInfo) {
  const eventSummary = (events || []).slice(-40).map(e =>
    `${e.start_timestamp} | ${e.duty_status} | ${e.city || ''} ${e.state || ''} | ${e.remark || ''}`
  ).join('\n');

  return `You are LogbookAI Assistant, an AI helper for a commercial driver's Record of Duty Status (RODS).
You interpret the driver's natural-language request and convert it into PROPOSED structured duty-status events.
You do NOT apply changes — the driver reviews and confirms before anything is written.

SAFETY RULES (absolute):
- NEVER fabricate sleeper time, off-duty time, fuel times, locations, driving events, or pre-trips that did not occur.
- NEVER instruct the driver to alter a fuel receipt timestamp, delete legitimate driving, or falsify a location.
- NEVER suggest speeding to make an appointment.
- If a request would hide an HOS violation by falsifying records, refuse and explain what actually happened and what to check.
- An "HOS Check" for PAST activity means identifying issues and correcting genuine data-entry mistakes ONLY after the driver confirms the corrected information reflects what actually occurred.
- An "HOS Check" for FUTURE planning means restructuring a proposed future schedule to comply with HOS.
- You do NOT calculate authoritative HOS clocks — the app's deterministic engine does that. You only interpret intent into proposed events.

DRIVER: ${user.full_name || ''}
CARRIER: ${carrierInfo?.carrier_name || ''} | USDOT ${carrierInfo?.usdot_number || ''} | Cycle ${carrierInfo?.hos_cycle || '70_8'}

RECENT ACTUAL EVENTS (most recent at bottom):
${eventSummary || '(none)'}

DRIVER REQUEST: "${command}"

Interpret the request and return PROPOSED structured changes as duty-status events. Each event needs: start_timestamp (ISO), end_timestamp (ISO or null if ongoing), duty_status (OFF_DUTY, SLEEPER_BERTH, DRIVING, or ON_DUTY), city, state, remark.
If the request is a question (e.g. "how many hours do I have left", "can I make Atlanta tomorrow at 7 AM", "can I use split sleeper"), set proposed_changes to [] and answer in interpretation.
If the request asks to edit/correct an existing entry, set edit_target note in compliance_note.
Return the JSON object.`;
}

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const command = (body.command || '').trim();
    const events = body.events || [];
    if (!command) return Response.json({ error: 'Empty command' }, { status: 400 });

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
        limit: true, used, allowance
      }, { status: 429 });
    }

    const carrierList = await base44.entities.CarrierProfile.list('-created_date', 1);
    const carrierInfo = carrierList[0] || null;

    const result = await base44.asServiceRole.integrations.Core.InvokeLLM({
      prompt: buildPrompt(command, events, user, carrierInfo),
      response_json_schema: {
        type: 'object',
        properties: {
          interpretation: { type: 'string' },
          proposed_changes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                start_timestamp: { type: 'string' },
                end_timestamp: { type: 'string' },
                duty_status: { type: 'string' },
                city: { type: 'string' },
                state: { type: 'string' },
                remark: { type: 'string' }
              }
            }
          },
          compliance_note: { type: 'string' },
          refuses_fabrication: { type: 'boolean' },
          location_confirmations: { type: 'array', items: { type: 'object', properties: { original: { type: 'string' }, interpreted: { type: 'string' } } } }
        }
      },
      model: 'automatic'
    });

    // increment usage
    const newCount = used + 1;
    if (usage) {
      await base44.entities.AIUsageLog.update(usage.id, { count: newCount, last_used_at: new Date().toISOString() });
    } else {
      await base44.entities.AIUsageLog.create({ month, count: 1, last_used_at: new Date().toISOString() });
    }

    return Response.json({ ...result, used: newCount, allowance });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}