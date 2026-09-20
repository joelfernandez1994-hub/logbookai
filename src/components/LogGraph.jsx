import { PencilLine } from 'lucide-react';
import { fmtHours } from '@/lib/hosEngine';
import { getDisplayGrid } from '@/lib/timelineDisplay';
import { validateTimeline } from '@/lib/timelineEngine';
import RodsGrid, { ROW_ORDER, STATUS_COLORS, STATUS_ABBR } from '@/components/RodsGrid';

const STATUS_LABELS = {
  OFF_DUTY: 'OFF DUTY',
  SLEEPER_BERTH: 'SLEEPER BERTH',
  DRIVING: 'DRIVING',
  ON_DUTY: 'ON DUTY',
};

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

  // Segments for the shared RodsGrid. Built from the display grid (which is
  // day-clipped and now-capped for the current day) so the line, totals, and
  // event list all share one data source. Future events never appear.
  const allSegs = [];
  ROW_ORDER.forEach((status) => {
    grid.rows[status].forEach((s) => allSegs.push({ ...s, status }));
  });
  allSegs.sort((a, b) => a.startHour - b.startHour);

  return (
    <div className="w-full">
      <RodsGrid segments={allSegs} />

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