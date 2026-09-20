import { PencilLine } from 'lucide-react';
import { fmtHours } from '@/lib/hosEngine';
import { getDisplayGrid } from '@/lib/timelineDisplay';
import { validateTimeline } from '@/lib/timelineEngine';

const STATUS_LABELS = {
  OFF_DUTY: 'OFF DUTY',
  SLEEPER_BERTH: 'SLEEPER BERTH',
  DRIVING: 'DRIVING',
  ON_DUTY: 'ON DUTY',
};

// Compact lane labels for the traditional RODS grid (saves horizontal space).
const STATUS_ABBR = {
  OFF_DUTY: 'OFF',
  SLEEPER_BERTH: 'SB',
  DRIVING: 'D',
  ON_DUTY: 'ON',
};

// Duty-status accent colors are mid-tone and readable on both light and dark.
const STATUS_COLORS = {
  OFF_DUTY: '#64748b',
  SLEEPER_BERTH: '#7c3aed',
  DRIVING: '#2563eb',
  ON_DUTY: '#ea580c',
};

const ROW_ORDER = ['OFF_DUTY', 'SLEEPER_BERTH', 'DRIVING', 'ON_DUTY'];

function formatDurationHours(h) {
  if (!h || h <= 0) return '0m';
  const totalMin = Math.round(h * 60);
  const hh = Math.floor(totalMin / 60);
  const mm = totalMin % 60;
  if (hh && mm) return `${hh}h ${mm}m`;
  if (hh) return `${hh}h`;
  return `${mm}m`;
}

export default function LogGraph({ events, dateStr, timezone, interactive = true, totalsOverride = null, onEditEvent }) {
  const now = new Date();
  const grid = getDisplayGrid(events, dateStr, timezone, now);
  const displayedTotals = totalsOverride || grid.totals;
  const displayedTotalHours = totalsOverride?.totalHours ?? grid.totalHours;
  const validation = validateTimeline(events, { dateStr, timezone, now });

  // Traditional RODS grid: tall plotting area, always a full 24h axis.
  // viewBox is tuned to render close to 1:1 on a mobile portrait width so the
  // hour ticks and labels stay crisp without horizontal scrolling.
  const W = 400;
  const leftPad = 30;
  const rightPad = 8;
  const topPad = 22;
  const bottomPad = 8;
  const rowH = 56; // ~56px lanes → 224px plot area
  const graphH = rowH * 4;
  const H = topPad + graphH + bottomPad;
  const graphW = W - leftPad - rightPad;
  const rowCenter = (i) => topPad + i * rowH + rowH / 2;

  const xForHour = (h) => leftPad + (h / 24) * graphW;

  const allSegs = [];
  ROW_ORDER.forEach((status, rowIdx) => {
    grid.rows[status].forEach((s) => allSegs.push({ ...s, status, rowIdx }));
  });
  allSegs.sort((a, b) => a.startHour - b.startHour);

  // Continuous duty line with vertical connectors between lanes — resembles a
  // paper-log / ELD duty trace instead of bulky filled rectangles.
  let pathD = '';
  allSegs.forEach((s, i) => {
    const x1 = xForHour(s.startHour);
    const x2 = xForHour(s.endHour);
    const y = rowCenter(s.rowIdx);
    if (i === 0) pathD += `M ${x1} ${y} `;
    else {
      const prevY = rowCenter(allSegs[i - 1].rowIdx);
      const xc = x1;
      pathD += `L ${xc} ${prevY} L ${xc} ${y} `;
    }
    pathD += `L ${x2} ${y} `;
  });

  const hourLabel = (h) => {
    if (h === 0 || h === 24) return '12A';
    if (h === 12) return '12P';
    return String(h < 12 ? h : h - 12);
  };

  const gridStroke = 'hsl(var(--graph-grid))';
  const labelFill = 'hsl(var(--graph-labels))';
  const lineStroke = 'hsl(var(--graph-line))';

  return (
    <div className="w-full">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto bg-graph rounded-lg border border-border" preserveAspectRatio="xMidYMid meet">
        {/* Hour grid lines (stronger, full height) */}
        {Array.from({ length: 25 }, (_, h) => (
          <line key={`hg${h}`} x1={xForHour(h)} y1={topPad} x2={xForHour(h)} y2={topPad + graphH}
            stroke={gridStroke} strokeWidth={h % 6 === 0 ? 1.1 : 0.7} strokeOpacity={h % 6 === 0 ? 0.95 : 0.6} />
        ))}
        {/* 15-minute minor ticks (short, top + bottom) — paper-log feel */}
        {Array.from({ length: 24 }, (_, h) => [1, 2, 3].map((q) => ({ h: h + q / 4 }))).flat().map((t, i) => (
          <g key={`q${i}`}>
            <line x1={xForHour(t.h)} y1={topPad} x2={xForHour(t.h)} y2={topPad + 4}
              stroke={gridStroke} strokeWidth={0.5} strokeOpacity={0.45} />
            <line x1={xForHour(t.h)} y1={topPad + graphH - 4} x2={xForHour(t.h)} y2={topPad + graphH}
              stroke={gridStroke} strokeWidth={0.5} strokeOpacity={0.45} />
          </g>
        ))}
        {/* Hour labels along the top axis */}
        {Array.from({ length: 25 }, (_, h) => (
          <text key={`hl${h}`} x={xForHour(h)} y={topPad - 8} fontSize="8" fill={labelFill} textAnchor="middle">
            {hourLabel(h)}
          </text>
        ))}
        {/* Horizontal lane dividers + compact left labels */}
        {ROW_ORDER.map((status, i) => (
          <g key={status}>
            <line x1={leftPad} y1={topPad + i * rowH} x2={leftPad + graphW} y2={topPad + i * rowH}
              stroke={gridStroke} strokeWidth={0.8} strokeOpacity={0.7} />
            <text x={leftPad - 5} y={rowCenter(i) + 3} fontSize="9" fontWeight="700" fill={labelFill} textAnchor="end" letterSpacing="0.3">
              {STATUS_ABBR[status]}
            </text>
          </g>
        ))}
        {/* Bottom border */}
        <line x1={leftPad} y1={topPad + graphH} x2={leftPad + graphW} y2={topPad + graphH}
          stroke={gridStroke} strokeWidth={0.8} strokeOpacity={0.7} />
        {/* Duty trace */}
        {pathD && (
          <path d={pathD} fill="none" stroke={lineStroke} strokeWidth={1.8} strokeLinejoin="miter" strokeLinecap="butt" />
        )}
        {/* Subtle change-point dots */}
        {allSegs.map((s, i) => (
          <circle key={`d${i}`} cx={xForHour(s.startHour)} cy={rowCenter(s.rowIdx)} r={1.6} fill={lineStroke} />
        ))}
      </svg>

      {/* Totals below the graph — graph is never shrunk to fit them */}
      <div className="grid grid-cols-4 gap-1.5 mt-2.5 text-center text-[11px]">
        {ROW_ORDER.map((s) => (
          <div key={s} className="rounded-md border border-border py-1.5 px-1">
            <div className="font-semibold text-card-foreground leading-tight">{STATUS_LABELS[s]}</div>
            <div className="text-muted-foreground tabular-nums">{fmtHours(displayedTotals[s])}</div>
          </div>
        ))}
      </div>
      <div className="text-center text-[11px] text-muted-foreground mt-1" data-testid="timeline-validation">
        Total: {displayedTotalHours.toFixed(2)} hr · {validation.valid ? 'continuous, valid' : 'correction required'}
      </div>

      {/* Event list — chronological; future events never appear (grid caps at now) */}
      <div className="mt-3 space-y-1">
        {allSegs.map((s, i) => (
          <div key={i} className="flex items-center gap-2 text-xs">
            <span className="shrink-0 inline-block w-2.5 h-2.5 rounded-full" style={{ backgroundColor: STATUS_COLORS[s.status] }} aria-hidden />
            <span className="font-mono w-[68px] shrink-0 text-muted-foreground">
              {s.start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: timezone })}
            </span>
            <span className="font-semibold text-card-foreground w-7 shrink-0">{STATUS_ABBR[s.status]}</span>
            <span className="text-muted-foreground tabular-nums shrink-0">{formatDurationHours(s.endHour - s.startHour)}</span>
            <span className="truncate flex-1 text-muted-foreground">{[s.city, s.state].filter(Boolean).join(', ')}{s.remark ? ` — ${s.remark}` : ''}</span>
            {onEditEvent && s.id && (
              <button type="button" onClick={() => onEditEvent(s.id)} aria-label="Edit event" className="shrink-0 inline-flex items-center justify-center min-h-[36px] min-w-[36px] text-muted-foreground hover:text-foreground">
                <PencilLine className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}