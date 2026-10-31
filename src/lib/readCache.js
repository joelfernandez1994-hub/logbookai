// ============================================================================
// SHARED SHORT-LIVED READ CACHE
// ----------------------------------------------------------------------------
// Every route mounts its own data hook, and each mount re-read the same
// DriverProfile / CarrierProfile / Equipment / full DutyStatusEvent list (plus
// certifications, claims, DVIRs, daily summaries). Tapping between tabs a few
// times in a minute therefore exhausted the platform's per-caller entity_list
// budget (429 "Rate limit exceeded: entity_list ...").
//
// This collapses those duplicate reads: an identical read that is still in
// flight, or younger than TTL_MS, is reused instead of re-issued — so
// navigating back to a page you just left costs no requests.
//
// Correctness: every writer calls invalidateReads(), so the reload() a page
// performs after a save always reads fresh data. The TTL is only a safety net
// for writes that don't go through one of those helpers.
// ============================================================================
const TTL_MS = 5000;
const entries = new Map();

// Drop every cached read (called by writers, before the caller reloads).
export function invalidateReads() {
  entries.clear();
}

// Reuse an in-flight/recent identical read, otherwise run `fn` and remember it.
export function cachedRead(key, fn) {
  const hit = entries.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.promise;
  const promise = Promise.resolve().then(fn);
  entries.set(key, { at: Date.now(), promise });
  // Never cache a failure — the next caller should retry the request.
  promise.catch(() => { if (entries.get(key)?.promise === promise) entries.delete(key); });
  return promise;
}