// ============================================================================
// LogbookAI — Average driving speed preference (mileage estimation only).
// ----------------------------------------------------------------------------
// The driver's preferred average driving speed (default 65 MPH, adjustable from
// 25 to 90 MPH in More → Settings → Trip Preferences) is used ONLY to turn a
// known DRIVING duration into a mileage estimate.
//
// It never touches HOS calculations, duty-status durations, the AI
// review-and-confirm flow, or mileage that is already saved — changing the
// preference only affects estimates made afterwards.
//
// MILEAGE PRIORITY (highest first):
//   1. Driver-entered / driver-confirmed mileage
//   2. Road-route calculated mileage (when no manual value exists)
//   3. Driving hours × preferred average MPH (fallback)
// ============================================================================

export const DEFAULT_AVERAGE_MPH = 65;
export const MIN_AVERAGE_MPH = 25;
export const MAX_AVERAGE_MPH = 90;

export const MILEAGE_METHOD = {
  MANUAL: 'manual',
  ROUTE: 'route',
  ESTIMATE: 'estimate',
  UNKNOWN: 'unknown',
};

// Stored mileage sources that represent a driver's own figure — never replaced
// by an automatic estimate.
export const MANUAL_MILEAGE_SOURCES = ['manual', 'driver_stated'];

export function isValidAverageMph(value) {
  if (value === null || value === undefined || value === '') return false;
  const n = Number(value);
  return Number.isFinite(n) && n >= MIN_AVERAGE_MPH && n <= MAX_AVERAGE_MPH;
}

// A stored preference, or the 65 MPH default when unset or out of range.
export function resolveAverageMph(value) {
  return isValidAverageMph(value) ? Number(value) : DEFAULT_AVERAGE_MPH;
}

// The driver's saved preference (DriverProfile.average_driving_speed_mph).
export function resolvePreferredMph(profile) {
  return resolveAverageMph(profile?.average_driving_speed_mph);
}

// Estimated Miles = Driving Hours × Preferred Average MPH
export function estimateMilesFromDuration(drivingHours, averageMph) {
  const hours = Number(drivingHours);
  if (!Number.isFinite(hours) || hours <= 0) return 0;
  return hours * resolveAverageMph(averageMph);
}

export function mileageMethodLabel(method) {
  switch (method) {
    case MILEAGE_METHOD.MANUAL: return 'Manual';
    case MILEAGE_METHOD.ROUTE: return 'Route Calculated';
    case MILEAGE_METHOD.ESTIMATE: return 'Speed Estimated';
    default: return 'Not available';
  }
}

// Resolve one mileage figure under the priority above. A manual figure is
// always returned unchanged — an automatic estimate never replaces it.
export function resolveMileage({ manualMiles = null, routeMiles = null, drivingHours = 0, averageMph } = {}) {
  const manual = Number(manualMiles);
  if (manualMiles !== null && manualMiles !== undefined && manualMiles !== '' && Number.isFinite(manual)) {
    return { miles: Math.round(manual), method: MILEAGE_METHOD.MANUAL };
  }
  const route = Number(routeMiles);
  if (routeMiles !== null && routeMiles !== undefined && Number.isFinite(route) && route > 0.5) {
    return { miles: Math.round(route), method: MILEAGE_METHOD.ROUTE };
  }
  const hours = Number(drivingHours);
  if (Number.isFinite(hours) && hours > 0) {
    return {
      miles: Math.round(estimateMilesFromDuration(hours, averageMph)),
      method: MILEAGE_METHOD.ESTIMATE,
      averageMph: resolveAverageMph(averageMph),
    };
  }
  return { miles: null, method: MILEAGE_METHOD.UNKNOWN };
}