import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

// complianceStop — suggests a real, truck-accessible stopping point located
// at (or just before) the driver's remaining compliant driving distance along
// the route to destination. Uses the routing/web-context LLM (same provider as
// tripEstimate). Returns { stop_city, stop_state, miles_from_origin,
// miles_remaining, note }. Deterministic HOS math lives in the client; this
// only resolves a geographic stop consistent with the route.
export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const origin = (body.origin || '').trim();
    const destination = (body.destination || '').trim();
    const maxDriveMiles = Number(body.max_drive_miles);
    if (!origin || !destination || !maxDriveMiles || maxDriveMiles <= 0) {
      return Response.json({ error: 'origin, destination, and a positive max_drive_miles are required' }, { status: 400 });
    }

    const targetMiles = Math.round(maxDriveMiles);

    const result = await base44.asServiceRole.integrations.Core.InvokeLLM({
      prompt:
        'You are a truck route compliance planner. A commercial driver can legally drive at most ' +
        targetMiles + ' more miles before reaching their Hours-of-Service limit while driving from ' +
        origin + ' toward ' + destination + '. ' +
        'Identify ONE real, truck-accessible stopping point (a real city or town, or a known truck-stop area) located on the most direct truck route, at approximately ' +
        targetMiles + ' miles from the origin — and NOT exceeding that distance. ' +
        'Then return the approximate miles from the origin to that stop and the approximate miles remaining from that stop to the destination. ' +
        'Both mileages must be consistent with the total route distance. Return ONLY the JSON object.',
      add_context_from_internet: true,
      response_json_schema: {
        type: 'object',
        properties: {
          stop_city: { type: 'string' },
          stop_state: { type: 'string' },
          miles_from_origin: { type: 'number' },
          miles_remaining: { type: 'number' },
          note: { type: 'string' }
        }
      },
      model: 'gemini_3_flash'
    });

    return Response.json(result);
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}