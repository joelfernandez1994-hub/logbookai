import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { geocode, drivingRoute } from '../../shared/routing.ts';

// tripEstimate — REAL ROAD ROUTING (OSRM + OpenStreetMap). Returns real road
// distance and travel time. Does NOT use generative AI to invent mileage.
export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const origin = (body.origin || '').trim();
    const destination = (body.destination || '').trim();
    if (!origin || !destination) return Response.json({ error: 'Origin and destination required' }, { status: 400 });

    const o = await geocode(origin);
    const d = await geocode(destination);
    if (!o || !d) {
      return Response.json({ error: 'Could not locate one of the cities on the map. Check the city and state.' }, { status: 404 });
    }
    const route = await drivingRoute(o, d);
    if (!route || route.miles == null) {
      return Response.json({ error: 'Road route not available right now. Try again in a moment.' }, { status: 502 });
    }

    return Response.json({
      miles: Math.round(route.miles),
      hours: Math.round(route.hours * 100) / 100,
      notes: 'Real road route via OpenStreetMap/OSRM (driving profile). Not truck-restricted; verify commercial-vehicle restrictions independently.',
      is_truck_route: false,
      provider: 'OSRM',
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}