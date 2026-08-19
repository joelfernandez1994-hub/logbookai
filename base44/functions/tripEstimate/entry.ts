import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const origin = (body.origin || '').trim();
    const destination = (body.destination || '').trim();
    if (!origin || !destination) return Response.json({ error: 'Origin and destination required' }, { status: 400 });

    const result = await base44.asServiceRole.integrations.Core.InvokeLLM({
      prompt:
        'You are a truck route estimator. Estimate the driving distance in miles and realistic driving time in hours for a commercial truck traveling from ' +
        origin + ' to ' + destination + '. ' +
        'Use truck-appropriate roads when possible; if only ordinary road distance is available, label it as an estimate that does not account for commercial vehicle restrictions. ' +
        'Assume an average speed of roughly 50 mph for a loaded truck. Return ONLY the JSON object.',
      add_context_from_internet: true,
      response_json_schema: {
        type: 'object',
        properties: {
          miles: { type: 'number' },
          hours: { type: 'number' },
          notes: { type: 'string' },
          is_truck_route: { type: 'boolean' }
        }
      },
      model: 'gemini_3_flash'
    });

    return Response.json(result);
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}