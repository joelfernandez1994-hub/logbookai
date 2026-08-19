import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const lat = body.latitude;
    const lon = body.longitude;
    if (lat == null || lon == null) return Response.json({ error: 'latitude and longitude required' }, { status: 400 });

    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&addressdetails=1&zoom=10`;
    const resp = await fetch(url, { headers: { 'User-Agent': 'LogbookAI/1.0' } });
    if (!resp.ok) return Response.json({ error: 'Geocoding failed' }, { status: 502 });
    const data = await resp.json();
    const addr = data.address || {};
    const city = addr.city || addr.town || addr.village || addr.hamlet || addr.county || '';
    const state = addr.state || addr.region || '';
    return Response.json({
      city,
      state,
      display_name: data.display_name,
      latitude: lat,
      longitude: lon,
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}