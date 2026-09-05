import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { geocode, drivingRoute, reverseGeocode, pointAtMiles } from '../../shared/routing.ts';
import { normalizeJurisdiction } from '../../shared/usStates.ts';

// iftaRouteSplit — REAL ROAD ROUTING (OSRM + OpenStreetMap Nominatim).
// Background IFTA helper only: splits one driving leg's route into
// per-jurisdiction (state) mileage by sampling the route geometry and
// reverse-geocoding each sample, bisecting near any state-line crossing.
//
// This is an ESTIMATION tool, not a GPS record. It never reads or writes
// DutyStatusEvent and has no effect on HOS or the duty-status timeline —
// callers must always label the result "route_estimated" until a driver
// reviews and confirms it. Any failure here must never surface as a logging
// or HOS error; callers treat a non-200 response as "could not resolve",
// not as an invalid log.
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
      return Response.json({ error: 'Could not locate one of the cities on the map.' }, { status: 404 });
    }

    const route = await drivingRoute(o, d);
    if (!route || route.miles == null || !route.geometry?.length) {
      return Response.json({ error: 'Road route not available right now.' }, { status: 502 });
    }

    const totalMiles = route.miles;
    if (totalMiles <= 0.5) {
      return Response.json({ totalMiles: 0, segments: [], provider: 'OSRM', notes: 'Origin and destination resolved to the same point.' });
    }

    // Adaptive sampling: aim for ~18 samples regardless of trip length so a
    // short leg still gets checked and a long leg doesn't trigger excessive
    // reverse-geocode calls.
    const targetSamples = 18;
    const interval = Math.min(60, Math.max(8, totalMiles / targetSamples));
    const sampleMiles = [0];
    for (let m = interval; m < totalMiles; m += interval) sampleMiles.push(m);
    sampleMiles.push(totalMiles);

    const samples = [];
    for (const m of sampleMiles) {
      let pt;
      if (m <= 0) pt = { point: route.geometry[0], milesFromOrigin: 0 };
      else if (m >= totalMiles) pt = { point: route.geometry[route.geometry.length - 1], milesFromOrigin: totalMiles };
      else pt = pointAtMiles(route.geometry, m);
      if (!pt) continue;
      let rg = null;
      try { rg = await reverseGeocode(pt.point[1], pt.point[0]); } catch (e) { rg = null; }
      samples.push({ miles: pt.milesFromOrigin, state: rg?.state ? normalizeJurisdiction(rg.state) : null });
    }
    if (!samples.length) {
      return Response.json({ error: 'Could not identify jurisdictions along this route right now.' }, { status: 502 });
    }

    // Bisect between any two consecutive samples that disagree on state, to
    // pinpoint the crossing more precisely (bounded iterations per crossing).
    const refined = [samples[0]];
    for (let i = 1; i < samples.length; i++) {
      const prev = refined[refined.length - 1];
      const cur = samples[i];
      if (cur.state && prev.state && cur.state !== prev.state) {
        let lo = prev.miles, hi = cur.miles;
        const loState = prev.state;
        for (let iter = 0; iter < 4 && (hi - lo) > 2; iter++) {
          const mid = (lo + hi) / 2;
          const pt = pointAtMiles(route.geometry, mid);
          if (!pt) break;
          let rg = null;
          try { rg = await reverseGeocode(pt.point[1], pt.point[0]); } catch (e) { rg = null; }
          if (normalizeJurisdiction(rg?.state) === loState) lo = mid; else hi = mid;
        }
        refined.push({ miles: hi, state: cur.state });
      } else {
        refined.push(cur);
      }
    }

    // Build per-state segments from the (possibly refined) boundary points.
    const segments = [];
    for (let i = 1; i < refined.length; i++) {
      const state = refined[i - 1].state || refined[i].state || 'UNKNOWN';
      const miles = Math.max(0, refined[i].miles - refined[i - 1].miles);
      if (miles <= 0) continue;
      const existing = segments.find((s) => s.state === state);
      if (existing) existing.miles += miles; else segments.push({ state, miles });
    }

    return Response.json({
      totalMiles: Math.round(totalMiles),
      segments: segments.map((s) => ({ state: s.state, miles: Math.round(s.miles * 10) / 10 })),
      provider: 'OSRM',
      notes: 'Estimated from mapped route geometry, not an actual GPS track. Review before confirming for IFTA.',
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
