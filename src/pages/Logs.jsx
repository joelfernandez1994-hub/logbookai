import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useLocation } from 'react-router-dom';
import { dutyStatusLabel } from '@/i18n';
import { useDriverData } from '@/hooks/useDriverData';
import { computeHOS, computeCycle, computeRecordedToday, dateKeyInTz, fmtHours, hasSufficientCycleHistory } from '@/lib/hosEngine';
import { validateTimeline, startOfDayInTz } from '@/lib/timelineEngine';
import { verifyRestHistory, isStaleRestHistoryNote } from '@/lib/restHistoryVerification';
import RestHistoryNotice from '@/components/RestHistoryNotice';
import CurrentAvailabilityNotice from '@/components/CurrentAvailabilityNotice';
import { getDisplayGrid } from '@/lib/timelineDisplay';
import RodsGraphEditor from '@/components/rodsEditor/RodsGraphEditor';
import { getCertifications, getAgriculturalClaims } from '@/lib/driverData';
import { resolvePreferredMph } from '@/lib/mileageSpeed';
import { evaluateAgriculturalClocks } from '@/lib/agriculturalClaims';
import ClaimBanner from '@/components/agricultural/ClaimBanner';
import { base44 } from '@/api/base44Client';
import { insertEvent, editEvent, deleteEventById, clearDayEvents } from '@/lib/timelineWriter';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { ChevronLeft, ChevronRight, BadgeCheck, AlertTriangle, Pencil, Trash2, Plus, Bot, Eraser, CalendarDays } from 'lucide-react';
import LogCalendarPicker from '@/components/LogCalendarPicker';
import { useEffect } from 'react';
import DailyMilesCard from '@/components/DailyMilesCard';
import TimelineGapNotice from '@/components/TimelineGapNotice';
import RouteTimeConflictNotice from '@/components/RouteTimeConflictNotice';
import RouteTimingFixDialog from '@/components/RouteTimingFixDialog';
import PullToRefresh from '@/components/PullToRefresh';
import TimezoneIndicator from '@/components/TimezoneIndicator';
import EventEditor from '@/components/EventEditor';

// Review notes describing timeline structure (gaps/overlaps captured at save
// time) are recalculated against the day's current timeline: once the timeline
// is valid again the gap the note described no longer applies, so it is not
// resurfaced. Notes about facts (pre-trip, break, approximate time, ...) are
// never dropped by timeline validity.
const TIMELINE_NOTE_TYPES = new Set(['structural', 'elapsed_gap', 'overlap', 'same_start_conflict', 'daily_total']);
const isTimelineNote = (n) => !!n && (TIMELINE_NOTE_TYPES.has(n.type) || n.title === 'TIMELINE STRUCTURE');

export default function Logs() {
  const { t } = useTranslation();
  const { profile, carrier, equipment, events, loading, error, reload } = useDriverData(9);
  const navigate = useNavigate();
  const location = useLocation();
  const [selectedDate, setSelectedDate] = useState(() => new Date());
  const [certifications, setCertifications] = useState([]);
  const [editing, setEditing] = useState(null);
  const [adding, setAdding] = useState(false);
  const [prefill, setPrefill] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [certifying, setCertifying] = useState(false);
  const [fixOpen, setFixOpen] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [claims, setClaims] = useState([]);

  const tz = carrier?.home_terminal_timezone || 'America/Chicago';
  const cycleType = carrier?.hos_cycle || '70_8';
  const speedProfile = profile?.trip_planning_speed_profile || 'conservative';

  const loadCerts = async () => {
    setCertifications(await getCertifications(9));
  };
  useEffect(() => {
    loadCerts();
    (async () => { try { setClaims((await getAgriculturalClaims()) || []); } catch (e) {} })();
  }, []);

  // "Add record" from a timeline gap notice: prefill the Add Event dialog.
  // "Add record" from a timeline gap notice: prefill the Add Event dialog.
  // Depend on location.search so tapping "Add record" while already on /logs
  // (where the gap notice also appears) re-opens the editor for the new gap.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const fs = params.get('fill_start');
    const fe = params.get('fill_end');
    const date = params.get('date');
    if (date) setSelectedDate(new Date(date + 'T12:00:00'));
    if (fs) { setPrefill({ start_timestamp: fs, end_timestamp: fe }); setAdding(true); }
  }, [location.search]);

  const dateStr = useMemo(() => dateKeyInTz(selectedDate, tz), [selectedDate, tz]);
  const todayStr = useMemo(() => dateKeyInTz(new Date(), tz), [tz]);
  const grid = useMemo(() => getDisplayGrid(events, dateStr, tz), [events, dateStr, tz]);

  // Keep the selected date in the URL (?date=) without triggering router
  // navigation, so a refresh or browser-back return to /logs restores the
  // exact day the driver was viewing. The existing location.search effect
  // above re-reads it on remount.
  useEffect(() => {
    if (!dateStr) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('date') !== dateStr) {
      window.history.replaceState(null, '', `/logs?date=${dateStr}`);
    }
  }, [dateStr]);

  // Cycle recap gating (deterministic, recalculated from persisted events on
  // every save/edit/delete/refresh): the recorded Driving + On-Duty subtotal
  // is ALWAYS known from the saved timeline, while the history-dependent cycle
  // rows (used/available/returning) require BOTH a gap-free selected day and
  // enough recorded history to span the full lookback window. Missing data is
  // shown as unavailable ('--'), never coerced to 0.00.
  const recordedToday = useMemo(() => computeRecordedToday(events, tz, selectedDate), [events, tz, selectedDate]);
  const dayValidity = useMemo(() => validateTimeline(events, { now: selectedDate, dateStr, timezone: tz }), [events, dateStr, tz]);
  const sufficientHistory = useMemo(
    () => hasSufficientCycleHistory(events, cycleType, profile?.entered_prior_history, tz, selectedDate),
    [events, cycleType, profile?.entered_prior_history, tz, selectedDate]
  );
  // Agricultural claims: the shared clock-availability determination gates the
  // cycle recap on this log date the same way every other surface gates it —
  // claimed work in the lookback window makes the cycle unavailable (never
  // estimated). Unaffected days keep the standard numbers unchanged.
  // (Must run BEFORE cycleUsable below: agCycleAvailable is consumed there.)
  const agEval = useMemo(() => {
    const hosSel = computeHOS(events, cycleType, tz, selectedDate, { historyComplete: sufficientHistory });
    return evaluateAgriculturalClocks({ claims, events, hos: hosSel, cycleType, tz, now: selectedDate });
  }, [claims, events, cycleType, tz, selectedDate, sufficientHistory]);
  const agCycleAvailable = !(agEval && agEval.clocks && agEval.clocks.cycle && agEval.clocks.cycle.unavailable);

  const cycleUsable = dayValidity.valid && sufficientHistory && agCycleAvailable;

  // Rest-history verification for the SELECTED day (deterministic, from the
  // full persisted timeline): a saved "HOS REST HISTORY UNVERIFIED" note is a
  // save-time snapshot — suppressed once recomputation verifies a qualifying
  // reset; while unverified, the exact unresolved interval is surfaced below.
  // (Declared BEFORE dayWarnings, which consumes it in its filter.)
  const restHistory = useMemo(() => {
    const dayEnd = new Date(startOfDayInTz(new Date(dateStr + 'T12:00:00'), tz).getTime() + 24 * 3600000);
    return verifyRestHistory(events, { tz, asOf: dayEnd.getTime() > Date.now() ? new Date() : dayEnd });
  }, [events, dateStr, tz]);

  // Non-blocking review warnings that were unresolved when this day's events
  // were saved (e.g. timeline gaps) — deduped and shown on the day banner and
  // beside the affected entries below, so the driver can still correct them.
  const dayWarnings = useMemo(() => {
    const seen = new Set();
    const out = [];
    for (const e of events) {
      if (!e?.start_timestamp || dateKeyInTz(new Date(e.start_timestamp), tz) !== dateStr) continue;
      for (const n of (e.review_notes || [])) {
        if (isTimelineNote(n) && dayValidity.valid) continue; // gap corrected — no longer applies
        if (isStaleRestHistoryNote(n, restHistory)) continue; // rest verified since save — no longer applies
        const k = `${n.title}|${n.message}`;
        if (!seen.has(k)) { seen.add(k); out.push(n); }
      }
    }
    return out;
  }, [events, dateStr, tz, dayValidity, restHistory]);
  const cycle = useMemo(() => computeCycle(events, cycleType, tz, selectedDate), [events, cycleType, tz, selectedDate]);

  // Manual-mode current-availability context for TODAY: past days evaluate at
  // their real day-end; today evaluates as of now so a trailing unrecorded
  // stretch is classified (verified-through) instead of invalidating the day.
  const hosSelected = useMemo(() => {
    const dayEnd = new Date(startOfDayInTz(new Date(dateStr + 'T12:00:00'), tz).getTime() + 24 * 3600000);
    return computeHOS(events, cycleType, tz, dayEnd.getTime() > Date.now() ? new Date() : dayEnd, { historyComplete: sufficientHistory });
  }, [events, cycleType, tz, dateStr, sufficientHistory]);

  const cert = certifications.find(c => c.log_date === dateStr && !c.is_superseded);
  const isCertified = !!cert;

  const dayKeys = useMemo(() => {
    const days = [];
    for (let i = 0; i < 8; i++) {
      const d = new Date(Date.now() - i * 24 * 3600000);
      days.push(dateKeyInTz(d, tz));
    }
    return days;
  }, [tz]);

  // Day-strip classification (independent indicators): certification is its
  // own marker, and the warning triangle means an ACTUAL unresolved issue for
  // that day (structurally invalid timeline, or rest history that still
  // cannot be verified) — never "merely not certified yet".
  const dayFlags = useMemo(() => {
    const flags = {};
    for (const dk of dayKeys) {
      const dayEnd = new Date(startOfDayInTz(new Date(dk + 'T12:00:00'), tz).getTime() + 24 * 3600000);
      const asOf = dayEnd.getTime() > Date.now() ? new Date() : dayEnd;
      const valid = validateTimeline(events, { now: asOf, dateStr: dk, timezone: tz }).valid;
      const rh = verifyRestHistory(events, { tz, asOf });
      flags[dk] = { issue: !valid || !rh.verified };
    }
    return flags;
  }, [dayKeys, events, tz]);

  const shiftDay = (delta) => {
    if (delta > 0) {
      // Completed activity can never be recorded in the future.
      const nextKey = dateKeyInTz(new Date(selectedDate.getTime() + delta * 24 * 3600000), tz);
      if (nextKey > todayStr) return;
    }
    setSelectedDate(new Date(selectedDate.getTime() + delta * 24 * 3600000));
  };

  const certify = async () => {
    // Guard against a duplicate Certification record from a rapid double-tap
    // (or any lag between click and `isCertified` updating from loadCerts()):
    // this is a driver's legal attestation, not an ordinary save, so it must
    // never fire twice for the same tap.
    if (certifying || isCertified) return;
    setCertifying(true);
    try {
      await base44.entities.Certification.create({
        log_date: dateStr,
        certified_at: new Date().toISOString(),
        signature_data: profile?.signature_data || '',
        signature_name: profile?.legal_name || '',
      });
      await loadCerts();
    } finally {
      setCertifying(false);
    }
  };

  // Both Add and Edit funnel through this single handler. The canonical writer
  // computes ops (split/truncate/dedupe), applies them, preserves an audit
  // version snapshot if the day was certified, and invalidates the certification.
  const saveEvent = async (data) => {
    setSaving(true); setSaveError('');
    try {
      let res;
      if (editing) {
        res = await editEvent(events, editing.id, data, {
          editedBy: profile?.legal_name, reason: 'Manual edit', carrierName: carrier?.carrier_name,
        });
      } else {
        res = await insertEvent(events, {
          ...data,
          log_date: dateKeyInTz(data.start_timestamp, tz),
          is_ongoing: false,
          method_of_creation: 'Manual',
        }, { editedBy: profile?.legal_name, reason: 'Manual add', carrierName: carrier?.carrier_name });
      }
      if (res?.error) { setSaveError(res.error); return; }
      setEditing(null); setAdding(false); setPrefill(null);
      if (location.search) navigate('/logs', { replace: true });
      await reload(); await loadCerts();
    } catch (e) {
      setSaveError(e?.message || t('logs.saveEventError'));
    } finally {
      setSaving(false);
    }
  };

  const removeEvent = async (id) => {
    try {
      await deleteEventById(events, id, { editedBy: profile?.legal_name, reason: 'Manual delete' });
      await reload(); await loadCerts();
    } catch (e) { /* error shown via reload state */ }
  };

  const doClearDay = async () => {
    setClearing(true);
    try {
      await clearDayEvents(events, dateStr, tz, { editedBy: profile?.legal_name, reason: 'Clear day log' });
      setConfirmClear(false);
      await reload(); await loadCerts();
    } catch (e) {
      setSaveError(e?.message || t('logs.clearDayError'));
    } finally {
      setClearing(false);
    }
  };

  return (
    <PullToRefresh onRefresh={reload} className="px-4 pt-6" data-client-version="logs-canonical-timeline-v3">
      <h1 data-client-version="logs-canonical-timeline-v3" className="text-xl font-bold mb-3 text-foreground">{t('logs.title')}</h1>

      <div className="flex gap-2 overflow-x-auto no-scrollbar pb-2 mb-3">
        {dayKeys.map((dk) => {
          const d = new Date(dk + 'T12:00:00');
          const dc = certifications.find(c => c.log_date === dk && !c.is_superseded);
          return (
            <button key={dk} onClick={() => setSelectedDate(new Date(dk + 'T12:00:00'))}
              className={`shrink-0 rounded-lg border px-3 py-2 text-xs text-card-foreground ${dk === dateStr ? 'border-primary bg-accent text-accent-foreground' : 'border-border'}`}>
              <div className="font-medium">{d.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric' })}</div>
              <div className="flex items-center gap-1 mt-0.5">
                {dc
                  ? <BadgeCheck className="w-3 h-3 text-success" />
                  : <span aria-label="Not certified" className="w-3 h-3 rounded-full border border-border inline-block" />}
                {(dayFlags[dk] || {}).issue ? <AlertTriangle className="w-3 h-3 text-warning" /> : null}
              </div>
            </button>
          );
        })}
      </div>

      <div className="flex items-center justify-between mb-3">
        <Button variant="ghost" size="sm" onClick={() => shiftDay(-1)}><ChevronLeft className="w-4 h-4" /></Button>
        <div className="flex items-center gap-1.5">
          <div className="text-center">
            <div className="font-semibold text-foreground">{selectedDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: tz })}</div>
            {isCertified
              ? <span className="text-xs text-success font-medium">✓ {t('logs.certified')}</span>
              : <span className="text-xs text-warning font-medium">{t('logs.needsCertification')}</span>}
          </div>
          <button onClick={() => setShowPicker(true)} aria-label={t('logs.openCalendar')}
            className="inline-flex items-center justify-center min-h-[40px] min-w-[40px] rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors">
            <CalendarDays className="w-4 h-4" />
          </button>
        </div>
        <Button variant="ghost" size="sm" onClick={() => shiftDay(1)}><ChevronRight className="w-4 h-4" /></Button>
      </div>

      <LogCalendarPicker open={showPicker} onOpenChange={setShowPicker}
        selectedDateStr={dateStr} maxDateStr={todayStr} tz={tz}
        onSelect={(key) => setSelectedDate(new Date(key + 'T12:00:00'))} />

      {dayWarnings.length > 0 && (
        <div className="rounded-xl border border-warning/50 bg-warning-surface p-3 mb-3">
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-warning mt-0.5 shrink-0" />
            <div className="flex-1">
              <div className="text-xs font-semibold text-warning-surface-foreground mb-1">Unresolved review items on this log</div>
              {dayWarnings.map((w, i) => (
                <div key={i} className="text-xs text-warning-surface-foreground"><span className="font-medium">{w.title}</span> — {w.message}</div>
              ))}
            </div>
          </div>
        </div>
      )}
      <ClaimBanner claims={claims} dateStr={dateStr} tz={tz}
        showCalcNotice={!!(agEval && agEval.anyUnavailable)} onClaimsChanged={reload} editedBy={profile?.legal_name} />
      <TimelineGapNotice events={events} dateStr={dateStr} tz={tz} now={new Date()} />
      {dateStr === todayStr && <CurrentAvailabilityNotice hos={hosSelected} tz={tz} onEdit={() => setAdding(true)} />}
      <RestHistoryNotice verification={restHistory} tz={tz}
        onEdit={restHistory && restHistory.status === 'unverified' && restHistory.unresolvedRange
          ? () => {
              setPrefill({
                start_timestamp: restHistory.unresolvedRange.start.toISOString(),
                end_timestamp: restHistory.unresolvedRange.end.toISOString(),
              });
              setAdding(true);
            }
          : null} />
      <RouteTimeConflictNotice events={events} dateStr={dateStr} tz={tz} speedProfile={speedProfile} now={new Date()} onFix={() => setFixOpen(true)} />
      <DailyMilesCard events={events} dateStr={dateStr} tz={tz} averageMph={resolvePreferredMph(profile)} />

      {/* p-2 on mobile (down from p-3) so the shared graph editor gets a
          little more real width to plot the full 24-hour day in —
          presentation only, same card/border treatment on larger screens. */}
      <div className="rounded-xl border border-border bg-card p-2 sm:p-3 mb-3">
        <TimezoneIndicator tz={tz} className="mb-2" />
        <RodsGraphEditor events={events} dateStr={dateStr} timezone={tz} carrier={carrier} equipment={equipment} profile={profile} certifications={certifications} reload={reload} loading={loading} error={error} />
      </div>

      <div className="rounded-xl border border-border bg-card p-3 mb-3 text-sm">
        <div className="font-semibold mb-1 text-card-foreground">{t('logs.cycleRecap', { limit: cycle.cycleLimit, days: cycle.cycleDays })}</div>
        <div className="grid grid-cols-2 gap-1 text-xs text-muted-foreground">
          <div>
            {dayValidity.valid
              ? <>{t('logs.today')}: {fmtHours(recordedToday)}</>
              : <>{t('logs.recordedToday')}: {fmtHours(recordedToday)} — {t('logs.incomplete')}</>}
          </div>
          <div>{t('logs.lastNDays', { days: cycle.cycleDays })}: {cycleUsable ? fmtHours(cycle.cycleUsedHours) : '--'}</div>
          <div>{t('logs.available')}: {cycleUsable ? fmtHours(cycle.cycleRemainingHours) : '--'}</div>
          <div>{t('logs.returningTomorrow')}: {cycleUsable ? fmtHours(cycle.returningTomorrowHours) : '--'}</div>
        </div>
        {!cycleUsable && (
          <div className="flex items-center gap-1 mt-1.5 text-xs text-warning font-medium">
            <AlertTriangle className="w-3 h-3 shrink-0" />
            <span>{agCycleAvailable ? t('hos.unavailable') : t('agricultural.clockUnavailableShort')}</span>
          </div>
        )}
      </div>

      <div className="rounded-xl border border-border bg-card p-3 mb-3">
        <div className="flex items-center justify-between mb-2">
          <div className="font-semibold text-sm text-card-foreground">{t('logs.events')}</div>
          <div className="flex gap-1">
            {/* The selected date travels with the driver (?date= survives
                refresh; returnTo sends them back to THIS log day). */}
            <Button size="sm" variant="outline" onClick={() => navigate(`/log-assistant?date=${dateStr}`, { state: { returnTo: `/logs?date=${dateStr}` } })}><Bot className="w-3.5 h-3.5 mr-1" /> {t('logs.assistant')}</Button>
            <Button size="sm" variant="outline" onClick={() => { setPrefill(null); setAdding(true); }}><Plus className="w-3.5 h-3.5 mr-1" /> {t('logs.addEvent')}</Button>
          </div>
        </div>
        <div className="space-y-1">
          {grid.remarks.map((r, i) => {
            const evNotes = ((events.find(e => e.id === r.id)?.review_notes) || []).filter((n) => !(isTimelineNote(n) && dayValidity.valid) && !isStaleRestHistoryNote(n, restHistory));
            return (
            <div key={i} className="rounded-lg border border-border p-2">
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-muted-foreground w-14 shrink-0">
                  {r.time.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: tz })}
                </span>
                <span className="font-semibold text-xs text-card-foreground">{dutyStatusLabel(r.status)}</span>
                <span className="text-xs text-muted-foreground flex-1 truncate">
                  {[r.city, r.state].filter(Boolean).join(', ')}{r.remark ? ` — ${r.remark}` : ''}
                </span>
                <button onClick={() => setEditing(events.find(e => e.id === r.id))} className="inline-flex items-center justify-center min-h-[44px] min-w-[44px] text-muted-foreground hover:text-foreground"><Pencil className="w-3.5 h-3.5" /></button>
                <button onClick={() => removeEvent(r.id)} className="inline-flex items-center justify-center min-h-[44px] min-w-[44px] text-error hover:opacity-80"><Trash2 className="w-3.5 h-3.5" /></button>
              </div>
              {evNotes.length > 0 && (
                <div className="mt-1 space-y-0.5">
                  {evNotes.map((n, ni) => (
                    <div key={ni} className="flex items-start gap-1 text-[11px] text-warning">
                      <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
                      <span>{n.title}: {n.message}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            );
          })}
          {grid.remarks.length === 0 && <div className="text-xs text-muted-foreground text-center py-4">{t('logs.noEventsRecorded')}</div>}
        </div>
      </div>

      <Button className="w-full mb-2" onClick={certify} disabled={isCertified || certifying}>
        {isCertified ? t('logs.certifiedCheck') : t('logs.certifyLog')}
      </Button>
      <Button variant="outline" className="w-full mb-2 text-error border-error/40 hover:bg-error-surface" disabled={clearing} onClick={() => setConfirmClear(true)}>
        <Eraser className="w-4 h-4 mr-2" /> {clearing ? t('logs.clearing') : t('logs.clearDayLog')}
      </Button>

      <EventEditor open={!!editing || adding} event={editing} prefill={prefill} saving={saving} saveError={saveError}
        onClose={() => { setEditing(null); setAdding(false); setPrefill(null); setSaveError(''); if (location.search) navigate('/logs', { replace: true }); }}
        onSave={saveEvent} tz={tz} carrier={carrier} equipment={equipment} isCertified={isCertified} dateStr={dateStr} />

      <RouteTimingFixDialog
        open={fixOpen}
        onClose={() => setFixOpen(false)}
        onApplied={reload}
        events={events}
        dateStr={dateStr}
        tz={tz}
        speedProfile={speedProfile}
        carrierName={carrier?.carrier_name}
        editedBy={profile?.legal_name}
      />

      <Dialog open={confirmClear} onOpenChange={(o) => !clearing && setConfirmClear(o)}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle className="flex items-center gap-2"><AlertTriangle className="w-5 h-5 text-error" /> {t('logs.clearDayTitle', { date: selectedDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: tz }) })}</DialogTitle></DialogHeader>
          <div className="text-sm text-muted-foreground space-y-2">
            <p>{t('logs.clearDayBody1', { date: selectedDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: tz }) })}</p>
            <p>{t('logs.clearDayBody2')}</p>
            <p className="text-error font-medium">{t('logs.clearDayBody3')}</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmClear(false)} disabled={clearing}>{t('common.cancel')}</Button>
            <Button variant="destructive" onClick={doClearDay} disabled={clearing}>{clearing ? t('logs.clearing') : t('logs.clearEntireDay')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PullToRefresh>
  );
}