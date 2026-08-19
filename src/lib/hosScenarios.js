// ============================================================================
// Split-Sleeper HOS Engine Test Scenarios
// ----------------------------------------------------------------------------
// Shared by the Vitest spec (src/lib/hosEngine.split.test.js) and the in-app
// Engine Tests page (src/pages/EngineTests.jsx). All times are anchored to a
// fixed NOW so results are deterministic and reproducible.
//
// Each scenario asserts, at minimum:
//   - authoritative pairing selected
//   - driving accumulated since the applicable reference point
//   - 11-hour driving remaining
//   - 14-hour window remaining
//   - cycle remaining
//   - split status
//   - whether any HOS violation exists
// ============================================================================

import {
  fmtHoursShort, computeHOS, normalizeEvents, buildRestBlocksWithSleeper,
} from './hosEngine';

export const NOW = new Date('2026-08-19T12:00:00Z');
const H = 3600000;

function ev(startAgoH, endAgoH, status, extra = {}) {
  return {
    log_date: new Date(NOW - startAgoH * H).toISOString().slice(0, 10),
    start_timestamp: new Date(NOW - startAgoH * H).toISOString(),
    end_timestamp: new Date(NOW - endAgoH * H).toISOString(),
    duty_status: status,
    ...extra,
  };
}

// Build a pairing label from the engine's split evaluation, matching the
// expected strings used in each scenario.
export function formatPairingLabel(split) {
  if (!split) return 'None (invalid)';
  if (split.status === 'active' && split.firstPeriod && split.secondPeriod) {
    const f = split.firstPeriod;
    const s = split.secondPeriod;
    const fl = f.status === 'SLEEPER_BERTH' ? 'Sleeper' : 'Off';
    const sl = s.status === 'SLEEPER_BERTH' ? 'Sleeper' : 'Off';
    return `${fmtHoursShort(f.duration)} ${fl} + ${fmtHoursShort(s.duration)} ${sl}`;
  }
  if (split.status === 'incomplete' && split.firstPeriod) {
    const f = split.firstPeriod;
    const fl = f.status === 'SLEEPER_BERTH' ? 'Sleeper' : 'Off';
    return `Incomplete (${fmtHoursShort(f.duration)} ${fl}; need ${fmtHoursShort(split.requiredSecondMs)})`;
  }
  return 'None (invalid)';
}

export const SCENARIOS = [
  {
    id: 1,
    name: '7h Sleeper + 3h Off (valid split)',
    events: [
      ev(20, 13, 'SLEEPER_BERTH'),
      ev(13, 10, 'DRIVING'),
      ev(10, 7, 'OFF_DUTY'),
      ev(7, 0, 'DRIVING'),
    ],
    expected: {
      pairing: '7h Sleeper + 3h Off',
      driveAccumH: 10, driveRemH: 1, windowRemH: 4, cycleRemH: 60,
      splitStatus: 'active', violation: false,
    },
  },
  {
    id: 2,
    name: '8h Sleeper + 2h Off (valid split)',
    events: [
      ev(19, 11, 'SLEEPER_BERTH'),
      ev(11, 6, 'DRIVING'),
      ev(6, 4, 'OFF_DUTY'),
      ev(4, 0, 'DRIVING'),
    ],
    expected: {
      pairing: '8h Sleeper + 2h Off',
      driveAccumH: 9, driveRemH: 2, windowRemH: 5, cycleRemH: 61,
      splitStatus: 'active', violation: false,
    },
  },
  {
    id: 3,
    name: '7h Sleeper + 3h Sleeper (valid split)',
    events: [
      ev(18, 11, 'SLEEPER_BERTH'),
      ev(11, 7, 'DRIVING'),
      ev(7, 4, 'SLEEPER_BERTH'),
      ev(4, 0, 'DRIVING'),
    ],
    expected: {
      pairing: '7h Sleeper + 3h Sleeper',
      driveAccumH: 8, driveRemH: 3, windowRemH: 6, cycleRemH: 62,
      splitStatus: 'active', violation: false,
    },
  },
  {
    id: 4,
    name: 'Invalid 6h Sleeper + 4h Off (no 7h sleeper period)',
    events: [
      ev(30, 20, 'OFF_DUTY'),      // 10h full reset
      ev(20, 14, 'DRIVING'),
      ev(14, 8, 'SLEEPER_BERTH'),  // 6h sleeper (< 7h)
      ev(8, 6, 'DRIVING'),
      ev(6, 2, 'OFF_DUTY'),         // 4h off
      ev(2, 0, 'DRIVING'),
    ],
    expected: {
      pairing: 'None (invalid)',
      driveAccumH: 10, driveRemH: 1, windowRemH: 0, cycleRemH: 60,
      splitStatus: 'none', violation: true,
    },
  },
  {
    id: 5,
    name: 'Incomplete — first period only (7h sleeper, no second)',
    events: [
      ev(20, 10, 'OFF_DUTY'),      // 10h full reset
      ev(10, 8, 'DRIVING'),
      ev(8, 1, 'SLEEPER_BERTH'),   // 7h sleeper (qualifying first period)
      ev(1, 0, 'DRIVING'),
    ],
    expected: {
      pairing: 'Incomplete (7h Sleeper; need 3h)',
      driveAccumH: 3, driveRemH: 8, windowRemH: 4, cycleRemH: 67,
      splitStatus: 'incomplete', violation: false,
    },
  },
  {
    id: 6,
    name: 'Multiple possible pairings — methodology selects most time',
    events: [
      ev(22, 15, 'SLEEPER_BERTH'), // A: 7h sleeper
      ev(15, 14, 'DRIVING'),
      ev(14, 12, 'OFF_DUTY'),      // B: 2h off
      ev(12, 11, 'DRIVING'),
      ev(11, 7, 'OFF_DUTY'),       // C: 4h off
      ev(7, 3, 'DRIVING'),
      ev(3, 0, 'SLEEPER_BERTH'),   // D: 3h sleeper
    ],
    expected: {
      pairing: '7h Sleeper + 4h Off',
      driveAccumH: 6, driveRemH: 5, windowRemH: 3, cycleRemH: 64,
      splitStatus: 'active', violation: false,
    },
  },
  {
    id: 7,
    name: 'Split crossing midnight',
    events: [
      ev(13, 6, 'SLEEPER_BERTH'),  // crosses the Aug 18/19 midnight
      ev(6, 4, 'DRIVING'),
      ev(4, 1, 'OFF_DUTY'),
      ev(1, 0, 'DRIVING'),
    ],
    expected: {
      pairing: '7h Sleeper + 3h Off',
      driveAccumH: 3, driveRemH: 8, windowRemH: 11, cycleRemH: 67,
      splitStatus: 'active', violation: false,
    },
  },
  {
    id: 8,
    name: 'Split followed by driving near the 11-hour limit',
    events: [
      ev(20, 13, 'SLEEPER_BERTH'),
      ev(13, 9, 'DRIVING'),
      ev(9, 6, 'OFF_DUTY'),
      ev(6, 0, 'DRIVING'),
    ],
    expected: {
      pairing: '7h Sleeper + 3h Off',
      driveAccumH: 10, driveRemH: 1, windowRemH: 4, cycleRemH: 60,
      splitStatus: 'active', violation: false,
    },
  },
  {
    id: 9,
    name: 'Recalculated 14h window differs from unsplit calculation',
    events: [
      ev(27, 17, 'OFF_DUTY'),      // 10h full reset
      ev(17, 16, 'DRIVING'),
      ev(16, 9, 'SLEEPER_BERTH'),  // 7h sleeper
      ev(9, 4, 'DRIVING'),
      ev(4, 1, 'OFF_DUTY'),        // 3h off
      ev(1, 0, 'DRIVING'),
    ],
    expected: {
      pairing: '7h Sleeper + 3h Off',
      driveAccumH: 6, driveRemH: 5, windowRemH: 8, cycleRemH: 63,
      splitStatus: 'active', violation: false,
      unsplitWindowRemH: 0, // without the split, 14h window would be exceeded
    },
  },
];

// Run a scenario through the engine and return a normalized result object.
export function runScenario(scenario) {
  const cycleType = '70_8';
  const tz = 'UTC';
  const now = NOW;
  const hos = computeHOS(scenario.events, cycleType, tz, now, { historyComplete: true });
  const split = hos.split;

  // Unsplit (full-reset-only) 14h window for comparison: the 14h window that
  // would result if the split were ignored and the last 10h reset governed.
  let unsplitWindowRemH = null;
  if (scenario.expected.unsplitWindowRemH != null) {
    const segments = normalizeEvents(scenario.events, now);
    const blocks = buildRestBlocksWithSleeper(segments, now);
    let fullReset = null;
    for (const b of blocks) if (b.duration >= 10 * 3600000 && b.end <= now) fullReset = b;
    if (fullReset) {
      const elapsed = (now - fullReset.end) / 3600000;
      unsplitWindowRemH = Math.max(0, 14 - elapsed);
    }
  }

  const driveAccumH = hos.driving.drivingUsedMs / 3600000;
  const driveRemH = hos.driving.drivingRemainingMs / 3600000;
  const windowRemH = hos.window14.remainingMs / 3600000;
  const cycleRemH = hos.cycle.cycleRemainingHours;
  const violation =
    (hos.driving.applicable && hos.driving.drivingUsedMs >= 11 * 3600000) ||
    (hos.window14.applicable && hos.window14.elapsedMs >= 14 * 3600000);

  return {
    pairingLabel: formatPairingLabel(split),
    driveAccumH, driveRemH, windowRemH, cycleRemH,
    splitStatus: split.status,
    violation,
    unsplitWindowRemH,
  };
}