// ============================================================================
// LogbookAI — complianceStop REQUEST BOUNDARY (single source of truth).
// ----------------------------------------------------------------------------
// The stop-lookup API resolves a real stopping point at a given driving
// distance. A zero or negative distance is never a meaningful request: there
// is nothing to look up, and the answer would always be "you cannot even
// reach the origin". Callers must therefore resolve that case locally (as a
// "rest required before departure" state) instead of calling the API.
//
// Kept in base44/shared so the backend function and the Trip Planner use the
// EXACT same rule rather than two drifting copies.
// ============================================================================

export interface MaxDriveMilesValidation {
  ok: boolean;
  miles: number | null;
  error: string | null;
}

export function validateMaxDriveMiles(raw: unknown): MaxDriveMilesValidation {
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