import { computeHOS, getDailyGrid, fmtHours } from '@/lib/hosEngine';

const STATUS_LABELS = {
  OFF_DUTY: 'OFF DUTY',
  SLEEPER_BERTH: 'SLEEPER BERTH',
  DRIVING: 'DRIVING',
  ON_DUTY: 'ON DUTY',
};

// Duty-status accent colors are mid-tone and readable on both light and dark.
const STATUS_COLORS = {
  OFF_DUTY: '#64748b',
  SLEEPER_BERTH: '#7c3aed',
  DRIVING: '#2563eb',
  ON_DUTY: '#ea580c',
};

const ROW_ORDER = ['OFF_DUTY', 'SLEEPER_BERTH', 'DRIVING', 'ON_DUTY'];

export default function LogGraph({ events, dateStr, timezone, interactive = true }) {
  const grid = getDailyGrid(events, dateStr, timezone);

  const W = 1000;
  const H = 300;
  const leftPad = 96;
  const topPad = 26;
  const graphW = W - leftPad - 16;
  const rowH = 52;
  const rowCenter = (i) => topPad + i * rowH + rowH / 2;

  const xForHour = (h) => leftPad + (h / 24) * graphW;

  const allSegs = [];
  ROW_ORDER.forEach((status, rowIdx) => {
    grid.rows[status].forEach((s) => allSegs.push({ ...s, status, rowIdx }));
  });
  allSegs.sort((a, b) => a.startHour - b.startHour);

  let pathD = '';
  allSegs.forEach((s, i) => {
    const x1 = xForHour(s.startHour);
    const x2 = xForHour(s.endHour);
    const y = rowCenter(s.rowIdx);
    if (i === 0) pathD += `M ${x1} ${y} `;
    else {
      const prevY = rowCenter(allSegs[i - 1].rowIdx);
      pathD += `L ${x2 - (x2 - x1)} ${prevY} L ${x2 - (x2 - x1)} ${y} `;
    }
    pathD += `L ${x2} ${y} `;
  });

  const hourMarks = [];
  for (let h = 0; h <= 24; h += 2) hourMarks.push(h);

  const gridStroke = 'hsl(var(--graph-grid))';
  const labelFill = 'hsl(var(--graph-labels))';
  const lineStroke = 'hsl(var(--graph-line))';

  return (
    <div className="w-full overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[640px] h-auto bg-graph rounded-lg border border-border">
        {hourMarks.map((h) => (
          <line key={h} x1={xForHour(h)} y1={topPad} x2={xForHour(h)} y2={topPad + rowH * 4}
            stroke={gridStroke} strokeWidth={h % 6 === 0 ? 1.2 : 0.8} strokeOpacity={h % 6 === 0 ? 0.9 : 0.5} />
        ))}
        {hourMarks.map((h) => (
          <text key={`t${h}`} x={xForHour(h)} y={16} fontSize="12" fill={labelFill} textAnchor="middle">
            {h === 0 ? '12A' : h === 12 ? 'Noon' : h < 12 ? `${h}A` : `${h - 12}P`}
          </text>
        ))}
        {ROW_ORDER.map((status, i) => (
          <g key={status}>
            <rect x={leftPad} y={topPad + i * rowH} width={graphW} height={rowH}
              fill={i % 2 === 0 ? 'hsl(var(--graph-background))' : 'hsl(var(--muted))'} stroke={gridStroke} strokeOpacity={0.5} />
            <text x={leftPad - 8} y={rowCenter(i) + 4} fontSize="11" fontWeight="600" fill={labelFill} textAnchor="end">
              {STATUS_LABELS[status]}
            </text>
          </g>
        ))}
        {allSegs.map((s, i) => (
          <rect key={`s${i}`} x={xForHour(s.startHour)} y={topPad + s.rowIdx * rowH + 4}
            width={Math.max(2, (s.endHour - s.startHour) * graphW / 24)} height={rowH - 8}
            fill={STATUS_COLORS[s.status]} opacity={0.18} rx={2} />
        ))}
        {pathD && (
          <path d={pathD} fill="none" stroke={lineStroke} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
        )}
        {allSegs.map((s, i) => (
          <circle key={`d${i}`} cx={xForHour(s.startHour)} cy={rowCenter(s.rowIdx)} r={3} fill={STATUS_COLORS[s.status]} />
        ))}
      </svg>
      <div className="grid grid-cols-4 gap-2 mt-3 text-center text-xs">
        {ROW_ORDER.map((s) => (
          <div key={s} className="rounded-md border border-border py-1.5">
            <div className="font-semibold text-card-foreground">{STATUS_LABELS[s]}</div>
            <div className="text-muted-foreground">{fmtHours(grid.totals[s])}</div>
          </div>
        ))}
      </div>
      <div className="text-center text-xs text-muted-foreground mt-1">
        Total: {grid.totalHours.toFixed(2)} hr {Math.abs(grid.totalHours - 24) < 0.01 ? '(complete)' : '(incomplete)'}
      </div>
      <div className="mt-3 space-y-1">
        {grid.remarks.map((r, i) => (
          <div key={i} className="flex gap-2 text-xs text-muted-foreground">
            <span className="font-mono w-16 shrink-0">
              {r.time.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: timezone })}
            </span>
            <span className="font-semibold" style={{ color: STATUS_COLORS[r.status] }}>{STATUS_LABELS[r.status]}</span>
            <span className="truncate">{[r.city, r.state].filter(Boolean).join(', ')}{r.remark ? ` — ${r.remark}` : ''}</span>
          </div>
        ))}
      </div>
    </div>
  );
}