// ============================================================================
// LogbookAI — entitlement seam (NOT ENFORCED YET). At launch, every user
// must have full, unrestricted access: no trial, no paywall, no locked
// features. These tests pin that behavior down so a future subscription
// change can't silently start gating something before it's meant to.
// ============================================================================
import { describe, it, expect } from 'vitest';
import { getEntitlement, hasFeatureAccess, useEntitlement } from './entitlements';

describe('launch entitlement — full access for everyone, nothing locked', () => {
  it('getEntitlement() always resolves to full access regardless of who asks', () => {
    expect(getEntitlement().hasFullAccess).toBe(true);
    expect(getEntitlement({ id: 'anyone' }, { legal_name: 'X' }).hasFullAccess).toBe(true);
    expect(getEntitlement(null, null).hasFullAccess).toBe(true);
  });

  it('reports an active, non-expiring status with no trial clock', () => {
    const e = getEntitlement();
    expect(e.status).toBe('active');
    expect(e.trialEndsAt).toBeNull();
    expect(e.isPastDue).toBe(false);
  });

  it('useEntitlement() (the hook call sites should use) matches getEntitlement()', () => {
    expect(useEntitlement()).toEqual(getEntitlement());
  });

  it('hasFeatureAccess() is true for every known feature key', () => {
    for (const feature of ['ai_logging', 'trip_planner', 'ifta', 'pdf_export', 'csv_export']) {
      expect(hasFeatureAccess(feature)).toBe(true);
    }
  });

  it('hasFeatureAccess() is true even for an unknown feature key (nothing is opt-in-locked by default)', () => {
    expect(hasFeatureAccess('some_future_feature_not_yet_listed')).toBe(true);
  });

  it('hasFeatureAccess() would correctly gate if hasFullAccess were ever false (future-readiness, not currently reachable)', () => {
    expect(hasFeatureAccess('ai_logging', { hasFullAccess: false })).toBe(false);
  });
});
