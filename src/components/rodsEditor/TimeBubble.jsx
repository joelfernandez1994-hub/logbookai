import { formatHour, fmtDurationMs } from '@/lib/rodsEditor';

// Large floating time indicator that stays above the driver's finger.
export default function TimeBubble({ x, y, startHour, endHour, status, color }) {
  if (x == null || y == null) return null;
  const hasRange = startHour != null && endHour != null && Math.abs(endHour - startHour) > 1 / 60;
  const lo = Math.min(startHour ?? endHour, endHour ?? startHour);
  const hi = Math.max(startHour ?? endHour, endHour ?? startHour);
  const left = Math.max(8, Math.min(window.innerWidth - 180, x - 80));
  const top = Math.max(8, y - 86);
  return (
    <div
      className="fixed z-50 pointer-events-none select-none"
      style={{ left, top, width: 160 }}
    >
      <div className="rounded-xl bg-slate-900 text-white shadow-2xl px-3 py-2 text-center border border-slate-700">
        {hasRange ? (
          <>
            <div className="text-[11px] text-slate-300 leading-tight">Start</div>
            <div className="text-xl font-bold leading-none tabular-nums">{formatHour(lo)}</div>
            <div className="text-[11px] text-slate-300 leading-tight mt-1">End</div>
            <div className="text-xl font-bold leading-none tabular-nums">{formatHour(hi)}</div>
            <div className="mt-1 inline-block rounded bg-white/15 px-2 py-0.5 text-xs font-semibold">
              {fmtDurationMs((hi - lo) * 3600000)}
            </div>
          </>
        ) : (
          <div>
            <div className="text-[11px] uppercase tracking-wide" style={{ color: color || '#cbd5e1' }}>{status || ''}</div>
            <div className="text-3xl font-bold leading-none tabular-nums">{formatHour(endHour ?? startHour)}</div>
          </div>
        )}
      </div>
    </div>
  );
}