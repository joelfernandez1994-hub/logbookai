import { AlertTriangle, PencilLine } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { fmtClock } from '@/lib/hosEngine';
import { indicatorText } from '@/lib/timezones';

// Specific, actionable notice for MANUAL MODE when the driver's last verified
// duty-status record ends before the current time (a trailing unrecorded
// stretch). HOS clocks ARE verified through that record — this notice only
// withholds the current can-drive-now verdict: activity after the last record
// is unrecorded and could contain driving or on-duty work. Renders nothing
// when availability is fully verified (Live Tracking, or the record reaches
// now). Never edits, fills, or extends anything on its own.
export default function CurrentAvailabilityNotice({ hos, tz, onEdit }) {
  const { t } = useTranslation();
  const av = hos?.availability;
  if (!av || av.status !== 'verified_through' || !av.lastVerifiedAt) return null;
  const time = fmtClock(av.lastVerifiedAt, tz);
  // partialHistory: the verified-through point comes from a PARTIAL
  // calculation (the last continuously recorded instant before an internal
  // gap), not from a clean trailing-gap log. Same concise withholding notice,
  // wording adjusted so the driver knows hours reflect logged time only.
  const partial = !!av.partialHistory;
  return (
    <div data-testid="current-availability-notice" className="rounded-xl border border-warning/50 bg-warning-surface p-3 mb-3 flex gap-2">
      <AlertTriangle className="w-4 h-4 text-warning mt-0.5 shrink-0" />
      <div className="flex-1">
        <div className="text-xs font-semibold text-warning-surface-foreground">{t(partial ? 'availability.partialTitle' : 'availability.unverifiedTitle')}</div>
        <div className="text-xs text-warning-surface-foreground opacity-90 mt-0.5">
          {partial
            ? t('availability.partialBody', { time })
            : t('availability.unverifiedBody', { time, tzName: indicatorText(tz) })}
        </div>
        <div className="text-[11px] text-warning-surface-foreground opacity-80 mt-0.5">
          {t('availability.verifiedThrough', { time })} · LogbookAI never fills gaps or invents Off Duty time.
        </div>
        {onEdit && (
          <Button size="sm" variant="outline" className="mt-2 h-7 text-[11px] px-2 border-warning/50 text-warning-surface-foreground hover:bg-warning/10" onClick={onEdit}>
            <PencilLine className="w-3 h-3 mr-1" /> {t('availability.updateLog')}
          </Button>
        )}
      </div>
    </div>
  );
}