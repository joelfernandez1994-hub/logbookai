// ============================================================================
// RodsGrid — the single canonical 24-hour duty-status graph for LogbookAI.
// ----------------------------------------------------------------------------
// Purely presentational SVG: a traditional FMCSA paper-log / ELD-style grid
// (full midnight-to-midnight axis, hourly lines + 15-minute ticks, four equal
// lanes, compact OFF/SB/D/ON labels) and a thin continuous duty trace with
// vertical transition connectors.
//
// EVERY screen that displays a driver's 24-hour duty timeline consumes this
// component (directly or via LogGraph) so visual behavior cannot drift:
//   - Today / Logs / Inspection / ProposalReview  → via <LogGraph> (full)
//   - ProposedChangeDialog before/after thumbnails → <RodsGrid compact>
//   - RodsGraphEditor view-mode                    → <RodsGrid> (full)
//
// It never touches the HOS/timeline engine. It accepts already-computed
// segments ({ status, startHour, endHour }) so the data source is owned by
// each caller (getDisplayGrid for live logs, daySegments for editor previews).
// ============================================================================

const ROW_ORDER = ['OFF_DUTY', 'SLEEPER_BERTH', 'DRIVING', 'ON_DUTY'];

const STATUS_ABBR = {
  OFF_DUTY: 'OFF',
  SLEEPER_BERTH: 'SB',
  DRIVING: 'D',
  ON_DUTY: 'ON',
};

const STATUS_COLORS = {
  OFF_DUTY: '#64748b',
  SLEEPER_BERTH: '#7c3aed',
  DRIVING: '#2563eb',
  ON_DUTY: '#ea580c',
};

function hourLabel(h) {
  if (h === 0 || h === 24) return '12A';
  if (h === 12) return '12P';
  return String(h < 12 ? h : h - 12);
}

// Geometry presets — compact is for small before/after thumbnails.
const PRESETS = {
  full: { W: 400, leftPad: 30, rightPad: 8, topPad: 22, bottomPad: 8, rowH: 56, hourFont: 8, laneFont: 9, labelEvery: 1 },
  compact: { W: 280, leftPad: 22, rightPad: 6, topPad: 14, bottomPad: 6, rowH: 20, hourFont: 6, laneFont: 7, labelEvery: 6 },
};

export default function RodsGrid({ segments = [], compact = false, className = '' }) {
  const p = compact ? PRESETS.compact : PRESETS.full;
  const { W, leftPad, rightPad, topPad, bottomPad, rowH, hourFont, laneFont, labelEvery } = p;
  const graphH = rowH * 4;
  const H = topPad + graphH + bottomPad;
  const graphW = W - leftPad - rightPad;
  const rowCenter = (i) => topPad + i * rowH + rowH / 2;
  const xForHour = (h) => leftPad + (h / 24) * graphW;

  const allSegs = segments
    .filter((s) => s && ROW_ORDER.includes(s.status))
    .slice()
    .sort((a, b) => a.startHour - b.startHour);

  // Continuous duty line with vertical connectors between lanes.
  let pathD = '';
  allSegs.forEach((s, i) => {
    const x1 = xForHour(s.startHour);
    const x2 = xForHour(s.endHour);
    const y = rowCenter(ROW_ORDER.indexOf(s.status));
    if (i === 0) pathD += `M ${x1} ${y} `;
    else {
      const prevY = rowCenter(ROW_ORDER.indexOf(allSegs[i - 1].status));
      pathD += `L ${x1} ${prevY} L ${x1} ${y} `;
    }
    pathD += `L ${x2} ${y} `;
  });

  const gridStroke = 'hsl(var(--graph-grid))';
  const labelFill = 'hsl(var(--graph-labels))';
  const lineStroke = 'hsl(var(--graph-line))';
  const tickLen = compact ? 3 : 4;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={`w-full h-auto bg-graph rounded-lg border border-border ${className}`} preserveAspectRatio="xMidYMid meet">
      {/* Hour grid lines (stronger, full height) */}
      {Array.from({ length: 25 }, (_, h) => (
        <line key={`hg${h}`} x1={xForHour(h)} y1={topPad} x2={xForHour(h)} y2={topPad + graphH}
          stroke={gridStroke} strokeWidth={h % 6 === 0 ? 1.1 : 0.7} strokeOpacity={h % 6 === 0 ? 0.95 : 0.6} />
      ))}
      {/* 15-minute minor ticks (short, top + bottom) */}
      {!compact && Array.from({ length: 24 }, (_, h) => [1, 2, 3].map((q) => h + q / 4)).flat().map((t, i) => (
        <g key={`q${i}`}>
          <line x1={xForHour(t)} y1={topPad} x2={xForHour(t)} y2={topPad + tickLen}
            stroke={gridStroke} strokeWidth={0.5} strokeOpacity={0.45} />
          <line x1={xForHour(t)} y1={topPad + graphH - tickLen} x2={xForHour(t)} y2={topPad + graphH}
            stroke={gridStroke} strokeWidth={0.5} strokeOpacity={0.45} />
        </g>
      ))}
      {/* Hour labels along the top axis */}
      {Array.from({ length: 25 }, (_, h) => (
        h % labelEvery === 0 ? (
          <text key={`hl${h}`} x={xForHour(h)} y={topPad - (compact ? 5 : 8)} fontSize={hourFont} fill={labelFill} textAnchor="middle">
            {hourLabel(h)}
          </text>
        ) : null
      ))}
      {/* Horizontal lane dividers + compact left labels */}
      {ROW_ORDER.map((status, i) => (
        <g key={status}>
          <line x1={leftPad} y1={topPad + i * rowH} x2={leftPad + graphW} y2={topPad + i * rowH}
            stroke={gridStroke} strokeWidth={0.8} strokeOpacity={0.7} />
          <text x={leftPad - 5} y={rowCenter(i) + (compact ? 2 : 3)} fontSize={laneFont} fontWeight="700" fill={labelFill} textAnchor="end" letterSpacing="0.3">
            {STATUS_ABBR[status]}
          </text>
        </g>
      ))}
      {/* Bottom border */}
      <line x1={leftPad} y1={topPad + graphH} x2={leftPad + graphW} y2={topPad + graphH}
        stroke={gridStroke} strokeWidth={0.8} strokeOpacity={0.7} />
      {/* Duty trace */}
      {pathD && (
        <path d={pathD} fill="none" stroke={lineStroke} strokeWidth={compact ? 1.3 : 1.8} strokeLinejoin="miter" strokeLinecap="butt" />
      )}
      {/* Subtle change-point dots */}
      {allSegs.map((s, i) => (
        <circle key={`d${i}`} cx={xForHour(s.startHour)} cy={rowCenter(ROW_ORDER.indexOf(s.status))} r={compact ? 1.1 : 1.6} fill={lineStroke} />
      ))}
    </svg>
  );
}

export { ROW_ORDER, STATUS_ABBR, STATUS_COLORS };