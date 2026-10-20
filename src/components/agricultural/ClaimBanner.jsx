import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import { claimsOnDate, basisLabel } from '@/lib/agriculturalClaims';
import { fmtClock } from '@/lib/hosEngine';
import { Button } from '@/components/ui/button';
import { Tractor, AlertTriangle, ExternalLink } from 'lucide-react';

// Amber notice shown on Today / Logs / Inspection for a log date a
// driver-claimed agricultural interval touches. Labels every claim as
// DRIVER-CLAIMED — NOT VERIFIED, lists unresolved facts, and (when any clock
// is unavailable) states plainly that agricultural HOS calculations are
// disabled. Offers Review (claims screen) and End-claim actions; ending only
// records an auditable boundary and never restores a clock.
export default function ClaimBanner({ claims, dateStr, tz, showCalcNotice = false, onClaimsChanged, editedBy }) {
  const { t } = useTranslation();
  const [endingId, setEndingId] = useState(null);
  const [busy, setBusy] = useState(false);
  const dayClaims = useMemo(() => claimsOnDate(claims, dateStr, tz), [claims, dateStr, tz]);

  if (!dayClaims.length) return null;

  const fmtT = (iso) => (iso ? fmtClock(new Date(iso), tz) : '--');
  const range = (c) => c.end_timestamp
    ? `${fmtT(c.start_timestamp)} – ${fmtT(c.end_timestamp)}`
    : `${fmtT(c.start_timestamp)} – ${t('agricultural.openClaim')}`;

  const endClaim = async (c) => {
    setBusy(true);
    try {
      const endedAt = new Date().toISOString();
      await base44.entities.AgriculturalClaim.update(c.id, {
        status: 'ended',
        ended_at: endedAt,
        ...(c.end_timestamp ? {} : { end_timestamp: endedAt }),
        audit_log: [...(c.audit_log || []), { at: endedAt, action: 'ended', by: editedBy || '', note: 'Claim boundary recorded' }],
      });
      if (onClaimsChanged) await onClaimsChanged();
    } finally {
      setBusy(false);
      setEndingId(null);
    }
  };

  return (
    <div className="rounded-xl border border-warning/50 bg-warning-surface p-3 mb-3">
      <div className="flex items-center gap-2 text-sm font-semibold text-warning-surface-foreground">
        <Tractor className="w-4 h-4 shrink-0" />
        <span className="flex-1">{t('agricultural.claimsAffectingClocks')}</span>
        <span className="text-[10px] font-bold uppercase tracking-wide border border-warning/50 rounded px-1.5 py-0.5 shrink-0">{t('agricultural.driverClaimed')}</span>
      </div>
      <div className="mt-2 space-y-2">
        {dayClaims.map((c) => {
          const unresolved = c.unresolved_facts || [];
          return (
            <div key={c.id} className="rounded-lg bg-card border border-border p-2">
              <div className="text-xs font-medium text-card-foreground">{basisLabel(c.basis)} · <span className={c.status === 'active' ? 'text-warning font-semibold' : 'text-muted-foreground'}>{c.status === 'active' ? t('agricultural.claimActive') : t('agricultural.claimEnded')}</span></div>
              <div className="text-xs text-muted-foreground mt-0.5">{t('agricultural.intervalLabel')}: {range(c)}{c.commodity_or_livestock ? ` · ${c.commodity_or_livestock}` : ''}</div>
              {(c.source_city || c.destination_city) && (
                <div className="text-[11px] text-muted-foreground mt-0.5">
                  {[c.source_city, c.source_state].filter(Boolean).join(', ') && <span>{[c.source_city, c.source_state].filter(Boolean).join(', ')}</span>}
                  {c.destination_city && <> → {[c.destination_city, c.destination_state].filter(Boolean).join(', ')}</>}
                  {' '}· {t('agricultural.driverAttested')}
                </div>
              )}
              {unresolved.length > 0 && (
                <div className="text-[11px] text-warning mt-1">
                  <span className="font-semibold">{t('agricultural.unresolvedFacts')}:</span>
                  {unresolved.map((u, i) => <div key={i}>{u.message}</div>)}
                </div>
              )}
              {c.status === 'active' && (
                <div className="mt-1.5">
                  {endingId === c.id ? (
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] text-warning-surface-foreground flex-1">{t('agricultural.endClaimBody')}</span>
                      <Button size="sm" variant="outline" className="h-7 text-[11px] bg-transparent" onClick={() => setEndingId(null)}>{t('common.cancel')}</Button>
                      <Button size="sm" className="h-7 text-[11px]" disabled={busy} onClick={() => endClaim(c)}>{t('common.confirm')}</Button>
                    </div>
                  ) : (
                    <Button size="sm" variant="outline" className="h-7 text-[11px] bg-transparent" onClick={() => setEndingId(c.id)}>{t('agricultural.endClaim')}</Button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {showCalcNotice && (
        <div className="flex gap-1.5 mt-2 text-[11px] text-warning-surface-foreground">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span>{t('agricultural.calcDisabledNotice')}</span>
        </div>
      )}
      <div className="mt-2 flex items-center gap-2">
        <Button asChild size="sm" variant="outline" className="bg-transparent">
          <Link to="/agricultural">{t('agricultural.reviewClaims')}</Link>
        </Button>
        <a href="https://www.ecfr.gov/current/title-49/subtitle-B/chapter-III/subchapter-B/part-395/subpart-A/section-395.1" target="_blank" rel="noreferrer" className="text-[11px] text-muted-foreground underline inline-flex items-center gap-1">
          49 CFR 395.1(k) <ExternalLink className="w-3 h-3" />
        </a>
      </div>
    </div>
  );
}