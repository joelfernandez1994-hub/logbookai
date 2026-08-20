import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { geocode, drivingRoute, reverseGeocode, pointAtMiles, haversineMi } from '../../shared/routing.ts';

// complianceStop — suggests a REAL, verified stopping point located at (or
// just before) the driver's remaining compliant driving distance along the
// actual road route. Resolves a real city/town via reverse geocoding; if that
// fails, returns a mileage RANGE only — never a fabricated business or exit.
export default async function(req) {
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

    const o = await geocode(origin);
    const d = await geocode(destination);
    if (!o || !d) return Response.json({ error: 'Could not locate one of the cities on the map.' }, { status: 404 });
    const route = await drivingRoute(o, d);
    if (!route || !route.geometry?.length) return Response.json({ error: 'Road route not available right now.' }, { status: 502 });

    const totalMiles = route.miles;
    const targetMiles = Math.min(maxDriveMiles, totalMiles);
    const pt = pointAtMiles(route.geometry, targetMiles);

    if (!pt) {
      return Response.json({
        stop_city: '', stop_state: '',
        miles_from_origin: Math.round(totalMiles),
        miles_remaining: 0,
        verified: false,
        note: `Suggested stopping range: the full route is about ${Math.round(totalMiles)} miles; you can reach the destination within your current driving availability.`,
      });
    }

    const place = await reverseGeocode(pt.point[1], pt.point[0]);
    const milesFromOrigin = Math.round(pt.milesFromOrigin);
    const milesRemaining = Math.max(0, Math.round(totalMiles - pt.milesFromOrigin));

    if (place && place.city) {
      return Response.json({
        stop_city: place.city,
        stop_state: place.state,
        miles_from_origin: milesFromOrigin,
        miles_remaining: milesRemaining,
        verified: true,
        note: 'Verified location via OpenStreetMap. Confirm it is truck-accessible before stopping.',
      });
    }
    // Reverse geocode failed — give a range, never a fabricated name.
    return Response.json({
      stop_city: '', stop_state: '',
      miles_from_origin: milesFromOrigin,
      miles_remaining: milesRemaining,
      verified: false,
      note: `Suggested stopping range: approximately ${Math.max(0, milesFromOrigin - 25)}–${milesFromOrigin + 25} route miles from origin.`,
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}