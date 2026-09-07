// ============================================================================
// LogbookAI — parking/truck-stop discovery provider regression tests.
// Guards the Trucker Path integration's actual constraints:
//   - a suggested stop can generate a real handoff URL
//   - the coordinates passed are always the ones given (route-derived by the
//     caller, e.g. complianceStop's stop_lat/stop_lng) — never fabricated
//   - no live parking-availability data is ever invented (webFallbackUrl is
//     honestly null — Trucker Path documents no such fallback)
//   - the abstraction stays generic: Trip.jsx / complianceStop.js never
//     reference Trucker Path's URL scheme directly, only this module does
// ============================================================================
import { describe, it, expect } from 'vitest';
import { getParkingProvider, canHandoffToParking, buildParkingHandoff } from './parkingProvider';
import tripSource from '../pages/Trip.jsx?raw';
import complianceStopSource from './complianceStop.js?raw';

describe('parkingProvider — Trucker Path deep-link handoff', () => {
  it('builds a real deep link from real route-derived coordinates', () => {
    const handoff = buildParkingHandoff({ lat: 30.4383, lng: -84.2807 }); // Tallahassee, FL
    expect(handoff).not.toBeNull();
    expect(handoff.providerId).toBe('truckerPath');
    expect(handoff.providerLabel).toBe('Trucker Path');
    expect(handoff.appUrl).toBe('truckerpath://cal_route?daddr=30.4383,-84.2807');
  });

  it('never fabricates a location: returns null when a stop has no coordinates yet', () => {
    expect(buildParkingHandoff({})).toBeNull();
    expect(buildParkingHandoff({ lat: null, lng: null })).toBeNull();
    expect(buildParkingHandoff(null)).toBeNull();
  });

  it('rejects non-numeric/garbage coordinates rather than building a broken link', () => {
    expect(buildParkingHandoff({ lat: 'x', lng: -84 })).toBeNull();
    expect(buildParkingHandoff({ lat: NaN, lng: -84 })).toBeNull();
  });

  it('canHandoffToParking matches buildParkingHandoff for the same stop', () => {
    expect(canHandoffToParking({ lat: 30.4, lng: -84.2 })).toBe(true);
    expect(canHandoffToParking({})).toBe(false);
  });

  it('never invents a live-parking-availability fallback: webFallbackUrl is honestly null', () => {
    // Trucker Path's own documentation states there is no automatic fallback
    // if the app isn't installed, and publishes no web equivalent for this
    // scheme. LogbookAI must not paper over that with an invented URL.
    const handoff = buildParkingHandoff({ lat: 30.4, lng: -84.2 });
    expect(handoff.webUrl).toBeNull();
  });

  it('getParkingProvider defaults to truckerPath and returns null for an unknown id', () => {
    expect(getParkingProvider().id).toBe('truckerPath');
    expect(getParkingProvider('someFutureProvider')).toBeNull();
  });

  it('Trip.jsx and complianceStop.js never reference the Trucker Path URL scheme directly — only parkingProvider.js does', () => {
    // Modularity guard: if a Trucker Path deep link ever gets hardcoded
    // straight into the page or the HOS stop-planning module instead of
    // going through this abstraction, this test catches it.
    expect(tripSource).not.toContain('truckerpath://');
    expect(complianceStopSource).not.toContain('truckerpath://');
    expect(tripSource).toContain("from '@/lib/parkingProvider'");
  });
});
