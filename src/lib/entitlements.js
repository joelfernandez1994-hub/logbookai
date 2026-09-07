// ============================================================================
// LogbookAI — Entitlement / subscription seam.
// ----------------------------------------------------------------------------
// NOT ENFORCED YET. This module exists so that when subscriptions launch,
// access control is changed in ONE place instead of being hunted down across
// every page. Every future "is this locked?" / "does this user have access?"
// question in the app should be answered by calling into this file — never
// by a page inlining its own check against a raw field.
//
// TODAY (initial free public launch): every signed-in user has full,
// unrestricted access. No trial clock, no purchase flow, no locked features.
// getEntitlement() always resolves to `hasFullAccess: true` below — that is
// the ENTIRE reason the whole app currently behaves as "free for everyone."
//
// LATER (subscription launch): only this file (plus, if entitlement needs
// server-side verification against StoreKit, one small backend function it
// calls) should need to change:
//   - Where the entitlement actually comes from: today it's the hardcoded
//     object below; later it becomes a read of a `User`/`DriverProfile`
//     field (e.g. `subscription_status`, `trial_ends_at`) or a call to a new
//     backend function that verifies the receipt/subscription server-side
//     (see the release audit: "do not rely solely on a client-side boolean").
//   - `FEATURE_FLAGS` below becomes a real per-plan feature map instead of
//     "everything is true."
// Call sites (`useEntitlement()` / `hasFeatureAccess()`) do not change.
//
// Explicitly NOT this module's concern, both now and after subscriptions
// launch: the monthly AI request quota (`AIUsageLog` / `ai_allowance_override`
// / `ai_enabled_global`). That is a cost-control usage throttle enforced
// server-side in `manualLogAssistant/entry.ts`, orthogonal to plan access —
// per the product plan, AI stays included-with-a-limit even on a paid plan.
// Do not merge the two concerns.
// ============================================================================

// The canonical shape every consumer reads, regardless of where the
// underlying truth eventually comes from. Keep this shape stable across the
// "free launch" -> "subscriptions" transition so call sites never change.
const LAUNCH_ENTITLEMENT = Object.freeze({
  status: 'active',        // 'active' | 'trialing' | 'canceled_active' | 'expired' | 'none'
  plan: 'free_launch',     // placeholder plan id until real StoreKit products exist
  trialEndsAt: null,
  renewsAt: null,
  isPastDue: false,
  hasFullAccess: true,     // <-- the ONE flag almost everything should check
  source: 'launch_promo',  // where this entitlement came from (debugging aid)
});

// Every feature key the app might ever gate. Today every value is true
// (nothing is locked at launch) — when subscriptions launch, this becomes a
// real per-plan map (e.g. trip planner / IFTA reserved for a paid plan).
// Listing keys now, even while all-true, is what lets a future change be a
// data edit here instead of a code change at every call site.
const FEATURE_FLAGS = Object.freeze({
  ai_logging: true,
  trip_planner: true,
  ifta: true,
  pdf_export: true,
  csv_export: true,
});

// Read the current user's entitlement. Params are accepted (and unused) now
// so call sites already pass what a real implementation will need, and don't
// have to change shape later.
export function getEntitlement(_user, _profile) {
  return LAUNCH_ENTITLEMENT;
}

// Feature-gate check. Every future "is this locked?" question should call
// this instead of inlining its own logic.
export function hasFeatureAccess(feature, entitlement = getEntitlement()) {
  if (!entitlement.hasFullAccess) return false;
  return FEATURE_FLAGS[feature] !== false;
}

// Convenience hook for components. Trivial today on purpose — swap its
// internals for a real query/context read (and loading state) once
// entitlement becomes per-user and possibly server-verified.
export function useEntitlement() {
  return getEntitlement();
}
