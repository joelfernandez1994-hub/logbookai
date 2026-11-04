// ============================================================================
// LogbookAI — complianceStop request rule (client side).
// ----------------------------------------------------------------------------
// Mirrors base44/shared/stopRequest.ts, which the backend function enforces.
// The frontend needs the same rule to refuse a request BEFORE it is made: a
// zero (or negative) remaining driving distance has no stop to resolve, so it
// is handled locally as "rest required before departure" instead of producing
// a guaranteed HTTP 400.
// ============================================================================

export function validateMaxDriveMiles(raw) {
  if (raw === null || raw === undefined || raw === '') {
    return { ok: false, miles: null, error: 'max_drive_miles is required' };
  }
  const miles = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(miles)) {
    return { ok: false, miles: null, error: 'max_drive_miles must be a number' };
  }
  if (miles <= 0) {
    return {
      ok: false,
      miles: null,
      error: 'max_drive_miles must be greater than zero — no driving distance remains before the limiting HOS clock, so there is no stop to resolve',
    };
  }
  return { ok: true, miles, error: null };
}