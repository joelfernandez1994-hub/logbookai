import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useDriverData } from '@/hooks/useDriverData';
import { base44 } from '@/api/base44Client';
import { getAgriculturalClaims } from '@/lib/driverData';
import {
  agriculturalSupportEnabled, evaluateAgriculturalClocks, basisLabel,
  AGRICULTURAL_DISABLED_NOTICE,
} from '@/lib/agriculturalClaims';
import { computeHOS, dateKeyInTz } from '@/lib/hosEngine';
import ClaimForm from '@/components/agricultural/ClaimForm';
import Header from '@/components/Header';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Tractor, Plus, Pencil, Trash2, ShieldAlert, PauseCircle } from 'lucide-react';

// Review screen for driver-claimed agricultural exemption records
// (49 CFR 395.1(k)). Every claim is labeled DRIVER-CLAIMED — NOT VERIFIED.
// Shows each claim's basis, interval, driver-attested boundaries, unresolved
// facts, and audit trail; supports edit (with before/after review inside the
// form), end-claim (auditable boundary, never restores a clock), and delete.
// Toggling agricultural support off in Settings preserves claims — this page
// then blocks new entry only.
export default function AgriculturalClaims() {
  const { t } = useTranslation();
  const { profile, carrier, events, loading, reload } = useDriverData(9);
  const [claims, setClaims] = useState([]);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [busy, setBusy] = useState(false);

  const tz = carrier?.home_terminal_timezone || 'America/Chicago';
  const cycleType = carrier?.hos_cycle || '70_8';
  const supportEnabled = agriculturalSupportEnabled(profile);

  const loadClaims = async () => {
    setClaims((await getAgriculturalClaims()) || []);
  };
  useEffect(() => { loadClaims(); }, [reload]);

  const now = useMemo(() => new Date(), [claims.length, profile?.id]);
  const agEval = useMemo(() => {
    const hos = computeHOS(events, cycleType, tz, now, { historyComplete: true });
    return evaluateAgriculturalClocks({ claims, events, hos, cycleType, tz, now });
  }, [claims, events, cycleType, tz, now]);

  const snapshotVersion = async (claim, action, note) => {
    try {
      await base44.entities.EventVersion.create({
        original_event_id: claim.id,
        version_number: 1,
        snapshot: { ...claim },
        edited_by: profile?.legal_name || '',
        edit_reason: note,
        action,
      });
    } catch (e) { /* best-effort audit trail */ }
  };

  const saveClaim = async (data) => {
    setBusy(true);
    try {
      const nowIso = new Date().toISOString();
      const logDate = dateKeyInTz(new Date(data.start_timestamp), tz);
      if (editing) {
        await snapshotVersion(editing, 'edited', 'Claim edited with driver review');
        await base44.entities.AgriculturalClaim.update(editing.id, {
          ...data,
          unresolved_facts: data.unresolved_facts,
          audit_log: [...(editing.audit_log || []), { at: nowIso, action: 'edited', by: profile?.legal_name || '', note: 'Edited after review' }],
        });
      } else {
        await base44.entities.AgriculturalClaim.create({
          ...data,
          log_date: logDate,
          status: 'active',
          driver_confirmed: true,
          confirmed_at: nowIso,
          audit_log: [{ at: nowIso, action: 'created', by: profile?.legal_name || '', note: 'Created with explicit driver confirmation' }],
        });
      }
      setFormOpen(false);
      setEditing(null);
      await loadClaims();
      reload();
    } finally {
      setBusy(false);
    }
  };

  const endClaim = async (claim) => {
    setBusy(true);
    try {
      const endedAt = new Date().toISOString();
      await snapshotVersion(claim, 'edited', 'Claim ended');
      await base44.entities.AgriculturalClaim.update(claim.id, {
        status: 'ended',
        ended_at: endedAt,
        ...(claim.end_timestamp ? {} : { end_timestamp: endedAt }),
        audit_log: [...(claim.audit_log || []), { at: endedAt, action: 'ended', by: profile?.legal_name || '', note: 'Claim boundary recorded' }],
      });
      await loadClaims();
      reload();
    } finally {
      setBusy(false);
    }
  };

  const deleteClaim = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      await snapshotVersion(deleting, 'deleted', 'Claim deleted');
      await base44.entities.AgriculturalClaim.delete(deleting.id);
      setDeleting(null);
      await loadClaims();
      reload();
    } finally {
      setBusy(false);
    }
  };

  const fmtRange = (c) => {
    const s = c.start_timestamp ? new Date(c.start_timestamp).toLocaleString() : '--';
    return c.end_timestamp ? `${s} – ${new Date(c.end_timestamp).toLocaleString()}` : `${s} – ${t('agricultural.openClaim')}`;
  };

  return (
    <div className="px-4 pt-6 pb-8 max-w-2xl">
      <Header title={t('agricultural.title')} />
      <p className="text-xs text-muted-foreground mb-3">{t('agricultural.subtitle')}</p>

      <div className="rounded-xl border border-warning/50 bg-warning-surface p-3 mb-4 text-xs text-warning-surface-foreground flex gap-2">
        <Tractor className="w-4 h-4 shrink-0 mt-0.5" />
        <span>{AGRICULTURAL_DISABLED_NOTICE}</span>
      </div>

      {!supportEnabled && (
        <div className="rounded-xl border border-border bg-accent p-3 mb-4 text-xs text-accent-foreground flex gap-2">
          <PauseCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{t('agricultural.supportOffNote')}</span>
        </div>
      )}

      <div className="flex items-center justify-between mb-3">
        <div className="text-sm font-semibold text-card-foreground">{claims.length} {claims.length === 1 ? 'claim' : 'claims'}</div>
        <Button size="sm" disabled={!supportEnabled || busy} onClick={() => { setEditing(null); setFormOpen(true); }}>
          <Plus className="w-3.5 h-3.5 mr-1" /> {t('agricultural.addClaim')}
        </Button>
      </div>

      {loading ? (
        <div className="text-sm text-muted-foreground text-center py-8">{t('common.loading')}</div>
      ) : claims.length === 0 ? (
        <div className="text-sm text-muted-foreground text-center py-8">{t('agricultural.noClaims')}</div>
      ) : (
        <div className="space-y-3">
          {claims.map((c) => {
            const unresolved = c.unresolved_facts || [];
            return (
              <div key={c.id} className="rounded-xl border border-border bg-card p-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-sm font-semibold text-card-foreground">{basisLabel(c.basis)}</div>
                    <div className="text-[10px] font-bold uppercase tracking-wide text-warning mt-0.5">{t('agricultural.driverClaimed')}</div>
                  </div>
                  <span className={`text-[10px] font-semibold border rounded px-1.5 py-0.5 ${c.status === 'active' ? 'border-warning/50 text-warning' : 'border-border text-muted-foreground'}`}>
                    {c.status === 'active' ? t('agricultural.claimActive') : t('agricultural.claimEnded')}
                  </span>
                </div>
                <div className="text-xs text-muted-foreground mt-1.5 space-y-0.5">
                  <div>{t('agricultural.intervalLabel')}: {fmtRange(c)}</div>
                  {c.commodity_or_livestock && <div>{t('agricultural.commodityLabel')}: {c.commodity_or_livestock}</div>}
                  <div>{t('agricultural.sourceLabel')}: {[c.source_city, c.source_state].filter(Boolean).join(', ') || '—'} · {t('agricultural.driverAttested')}</div>
                  {c.destination_city && <div>{t('agricultural.destinationLabel')}: {[c.destination_city, c.destination_state].filter(Boolean).join(', ')} · {t('agricultural.driverAttested')}</div>}
                  {c.trip_facts && <div>{t('agricultural.tripFacts')}: {c.trip_facts}</div>}
                </div>
                {unresolved.length > 0 && (
                  <div className="mt-2 rounded-lg bg-warning-surface border border-warning/40 p-2 text-[11px] text-warning-surface-foreground">
                    <div className="font-semibold mb-0.5">{t('agricultural.unresolvedFacts')}</div>
                    {unresolved.map((u, i) => (
                      <div key={i} className="flex items-start gap-1">
                        <ShieldAlert className="w-3 h-3 mt-0.5 shrink-0" />
                        <span>{u.message}</span>
                      </div>
                    ))}
                  </div>
                )}
                {(agEval?.clocks?.driving?.claimIds || []).includes(c.id) && (
                  <div className="mt-2 text-[11px] text-warning font-medium">{t('agricultural.affectedClocks')}: {t('hos.window14')} · {t('hos.drivingRemaining')} · {t('hos.cycleLabel', { limit: 70, days: 8 })}</div>
                )}
                <div className="flex items-center gap-2 mt-2 pt-2 border-t border-border">
                  <Button size="sm" variant="outline" className="h-8 text-xs" disabled={busy} onClick={() => { setEditing(c); setFormOpen(true); }}>
                    <Pencil className="w-3 h-3 mr-1" /> {t('common.edit')}
                  </Button>
                  {c.status === 'active' && (
                    <Button size="sm" variant="outline" className="h-8 text-xs" disabled={busy} onClick={() => endClaim(c)}>
                      {t('agricultural.endClaim')}
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" className="h-8 text-xs text-error ml-auto" disabled={busy} onClick={() => setDeleting(c)}>
                    <Trash2 className="w-3 h-3 mr-1" /> {t('common.delete')}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <ClaimForm open={formOpen} onOpenChange={(o) => { setFormOpen(o); if (!o) setEditing(null); }} existing={editing} onSave={saveClaim} saving={busy} />

      <Dialog open={!!deleting} onOpenChange={(o) => { if (!o) setDeleting(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>{t('agricultural.deleteClaimTitle')}</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">{t('agricultural.deleteClaimBody')}</p>
          {deleting && <p className="text-xs text-card-foreground">{basisLabel(deleting.basis)}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)}>{t('common.cancel')}</Button>
            <Button variant="destructive" disabled={busy} onClick={deleteClaim}>{t('common.delete')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}