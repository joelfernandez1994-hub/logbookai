import { useState, useEffect } from 'react';
import { AlertTriangle } from 'lucide-react';
import { detectTimelineRouteConflicts } from '@/lib/routeAware';

// Surfaces route/time conflicts on the canonical saved timeline (visible while
// a driver certifies). Uses the SAME shared validation as ProposalReview, so
// the two never disagree. Explicit driver-entered times are never rewritten —
// this only informs the driver to review before certifying.
export default function RouteTimeConflictNotice({ events, dateStr, tz, speedProfile, now = new Date() }) {
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

  return (
    <div className="rounded-xl border border-error/40 bg-error-surface p-3 mb-3">
      <div className="flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 text-error mt-0.5 shrink-0" />
        <div className="flex-1">
          <div className="text-sm font-medium text-error-surface-foreground">Route / time conflict</div>
          <div className="text-xs text-error-surface-foreground opacity-80 mt-0.5 mb-2">A driving segment is shorter than its route realistically requires. Review the times or locations before certifying.</div>
          <div className="space-y-1">
            {conflicts.map((c, i) => (
              <div key={i} className="text-xs text-error-surface-foreground rounded-lg bg-card border border-error/30 px-2 py-1">
                <span className="font-medium">{c.origin} → {c.destination}</span>
                <div className="opacity-90 mt-0.5">{c.message}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}