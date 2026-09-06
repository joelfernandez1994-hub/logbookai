import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Wrench } from 'lucide-react';
import { detectTimelineRouteConflicts } from '@/lib/routeAware';
import { Button } from '@/components/ui/button';

// Surfaces route/time conflicts on the canonical saved timeline (visible while
// a driver certifies). Uses the SAME shared validation as ProposalReview, so
// the two never disagree. Explicit driver-entered times are never rewritten —
// this only informs the driver to review before certifying.
//
// A "Fix route timing" action is offered ONLY when at least one conflicted
// Driving leg has an AI-inferred end (field_provenance.end_time = 'inferred').
// Tapping it opens the in-memory review dialog (RouteTimingFixDialog); nothing
// is persisted until the driver confirms there.
export default function RouteTimeConflictNotice({ events, dateStr, tz, speedProfile, now = new Date(), onFix }) {
  const { t } = useTranslation();
  const [conflicts, setConflicts] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    detectTimelineRouteConflicts(events, { dateStr, tz, profileId: speedProfile, now })
      .then(c => { if (mounted) setConflicts(c); })
      .catch(() => { if (mounted) setConflicts([]); })
      .finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, [events, dateStr, tz, speedProfile, now]);

  if (loading || !conflicts.length) return null;

  const fixable = conflicts.some(c => c.endInferred);

  return (
    <div className="rounded-xl border border-error/40 bg-error-surface p-3 mb-3">
      <div className="flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 text-error mt-0.5 shrink-0" />
        <div className="flex-1">
          <div className="text-sm font-medium text-error-surface-foreground">{t('warnings.routeConflictTitle')}</div>
          <div className="text-xs text-error-surface-foreground opacity-80 mt-0.5 mb-2">{t('warnings.routeConflictBody')}</div>
          <div className="space-y-1">
            {conflicts.map((c, i) => (
              <div key={i} className="text-xs text-error-surface-foreground rounded-lg bg-card border border-error/30 px-2 py-1">
                <span className="font-medium">{c.origin} → {c.destination}</span>
                <div className="opacity-90 mt-0.5">{c.message}</div>
              </div>
            ))}
          </div>
          {fixable && onFix && (
            <Button size="sm" variant="outline" className="mt-2 bg-card" onClick={onFix}>
              <Wrench className="w-3.5 h-3.5 mr-1" /> {t('warnings.fixRouteTiming')}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}