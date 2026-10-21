import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ChevronDown, ChevronRight, Plus, PencilLine, ShieldAlert } from 'lucide-react';
import { findTimelineGaps } from '@/lib/tripSync';
import { Button } from '@/components/ui/button';

// ONE collapsed, compact log-incomplete summary for the Today screen.
// Ordinary recordkeeping warnings (unlogged time gaps between/after records)
// collapse behind a single one-line summary; expanding it reveals the existing
// gap list with the same "Add record" action TimelineGapNotice uses on Logs.
// SERIOUS data conflicts (duplicate records, two statuses starting at the same
// time, an event ending before it starts) are never hidden or collapsed — they
// render prominently in their own error card. Never edits, fills, or extends
// anything on its own.
// excludeGaps: gaps already surfaced by another notice (e.g. the trailing
// unlogged stretch covered by CurrentAvailabilityNotice) so a single
// unlogged interval is never reported by two separate notices.
export default function LogIncompleteNotice({ events, dateStr, tz, now = new Date(), validity, onEdit, excludeGaps = [] }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const gaps = findTimelineGaps(events, dateStr, tz, now).filter(
    (g) => !excludeGaps.some((x) => new Date(x.start).getTime() === g.start.getTime() && new Date(x.end).getTime() === g.end.getTime())
  );
  // Blocking issues that are NOT plain coverage gaps: duplicates, same-start
  // conflicts, negative durations. These make every HOS instant untrustworthy
  // and always stay prominent.
  const serious = (validity?.issues || []).filter(
    (i) => i.severity === 'blocking' && i.type !== 'elapsed_gap' && i.type !== 'daily_total'
  );

  if (!gaps.length && !serious.length) return null;

  if (serious.length) {
    return (
      <div className="rounded-xl border border-error/40 bg-error-surface p-3 mb-3 flex gap-2">
        <ShieldAlert className="w-4 h-4 text-error mt-0.5 shrink-0" />
        <div className="flex-1">
          <div className="text-xs font-semibold text-error-surface-foreground">{t('today.logConflictTitle')}</div>

          <ul className="text-xs text-error-surface-foreground opacity-90 mt-1 mb-2 space-y-0.5 list-disc list-inside">
            {serious.map((iss, i) => <li key={i}>{iss.message}</li>)}
          </ul>
          {onEdit && (
            <Button size="sm" variant="outline" className="h-7 text-[11px] px-2 border-error/40 text-error-surface-foreground hover:bg-error/10" onClick={onEdit}>
              <PencilLine className="w-3 h-3 mr-1" /> {t('logs.editLog')}
            </Button>
          )}
        </div>
      </div>
    );
  }

  const fmt = (d) => new Date(d).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: tz });
  const dur = (ms) => ms < 3600000 ? `${Math.round(ms / 60000)} min` : `${(ms / 3600000).toFixed(1)} hr`;

  // Same prefilled Add-Record route Logs' gap notice uses — one shared flow.
  const addRecord = (g) => {
    const params = new URLSearchParams({
      fill_start: new Date(g.start).toISOString(),
      fill_end: new Date(g.end).toISOString(),
      date: new Date(g.start).toISOString().slice(0, 10),
    });
    navigate(`/logs?${params.toString()}`);
  };

  return (
    <div data-testid="log-incomplete-notice" className="rounded-xl border border-warning/50 bg-warning-surface mb-3">
      <button type="button" onClick={() => setOpen(o => !o)} className="w-full flex items-center gap-2 px-3 py-2.5 text-left" aria-expanded={open}>
        <AlertTriangle className="w-3.5 h-3.5 text-warning shrink-0" />
        <span className="text-xs font-medium text-warning-surface-foreground">
          {t('today.logIncompleteTitle', { count: gaps.length })}
        </span>
        <span className="ml-auto flex items-center gap-0.5 text-[11px] font-medium text-warning-surface-foreground opacity-80">
          {t(open ? 'today.logIncompleteHide' : 'today.logIncompleteReview')}
          {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        </span>
      </button>
      {open && (
        <div className="px-3 pb-3">
          <div className="text-[11px] text-warning-surface-foreground opacity-80 mb-2">{t('warnings.timeGapBody')}</div>
          <div className="space-y-1">
            {gaps.map((g, i) => (
              <div key={i} className="flex items-center justify-between gap-2 rounded-lg bg-card border border-warning/30 px-2 py-1">
                <span className="text-xs text-warning-surface-foreground">{fmt(g.start)} → {fmt(g.end)} <span className="opacity-70">({dur(g.ms)})</span></span>
                <Button size="sm" variant="outline" className="h-7 text-[11px] px-2" onClick={() => addRecord(g)}>
                  <Plus className="w-3 h-3 mr-1" /> {t('warnings.addRecord')}
                </Button>
              </div>
            ))}
          </div>
          {onEdit && (
            <Button size="sm" variant="outline" className="mt-2 h-7 text-[11px] px-2 border-warning/50 text-warning-surface-foreground hover:bg-warning/10" onClick={onEdit}>
              <PencilLine className="w-3 h-3 mr-1" /> {t('logs.editLog')}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}