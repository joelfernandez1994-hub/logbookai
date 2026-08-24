import { formatHour, fmtDurationMs } from '@/lib/rodsEditor';

// Live drag readout rendered in the reserved slot above the graph.
export default function TimeBubble({ startHour, endHour, status, color }) {
  const hasRange = startHour != null && endHour != null && Math.abs(endHour - startHour) > 1 / 60;
  const lo = Math.min(startHour ?? endHour, endHour ?? startHour);
  const hi = Math.max(startHour ?? endHour, endHour ?? startHour);

  return (
    <div className="h-full flex items-center justify-center pointer-events-none select-none" data-testid="graph-drag-readout">
      <div className="w-full max-w-xs rounded-xl bg-primary text-primary-foreground shadow-lg px-3 py-2 text-center border border-primary">
        {hasRange ? (
          <>
            <div className="text-[11px] opacity-70 leading-tight">Start</div>
            <div className="text-xl font-bold leading-none tabular-nums">{formatHour(lo)}</div>
            <div className="text-[11px] opacity-70 leading-tight mt-1">End</div>
            <div className="text-xl font-bold leading-none tabular-nums">{formatHour(hi)}</div>
            <div className="mt-1 inline-block rounded bg-primary-foreground/15 px-2 py-0.5 text-xs font-semibold">
              {fmtDurationMs((hi - lo) * 3600000)}
            </div>
          </>
        ) : (
          <div>
            <div className="text-[11px] uppercase tracking-wide" style={{ color: color || 'currentColor' }}>{status || ''}</div>
            <div className="text-3xl font-bold leading-none tabular-nums">{formatHour(endHour ?? startHour)}</div>
          </div>
        )}
      </div>
    </div>
  );
}