import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Plus } from 'lucide-react';
import { findTimelineGaps } from '@/lib/tripSync';
import { Button } from '@/components/ui/button';

export default function TimelineGapNotice({ events, dateStr, tz, now = new Date() }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const gaps = findTimelineGaps(events, dateStr, tz, now);
  if (!gaps.length) return null;

  const fmt = (d) => new Date(d).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: tz });
  const dur = (ms) => ms < 3600000 ? `${Math.round(ms / 60000)} min` : `${(ms / 3600000).toFixed(1)} hr`;

  // "Add record" opens the Logs Add-Event editor prefilled with the exact gap.
  const addRecord = (g) => {
    const params = new URLSearchParams({
      fill_start: new Date(g.start).toISOString(),
      fill_end: new Date(g.end).toISOString(),
      date: new Date(g.start).toISOString().slice(0, 10),
    });
    navigate(`/logs?${params.toString()}`);
  };

  return (
    <div className="rounded-xl border border-warning/50 bg-warning-surface p-3 mb-3">
      <div className="flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 text-warning mt-0.5 shrink-0" />
        <div className="flex-1">
          <div className="text-sm font-medium text-warning-surface-foreground">{t('warnings.timeGapTitle')}</div>
          <div className="text-xs text-warning-surface-foreground opacity-80 mt-0.5 mb-2">{t('warnings.timeGapBody')}</div>
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
        </div>
      </div>
    </div>
  );
}