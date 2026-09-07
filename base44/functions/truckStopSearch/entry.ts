import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { geocode, drivingRoute, pointAtMiles, haversineMi } from '../../shared/routing.ts';

// truckStopSearch — finds REAL, named truck-stop/fuel POIs from OpenStreetMap
// (via the public, documented Overpass API) near a specific point along the
// driver's actual road route. This is a supported public data source — NOT
// Trucker Path, not scraped, not a private/undocumented endpoint.
//
// HOS math is NOT done here. The caller already used the canonical HOS
// engine (hosEngine.js) via planTripStops()/complianceStop.js to decide WHEN
// a stop is needed and passes `target_miles` as the point along the route to
// search near. This function only answers "what real truck stops exist near
// that point, and how far are they from the route line itself" — so a large
// backtrack detour is never silently recommended.
//
// Only tags OpenStreetMap contributors actually set are ever surfaced (name,
// fuel/parking-related tags). Nothing here invents a live parking count,
// fuel price, or amenity that isn't tagged.
export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const origin = (body.origin || '').trim();
    const destination = (body.destination || '').trim();
    const targetMiles = Number(body.target_miles);
    const radiusMiles = Number(body.radius_miles) > 0 ? Number(body.radius_miles) : 12;
    if (!origin || !destination || !Number.isFinite(targetMiles) || targetMiles < 0) {
      return Response.json({ error: 'origin, destination, and a non-negative target_miles are required' }, { status: 400 });
    }

    const o = await geocode(origin);
    const d = await geocode(destination);
    if (!o || !d) return Response.json({ error: 'Could not locate one of the cities on the map.' }, { status: 404 });
    const route = await drivingRoute(o, d);
    if (!route || !route.geometry?.length) return Response.json({ error: 'Road route not available right now.' }, { status: 502 });

    const clampedMiles = Math.max(0, Math.min(targetMiles, route.miles));
    const pt = pointAtMiles(route.geometry, clampedMiles);
    if (!pt) {
      return Response.json({
        stop_lat: null, stop_lng: null, miles_from_origin: Math.round(clampedMiles),
        pois: [], source: 'openstreetmap-overpass',
        note: 'Could not resolve a point along the route for this mileage.',
      });
    }
    const [lon, lat] = pt.point;
    const pois = await findPoisNearPoint(lat, lon, radiusMiles, route.geometry);

    return Response.json({
      stop_lat: lat,
      stop_lng: lon,
      miles_from_origin: Math.round(clampedMiles),
      pois,
      source: 'openstreetmap-overpass',
      note: pois.length
        ? 'Truck-stop locations from OpenStreetMap. Parking availability is not live data from this source — check a supported provider (e.g. Trucker Path) before relying on it.'
        : 'No named truck stops found from OpenStreetMap within the search radius.',
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}

const OVERPASS = 'https://overpass-api.de/api/interpreter';
const M_PER_MI = 1609.344;
// Well-known truck-stop chains — used only to flag suitability for an
// overnight rest (real parking capacity); never used to invent a location
// that OSM itself doesn't have.
const BRAND_RE = /pilot|flying j|love'?s|\bta\b|travelcenters|petro|speedway|road ?ranger|rip ?griffin|kwik ?trip|sapp bros/i;

async function findPoisNearPoint(lat, lon, radiusMiles, routeGeometry) {
  const radiusMeters = Math.round(radiusMiles * M_PER_MI);
  const query = `[out:json][timeout:25];(` +
    `node(around:${radiusMeters},${lat},${lon})["amenity"="fuel"];` +
    `way(around:${radiusMeters},${lat},${lon})["amenity"="fuel"];` +
    `node(around:${radiusMeters},${lat},${lon})["highway"="services"];` +
    `way(around:${radiusMeters},${lat},${lon})["highway"="services"];` +
    `node(around:${radiusMeters},${lat},${lon})["shop"="truck"];` +
    `);out center tags 30;`;

  let elements = [];
  try {
    const r = await fetch(OVERPASS, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'User-Agent': 'LogbookAI/1.0 (driver log app)' },
      body: query,
    });
    if (r.ok) {
      const j = await r.json();
      elements = Array.isArray(j?.elements) ? j.elements : [];
    }
  } catch {
    elements = []; // network/provider hiccup — return an empty, honest list, never fabricate results
  }

  return elements
    .map((el) => {
      const tags = el.tags || {};
      const plat = el.lat ?? el.center?.lat;
      const plon = el.lon ?? el.center?.lon;
      if (plat == null || plon == null) return null;
      const name = tags.name || tags.brand || null;
      if (!name) return null; // an unnamed pump island isn't a useful suggestion
      const hasFuel = tags.amenity === 'fuel' || tags.fuel === 'yes' || !!tags['fuel:diesel'];
      const hasParkingTag = tags.parking === 'yes' || tags.hgv === 'yes' || tags.truck === 'yes' || tags.amenity === 'parking';
      const isNamedTruckStop = BRAND_RE.test(name) || tags.shop === 'truck' || tags.hgv === 'yes' || tags.highway === 'services';
      return {
        name,
        lat: plat, lng: plon,
        city: tags['addr:city'] || null,
        state: tags['addr:state'] || null,
        has_fuel: hasFuel,
        has_parking_tag: hasParkingTag,
        is_named_truck_stop: isNamedTruckStop,
        distance_from_stop_mi: haversineMi([lon, lat], [plon, plat]),
        off_route_mi: distanceToRouteMi(plat, plon, routeGeometry),
        osm_id: el.id ?? null,
      };
    })
    .filter(Boolean);
}

// Distance in miles from a point to the nearest vertex of the route geometry
// — a lightweight, deterministic proxy for "how far off the road corridor is
// this place". Never under-states the true nearest-segment distance by more
// than the local vertex spacing, so it never hides a real detour.
function distanceToRouteMi(lat, lon, geometry) {
  let min = Infinity;
  for (let i = 0; i < geometry.length; i++) {
    const dLon = geometry[i][0] - lon;
    const dLat = geometry[i][1] - lat;
    // Cheap squared-degree prefilter before the real haversine call, since
    // route geometries can have thousands of points.
    if (dLon * dLon + dLat * dLat > 4) continue; // ~well beyond any plausible radius
    const d = haversineMi([lon, lat], geometry[i]);
    if (d < min) min = d;
  }
  return Number.isFinite(min) ? min : haversineMi([lon, lat], geometry[Math.floor(geometry.length / 2)]);
}
