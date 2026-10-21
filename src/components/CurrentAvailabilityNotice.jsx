import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, ChevronDown, ChevronRight, PencilLine, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { fmtClock } from '@/lib/hosEngine';
import { indicatorText } from '@/lib/timezones';

// ONE concise, expandable notice for an unverified-current-availability
// situation. Replaces the previous pair (gap summary + big availability
// warning): the collapsed line states plainly that current driving
// eligibility is UNVERIFIED; expanding reveals the verified-through detail
// and — when the withholding comes from a trailing unlogged stretch — the
// same "Add record" action the gap notice offered. Never edits, fills, or
// extends anything on its own.
export default function CurrentAvailabilityNotice({ hos, tz, onEdit, trailingGap = null }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const av = hos?.availability;
  if (!av || av.status !== 'verified_through' || !av.lastVerifiedAt) return null;
  const time = fmtClock(av.lastVerifiedAt, tz);
  // partialHistory: the verified-through point comes from a PARTIAL
  // calculation (the last continuously recorded instant before an internal
  // gap), not from a clean trailing-gap log. Same concise withholding notice,
  // wording adjusted so the driver knows hours reflect logged time only.
  const partial = !!av.partialHistory;

  // Same prefilled Add-Record route the gap notice uses — one shared flow.
  const addRecord = (g) => {
    const params = new URLSearchParams({
      fill_start: new Date(g.start).toISOString(),
      fill_end: new Date(g.end).toISOString(),
      date: new Date(g.start).toISOString().slice(0, 10),
    });
    navigate(`/logs?${params.toString()}`);
  };

  return (
    <div data-testid="current-availability-notice" className="rounded-xl border border-warning/50 bg-warning-surface mb-3">
      <button type="button" onClick={() => setOpen(o => !o)} className="w-full flex items-center gap-2 px-3 py-2.5 text-left" aria-expanded={open}>
        <AlertTriangle className="w-3.5 h-3.5 text-warning shrink-0" />
        <span className="text-xs font-semibold text-warning-surface-foreground">
          {t(partial ? 'availability.partialTitle' : 'availability.unverifiedTitle')}
        </span>
        <span className="ml-auto flex items-center gap-0.5 text-[11px] font-medium text-warning-surface-foreground opacity-80">
          {t(open ? 'today.logIncompleteHide' : 'today.logIncompleteReview')}
          {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        </span>
      </button>
      {open && (
        <div className="px-3 pb-3">
          <div className="text-xs text-warning-surface-foreground opacity-90">
            {partial
              ? t('availability.partialBody', { time })
              : t('availability.unverifiedBody', { time, tzName: indicatorText(tz) })}
          </div>
          <div className="text-[11px] text-warning-surface-foreground opacity-80 mt-0.5">
            {t('availability.verifiedThrough', { time })} · LogbookAI never fills gaps or invents Off Duty time.
          </div>
          {trailingGap && (
            <div className="mt-2">
              <div className="text-[11px] text-warning-surface-foreground opacity-80 mb-1">{t('warnings.timeGapBody')}</div>
              <div className="flex items-center justify-between gap-2 rounded-lg bg-card border border-warning/30 px-2 py-1">
                <span className="text-xs text-warning-surface-foreground">
                  {fmtClock(trailingGap.start, tz)} → {fmtClock(trailingGap.end, tz)}
                </span>
                <Button size="sm" variant="outline" className="h-7 text-[11px] px-2" onClick={() => addRecord(trailingGap)}>
                  <Plus className="w-3 h-3 mr-1" /> {t('warnings.addRecord')}
                </Button>
              </div>
            </div>
          )}
          {onEdit && (
            <Button size="sm" variant="outline" className="mt-2 h-7 text-[11px] px-2 border-warning/50 text-warning-surface-foreground hover:bg-warning/10" onClick={onEdit}>
              <PencilLine className="w-3 h-3 mr-1" /> {t('availability.updateLog')}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}