import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import LocationInput from '@/components/LocationInput';
import { ExternalLink, ShieldAlert, ClipboardCheck } from 'lucide-react';

// Driver-claimed agricultural interval entry (49 CFR 395.1(k)). Two legal
// bases, plain-language criteria, current official source links. Every
// location/boundary is labeled "Driver attested". A review step shows the
// complete record (with unresolved facts) before the explicit attestation
// checkbox gate — nothing saves without it. Never claims verification and
// never claims to change HOS calculations.
const BASES = [
  { v: 'agricultural_commodity_395_1_k_1', nameKey: 'agricultural.basisCommodity', criteriaKey: 'agricultural.basisCommodityCriteria' },
  { v: 'livestock_final_destination_395_1_k_4', nameKey: 'agricultural.basisLivestock', criteriaKey: 'agricultural.basisLivestockCriteria' },
];

const isoToLocal = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const localToIso = (v) => (v ? new Date(v).toISOString() : null);

export function computeUnresolvedFacts(data, t) {
  const out = [];
  out.push({ title: 'State period', message: t('agricultural.unresolvedSeason') });
  if (data.basis === 'livestock_final_destination_395_1_k_4' && !data.destination_city) {
    out.push({ title: 'Destination', message: t('agricultural.noDestination') });
  }
  return out;
}

export default function ClaimForm({ open, onOpenChange, existing, onSave, saving }) {
  const { t } = useTranslation();
  const [d, setD] = useState(null);
  const [reviewing, setReviewing] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (open) {
      setD(existing ? {
        basis: existing.basis,
        commodity_or_livestock: existing.commodity_or_livestock || '',
        source_city: existing.source_city || '', source_state: existing.source_state || '',
        destination_city: existing.destination_city || '', destination_state: existing.destination_state || '',
        start: isoToLocal(existing.start_timestamp),
        end: isoToLocal(existing.end_timestamp || ''),
        trip_facts: existing.trip_facts || '',
        confirmed: false,
      } : {
        basis: '', commodity_or_livestock: '', source_city: '', source_state: '',
        destination_city: '', destination_state: '', start: '', end: '', trip_facts: '', confirmed: false,
      });
      setReviewing(false);
      setError('');
    }
  }, [open, existing]);

  if (!d) return null;

  const set = (patch) => setD((prev) => ({ ...prev, ...patch }));

  const dataFromForm = () => ({
    basis: d.basis,
    commodity_or_livestock: d.commodity_or_livestock.trim(),
    source_city: d.source_city, source_state: d.source_state,
    destination_city: d.destination_city, destination_state: d.destination_state,
    start_timestamp: localToIso(d.start),
    end_timestamp: localToIso(d.end),
    trip_facts: d.trip_facts.trim(),
    unresolved_facts: computeUnresolvedFacts({ basis: d.basis, destination_city: d.destination_city }, t),
  });

  const validate = () => {
    if (!d.basis) return t('agricultural.basisRequired');
    if (!d.start) return t('agricultural.startTime') + ' — ' + t('logs.startTimeRequired');
    if (d.end && new Date(d.end) <= new Date(d.start)) return t('logs.endAfterStart');
    if (!d.commodity_or_livestock) return t('agricultural.commodityLabel') + ' — ' + t('common.required');
    return '';
  };

  const toReview = () => {
    const err = validate();
    setError(err);
    if (!err) setReviewing(true);
  };

  const submit = () => {
    if (!d.confirmed) { setError(t('agricultural.confirmRequired')); return; }
    onSave(dataFromForm());
  };

  const locText = (city, state) => [city, state].filter(Boolean).join(', ') || '—';

  if (reviewing) {
    const data = dataFromForm();
    return (
      <Dialog open={open} onOpenChange={(o) => { if (!o) onOpenChange(false); }}>
        <DialogContent className="max-w-md max-h-[88vh] overflow-y-auto">
          <DialogHeader><DialogTitle>{t('agricultural.reviewTitle')}</DialogTitle></DialogHeader>
          <div className="text-sm space-y-2 text-card-foreground">
            <Row label={t('agricultural.commodityLabel')} value={data.commodity_or_livestock} />
            <Row label="Legal basis" value={t(data.basis === 'livestock_final_destination_395_1_k_4' ? 'agricultural.basisLivestock' : 'agricultural.basisCommodity')} />
            <Row label={t('agricultural.startTime')} value={data.start_timestamp ? new Date(data.start_timestamp).toLocaleString() : ''} />
            <Row label={t('agricultural.endTime')} value={data.end_timestamp ? new Date(data.end_timestamp).toLocaleString() : t('agricultural.openClaim')} />
            <Row label={t('agricultural.sourceLabel')} value={`${locText(data.source_city, data.source_state)} · ${t('agricultural.driverAttested')}`} />
            <Row label={t('agricultural.destinationLabel')} value={`${locText(data.destination_city, data.destination_state)} · ${t('agricultural.driverAttested')}`} />
            {data.trip_facts && <Row label={t('agricultural.tripFacts')} value={data.trip_facts} />}
            {data.unresolved_facts.map((u, i) => (
              <div key={i} className="text-xs text-warning flex items-start gap-1.5">
                <ShieldAlert className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span><span className="font-semibold">{u.title}:</span> {u.message}</span>
              </div>
            ))}
            <div className="text-[11px] font-bold uppercase tracking-wide text-warning">{t('agricultural.driverClaimed')}</div>
            <label className="flex items-start gap-2 text-xs text-muted-foreground cursor-pointer pt-1 border-t border-border">
              <input type="checkbox" checked={d.confirmed} onChange={(e) => set({ confirmed: e.target.checked })} className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{t('agricultural.confirmStatement')}</span>
            </label>
            {error && <div className="text-xs text-error">{error}</div>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReviewing(false)}>{t('common.back')}</Button>
            <Button onClick={submit} disabled={saving || !d.confirmed}>
              <ClipboardCheck className="w-4 h-4 mr-1" /> {saving ? t('common.saving') : t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onOpenChange(false); }}>
      <DialogContent className="max-w-md max-h-[88vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{existing ? t('agricultural.editClaim') : t('agricultural.addClaim')}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>{t('agricultural.legalBasis')} (49 CFR 395.1(k))</Label>
            <div className="space-y-2 mt-1.5">
              {BASES.map((b) => (
                <button key={b.v} type="button" onClick={() => set({ basis: b.v })}
                  className={`w-full text-left p-3 rounded-lg border text-xs ${d.basis === b.v ? 'border-primary bg-accent text-accent-foreground' : 'border-border text-card-foreground'}`}>
                  <div className="font-semibold">{t(b.nameKey)}</div>
                  <div className="mt-0.5 opacity-80">{t(b.criteriaKey)}</div>
                </button>
              ))}
            </div>
            <a href="https://www.ecfr.gov/current/title-49/subtitle-B/chapter-III/subchapter-B/part-395/subpart-A/section-395.1" target="_blank" rel="noreferrer"
              className="inline-flex items-center gap-1 text-[11px] text-primary underline mt-1.5">
              {t('agricultural.officialSources')}: 49 CFR 395.1 <ExternalLink className="w-3 h-3" />
            </a>
            <a href="https://www.fmcsa.dot.gov/hours-service/elds/eld-hours-service-hos-and-agriculture-exemptions" target="_blank" rel="noreferrer"
              className="inline-flex items-center gap-1 text-[11px] text-primary underline mt-1 ml-2">
              FMCSA guidance <ExternalLink className="w-3 h-3" />
            </a>
          </div>
          <div><Label>{t('agricultural.commodityLabel')}</Label>
            <Input value={d.commodity_or_livestock} onChange={(e) => set({ commodity_or_livestock: e.target.value })} placeholder="e.g. feeder cattle" /></div>
          <div><Label>{t('agricultural.sourceLabel')} · {t('agricultural.driverAttested')}</Label>
            <LocationInput value={{ city: d.source_city, state: d.source_state }} onChange={(loc) => set({ source_city: loc.city ?? d.source_city, source_state: loc.state ?? d.source_state })} /></div>
          <div><Label>{t('agricultural.destinationLabel')} · {t('agricultural.driverAttested')}</Label>
            <LocationInput value={{ city: d.destination_city, state: d.destination_state }} onChange={(loc) => set({ destination_city: loc.city ?? d.destination_city, destination_state: loc.state ?? d.destination_state })} /></div>
          <div className="grid grid-cols-2 gap-2">
            <div><Label>{t('agricultural.startTime')}</Label>
              <Input type="datetime-local" value={d.start} onChange={(e) => set({ start: e.target.value })} /></div>
            <div><Label>{t('agricultural.endTime')}</Label>
              <Input type="datetime-local" value={d.end} onChange={(e) => set({ end: e.target.value })} /></div>
          </div>
          <div><Label>{t('agricultural.tripFacts')}</Label>
            <Input value={d.trip_facts} onChange={(e) => set({ trip_facts: e.target.value })} placeholder={t('agricultural.tripFactsPlaceholder')} /></div>
          {error && <div className="text-xs text-error">{error}</div>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button onClick={toReview}>{t('agricultural.reviewTitle')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Row({ label, value }) {
  return (
    <div className="flex items-start justify-between gap-3 text-xs border-b border-border pb-1.5">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className="text-right font-medium">{value}</span>
    </div>
  );
}