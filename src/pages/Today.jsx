import { useState, useMemo, useEffect } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useDriverData } from '@/hooks/useDriverData';
import { dutyStatusLabel } from '@/i18n';
import { computeHOS, fmtDur, fmtClock, dateKeyInTz, hasSufficientCycleHistory } from '@/lib/hosEngine';
import LogGraph from '@/components/LogGraph';
import ClockCard from '@/components/ClockCard';
import StatusChangeSheet from '@/components/StatusChangeSheet';
import { changeStatus, insertEvent, editEvent, updateEventFields, deleteEventById } from '@/lib/timelineWriter';
import { validateTimeline } from '@/lib/timelineEngine';
import { findTimelineGaps } from '@/lib/tripSync';
import { getDvirs, saveDvir } from '@/lib/dvirData';
import { saveDriverProfile, getCertifications, getAgriculturalClaims } from '@/lib/driverData';
import { evaluateAgriculturalClocks, applyAgriculturalAvailability } from '@/lib/agriculturalClaims';
import ClaimBanner from '@/components/agricultural/ClaimBanner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import DvirForm from '@/components/dvir/DvirForm';
import PreTripDialog from '@/components/PreTripDialog';
// Edit Log reuses the EXACT SAME graph editor component the Logs tab uses —
// no second implementation. RodsGraphEditor already owns the swipe/paint
// edit workflow, EventSheet, canonical timelineWriter calls (applyTimelineOps)
// and validation; Today and Logs are just two entry points into it.
import RodsGraphEditor from '@/components/rodsEditor/RodsGraphEditor';
import EventEditor from '@/components/EventEditor';
import { useIsMobile, useIsTouchCapable } from '@/hooks/use-mobile';
import { shouldUseFullScreenEditGraph } from '@/lib/editLogChrome';
import { Truck, Clock, Coffee, RotateCcw, AlertTriangle, MapPin, Bot, ClipboardList, ClipboardCheck, Gauge, Moon, HelpCircle, ShieldCheck, Plus, PencilLine, X, Check } from 'lucide-react';
import DailyMilesCard from '@/components/DailyMilesCard';
import TimezoneIndicator from '@/components/TimezoneIndicator';
import LogIncompleteNotice from '@/components/LogIncompleteNotice';
import RestHistoryNotice from '@/components/RestHistoryNotice';
import CurrentAvailabilityNotice from '@/components/CurrentAvailabilityNotice';
import { verifyRestHistory } from '@/lib/restHistoryVerification';
import PullToRefresh from '@/components/PullToRefresh';

// Display labels are translated via dutyStatusLabel() (presentation layer
// only) — the canonical codes below (OFF_DUTY, SLEEPER_BERTH, DRIVING,
// ON_DUTY) are never translated and never change; they're exactly what's
// written to DutyStatusEvent regardless of the driver's chosen app language.

// Quick 2x2 selector: fixed order, each with a distinct dot color matching
// StatusChangeSheet's palette so the two status pickers stay visually consistent.
const QUICK_STATUSES = [
  { key: 'OFF_DUTY', dot: 'bg-slate-500' },
  { key: 'SLEEPER_BERTH', dot: 'bg-violet-600' },
  { key: 'DRIVING', dot: 'bg-blue-600' },
  { key: 'ON_DUTY', dot: 'bg-orange-600' },
];

function clockStatus(ms) {
  if (ms == null) return 'normal';
  if (ms <= 0) return 'critical';
  if (ms < 3600000) return 'warning';
  return 'normal';
}

export default function Today() {
  const { t, i18n } = useTranslation();
  const i18nLocale = i18n.language === 'es' ? 'es-US' : 'en-US';
  const { profile, carrier, equipment, events, loading, reload } = useDriverData();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  // Which chrome the Edit Log Graph opens in must be decided by touch
  // capability, not viewport width alone — an iPad is >=768px (not
  // "isMobile") but is still touch-primary, and routing it into the Dialog
  // below broke drag-to-draw (see src/lib/editLogChrome.js for why).
  const isTouchCapable = useIsTouchCapable();
  const useFullScreenEditGraph = shouldUseFullScreenEditGraph({ isMobileWidth: isMobile, isTouchCapable });
  const [statusOpen, setStatusOpen] = useState(false);
  const [pretripOpen, setPretripOpen] = useState(false);
  const [pendingStatus, setPendingStatus] = useState(null);
  const [now, setNow] = useState(new Date());
  const [dvirs, setDvirs] = useState([]);
  const [optimisticStatus, setOptimisticStatus] = useState(null);
  const [optimisticSince, setOptimisticSince] = useState(null);
  const [dvirDialogOpen, setDvirDialogOpen] = useState(false);
  const [bolDraft, setBolDraft] = useState('');
  const [bolSaving, setBolSaving] = useState(false);
  const [certifications, setCertifications] = useState([]);
  const [claims, setClaims] = useState([]);
  const [editLogOpen, setEditLogOpen] = useState(false);
  const [editingEvent, setEditingEvent] = useState(null);
  const [deletingEventId, setDeletingEventId] = useState(null);
  const [eventSaving, setEventSaving] = useState(false);
  const [eventSaveError, setEventSaveError] = useState('');

  const tz = carrier?.home_terminal_timezone || 'America/Chicago';
  const cycleType = carrier?.hos_cycle || '70_8';
  const speedProfile = profile?.trip_planning_speed_profile || 'conservative';

  // Default true for existing drivers (field didn't exist before this).
  const liveTrackingEnabled = profile?.live_tracking_enabled !== false;
  const toggleLiveTracking = async (val) => {
    await saveDriverProfile({ ...profile, live_tracking_enabled: val }, profile);
    reload();
  };

  const historyComplete = useMemo(() => hasSufficientCycleHistory(events, cycleType, profile?.entered_prior_history, tz, now), [events, cycleType, profile, tz, now]);
  const openSafetyDefects = useMemo(() => (dvirs || []).filter(d => d.has_safety_defect && d.repair_status === 'pending'), [dvirs]);

  const timelineValidation = useMemo(() => validateTimeline(events, { now, dateStr: dateKeyInTz(now, tz), timezone: tz }), [events, now, tz]);
  // Unlogged stretches on today's log (same finder the LogIncompleteNotice
  // uses). Needed here so the trailing stretch can be routed to
  // CurrentAvailabilityNotice instead of being double-reported.
  const gapsToday = useMemo(() => findTimelineGaps(events, dateKeyInTz(now, tz), tz, now), [events, tz, now]);
  // allowPartial: when the day has an INTERNAL unlogged gap, clocks are still
  // calculated AS OF the last continuously recorded instant — real, verified
  // history — instead of going blank. They are labeled "based on logged time"
  // below and never presented as current driving eligibility. Unresolved data
  // conflicts (duplicates, same-start, negative durations) keep everything
  // unavailable. The HOS engine math itself is untouched.
  const hos = useMemo(() => computeHOS(events, cycleType, tz, now, { historyComplete, allowPartial: true }),
    [events, cycleType, tz, now, historyComplete]);
  // Agricultural claims (49 CFR 395.1(k)): the shared clock-availability
  // determination marks any clock whose calculation history a claim's work
  // overlaps as unavailable — no HOS engine change, no estimated values.
  const agEval = useMemo(() => evaluateAgriculturalClocks({ claims, events, hos, cycleType, tz, now }),
    [claims, events, hos, cycleType, tz, now]);
  const hosEff = useMemo(() => applyAgriculturalAvailability(hos, agEval), [hos, agEval]);
  // Rest-history verification (deterministic, from the full persisted
  // timeline): while unverified the 11h/14h clocks already read '--' above;
  // this surfaces the exact interval that prevents verification with a
  // direct route to the log editor. Verified histories render nothing.
  const restHistory = useMemo(() => verifyRestHistory(events, { tz, asOf: now }), [events, tz, now]);

  useEffect(() => { const t = setTimeout(() => setNow(new Date()), 30000); return () => clearTimeout(t); }, [now]);

  // Keep the BOL draft in sync with whichever event is currently the active
  // status — reset it whenever the underlying event (or its saved value)
  // changes, but don't fight the driver mid-edit on unrelated re-renders.
  // (Reads hos.currentStatus directly, not the `current` const below, since
  // that's declared after the early-return and isn't in scope up here.)
  useEffect(() => { setBolDraft(hos.currentStatus?.bill_of_lading_number || ''); }, [hos.currentStatus?.id, hos.currentStatus?.bill_of_lading_number]);

  useEffect(() => { (async () => { try { setDvirs(await getDvirs(30) || []); } catch (e) {} })(); }, [reload]);
  useEffect(() => { (async () => { try { setCertifications(await getCertifications(9) || []); } catch (e) {} })(); }, [reload]);
  useEffect(() => { (async () => { try { setClaims((await getAgriculturalClaims()) || []); } catch (e) {} })(); }, [reload]);

  const needsOnboarding = !profile || !profile.onboarded || !profile.has_acknowledged_non_eld;
  useEffect(() => {
    if (!loading && needsOnboarding) navigate('/onboarding', { replace: true });
  }, [loading, needsOnboarding, navigate]);

  if (loading || needsOnboarding) {
    return <div className="flex items-center justify-center h-screen"><div className="w-8 h-8 border-4 border-muted border-t-foreground rounded-full animate-spin" /></div>;
  }

  const todayKey = dateKeyInTz(now, tz);
  // Partial calculation label: states plainly that the values reflect LOGGED
  // time through the verified instant — not permission to drive right now.
  const loggedNote = hos.partial && hos.partialAsOf
    ? t('hos.basedOnLogged', { time: fmtClock(hos.partialAsOf, tz) })
    : null;
  const current = hos.currentStatus;
  // Current availability withheld (last verified record ends before now)?
  const av = hos?.availability;
  const availabilityUnverified = !!(av && av.status === 'verified_through' && av.lastVerifiedAt);
  // The trailing unlogged stretch (its end is "now") — owned by the
  // availability notice, so the gap summary never repeats it.
  const trailingGap = availabilityUnverified
    ? gapsToday.find((g) => now.getTime() - g.end.getTime() < 120000)
    : null;
  // ONE calculation timestamp beside the balances, whichever mode produced
  // it: partial ("based on logged time") or trailing gap ("verified
  // through"). Never presented as permission to drive right now.
  const clockNote = loggedNote || (availabilityUnverified
    ? t('hos.verifiedThroughNote', { time: fmtClock(av.lastVerifiedAt, tz) })
    : null);
  const displayStatus = optimisticStatus || current?.duty_status;
  const displaySince = optimisticStatus ? optimisticSince : current?.start;
  const todayDvirs = (dvirs || []).filter(d => d.log_date === todayKey);
  const latestTodayDvir = todayDvirs[0];

  const tourStart = hos.driving.tourStart;
  const hasPretripInTour = tourStart ? events.some(e =>
    e.duty_status === 'ON_DUTY' && e.remark === 'Pre-Trip Inspection' && new Date(e.start_timestamp) >= tourStart
  ) : false;

  const handleChangeStatus = (details) => {
    if (details.duty_status === 'DRIVING' && tourStart && !hasPretripInTour) {
      setPendingStatus(details);
      setPretripOpen(true);
      setStatusOpen(false);
      return;
    }
    applyChange(details);
  };

  const applyChange = async (details) => {
    setOptimisticStatus(details.duty_status);
    setOptimisticSince(new Date());
    await changeStatus(details.duty_status, {
      city: details.city, state: details.state, remark: details.remark,
      tractor_number: details.tractor_number, trailer_numbers: details.trailer_numbers,
      carrier_name: carrier?.carrier_name,
    }, events);
    setStatusOpen(false);
    setPretripOpen(false);
    await reload();
    setOptimisticStatus(null);
    setOptimisticSince(null);
  };

  // Quick 2x2 selector: tap a status to switch to it right now, carrying
  // forward the current location/equipment/BOL (the common case — status
  // changes rarely mean "and I also teleported"). Still routes through the
  // exact same handleChangeStatus → changeStatus canonical writer as the
  // "Change Status" sheet, so the pre-trip gate and dedupe/fill-blank logic
  // apply identically either way.
  const handleQuickStatus = (key) => {
    if (key === (displayStatus || current?.duty_status)) return; // already active
    handleChangeStatus({
      duty_status: key,
      city: current?.city || '', state: current?.state || '',
      remark: '',
      tractor_number: current?.tractor_number || equipment?.[0]?.unit_number || '',
      trailer_numbers: current?.trailer_numbers || equipment?.find(e => e.type === 'trailer')?.unit_number || '',
      bill_of_lading_number: current?.bill_of_lading_number || '',
    });
  };

  // BOL / shipping doc # is metadata on the current open status — a plain
  // in-place field patch, never a new duty-status event.
  const handleSaveBol = async () => {
    if (!current?.id || bolDraft === (current?.bill_of_lading_number || '')) return;
    setBolSaving(true);
    try {
      await updateEventFields(events, current.id, { bill_of_lading_number: bolDraft }, { reason: 'Update BOL / shipping doc #' });
      await reload();
    } finally {
      setBolSaving(false);
    }
  };

  const handleSaveEventEdit = async (data) => {
    if (!editingEvent?.id) return;
    setEventSaving(true); setEventSaveError('');
    try {
      const res = await editEvent(events, editingEvent.id, data, {
        editedBy: profile?.legal_name, reason: 'Manual status edit', carrierName: carrier?.carrier_name,
      });
      if (res?.error) { setEventSaveError(res.error); return; }
      setEditingEvent(null);
      await reload();
    } catch (e) {
      setEventSaveError(e?.message || t('logs.saveEventError'));
    } finally {
      setEventSaving(false);
    }
  };

  // Same canonical delete path as the Logs tab: deleteEventById (audit
  // snapshot via the shared timeline writer) → reload. No extra eligibility
  // rules on Today — exact parity with Logs.
  const handleDeleteEvent = async (id) => {
    if (!id || deletingEventId) return;
    setDeletingEventId(id);
    try {
      await deleteEventById(events, id, { editedBy: profile?.legal_name, reason: 'Manual delete' });
      await reload();
    } finally {
      setDeletingEventId(null);
    }
  };

  const handleSaveDvir = async (data) => {
    await saveDvir(data);
    setDvirDialogOpen(false);
    try { setDvirs(await getDvirs(30) || []); } catch (e) {}
  };

  const handlePretripConfirm = async ({ start_timestamp, duration_min, city, state, alreadySatisfied }) => {
    if (alreadySatisfied) {
      setPretripOpen(false);
      if (pendingStatus) await applyChange(pendingStatus);
      setPendingStatus(null);
      return;
    }
    const start = new Date(start_timestamp);
    await insertEvent(events, {
      log_date: todayKey,
      start_timestamp: start.toISOString(),
      end_timestamp: new Date(start.getTime() + duration_min * 60000).toISOString(),
      duty_status: 'ON_DUTY',
      remark: 'Pre-Trip Inspection',
      city: city || pendingStatus?.city || '', state: state || pendingStatus?.state || '',
      method_of_creation: 'Manual',
      is_ongoing: false,
    }, { carrierName: carrier?.carrier_name, reason: 'Pre-trip inspection' });
    setPretripOpen(false);
    if (pendingStatus) await applyChange(pendingStatus);
    setPendingStatus(null);
    reload();
  };

  const restartProgress = hos.restart.inProgress && !hosEff.restart.agriculturalUnavailable ? hos.restart.inProgress : null;

  return (
    <PullToRefresh onRefresh={reload} className="px-4 pt-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">{t('app.name')}</h1>
          <p className="text-xs text-muted-foreground">{t('app.tagline')} · {carrier?.ruleset_version?.split(' — ')[0]}</p>
        </div>
        <div className="text-right">
          <p className="text-sm font-medium text-foreground">{now.toLocaleDateString(i18nLocale, { weekday: 'short', month: 'short', day: 'numeric', timeZone: tz })}</p>
          <p className="text-xs text-muted-foreground">{t('today.logbook', { time: fmtClock(now, tz) })}</p>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card p-4 mb-3">
        <div className="flex items-center justify-between">
          <div className="text-xs text-muted-foreground font-medium">{t('today.currentStatus')}</div>
          <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground cursor-pointer">
            {t('today.liveTracking')}
            <input type="checkbox" role="switch" aria-checked={liveTrackingEnabled} checked={liveTrackingEnabled}
              onChange={(e) => toggleLiveTracking(e.target.checked)} className="w-4 h-4" />
          </label>
        </div>
        {!liveTrackingEnabled && (
          <div className="text-[11px] text-warning-surface-foreground bg-warning-surface border border-warning/50 rounded-md px-2 py-1 mt-1.5">
            <Trans i18nKey="today.liveTrackingPaused"
              components={{
                askAi: <button type="button" className="underline font-medium" onClick={() => navigate('/log-assistant')} />,
                logs: <button type="button" className="underline font-medium" onClick={() => navigate('/logs')} />,
              }} />
          </div>
        )}
        {(displayStatus || current) ? (
          <div className="flex items-baseline gap-2 mt-1">
            <span className="text-2xl font-bold text-card-foreground uppercase">{dutyStatusLabel(displayStatus || current.duty_status)}</span>
            <span className="text-sm text-muted-foreground">{t('today.since', { time: fmtClock(displaySince || current.start, tz) })}</span>
          </div>
        ) : (
          <div className="text-2xl font-bold mt-1 text-muted-foreground">{t('today.noActiveStatus')}</div>
        )}
        {current?.city && (
          <div className="flex items-center gap-1 text-sm text-muted-foreground mt-1">
            <MapPin className="w-3.5 h-3.5" /> {current.city}{current.state ? `, ${current.state}` : ''}
          </div>
        )}
        <TimezoneIndicator tz={tz} className="mt-1" />

        {/* Quick 2x2 status selector — current status highlighted, stays active
            until another is tapped. For location/remark/equipment changes at
            the same time, "Change Status" below still opens the full sheet. */}
        <div className={`grid grid-cols-2 gap-2 mt-3 ${!liveTrackingEnabled ? 'opacity-40' : ''}`}>
          {QUICK_STATUSES.map((s) => {
            const active = s.key === (displayStatus || current?.duty_status);
            return (
              <button key={s.key} type="button" disabled={!liveTrackingEnabled} onClick={() => handleQuickStatus(s.key)}
                className={`flex items-center gap-2 rounded-lg border p-3 text-sm font-medium transition min-h-[44px] disabled:cursor-not-allowed ${active ? 'border-primary bg-accent text-accent-foreground' : 'border-border text-card-foreground'}`}>
                <span className={`w-3 h-3 rounded-full shrink-0 ${s.dot}`} />
                {dutyStatusLabel(s.key, { quick: true })}
                {active && <span className="ml-auto text-[10px] font-semibold uppercase tracking-wide text-primary">{t('today.active')}</span>}
              </button>
            );
          })}
        </div>

        {/* BOL / shipping doc # — metadata on the current status, saved via a
            plain field patch (never a new duty-status event). */}
        <div className="mt-3">
          <label className="text-[11px] text-muted-foreground font-medium">{t('today.bolLabel')}</label>
          <div className="flex gap-2 mt-1">
            <Input value={bolDraft} onChange={(e) => setBolDraft(e.target.value)} onBlur={handleSaveBol}
              placeholder={current ? t('today.bolPlaceholder') : t('today.bolPlaceholderNoStatus')} disabled={!current?.id} className="h-10" />
            {bolDraft !== (current?.bill_of_lading_number || '') && (
              <Button size="sm" className="h-10" disabled={bolSaving || !current?.id} onClick={handleSaveBol}>{bolSaving ? t('today.saving') : t('today.save')}</Button>
            )}
          </div>
        </div>
      </div>

      {/* Today's 24-Hour Log — moved directly under the current-status /
          quick-status section (layout-order change only; graph/timeline/HOS
          logic below is untouched). */}
      <div className="rounded-xl border border-border bg-card p-3 mb-4">
        <div className="flex items-center justify-between mb-2"><div className="text-sm font-semibold text-card-foreground">{t('today.todaysLog')}</div><TimezoneIndicator tz={tz} /></div>
        <LogGraph events={events} dateStr={todayKey} timezone={tz}
          onEditEvent={(id) => setEditingEvent(events.find(e => e.id === id))}
          onDeleteEvent={handleDeleteEvent} />
        <Button variant="outline" size="sm" className="w-full mt-3" onClick={() => setEditLogOpen(true)}>
          <PencilLine className="w-3.5 h-3.5 mr-1" /> {t('logs.editLog')}
        </Button>
      </div>

      {/* Log incomplete — ONE compact, collapsed summary for ordinary
          recordkeeping warnings (unlogged time gaps). Serious data conflicts
          (duplicates, same-start, negative durations) render prominently
          inside the component and are never hidden or collapsed. */}
      <LogIncompleteNotice events={events} dateStr={todayKey} tz={tz} now={now} validity={timelineValidation} excludeGaps={trailingGap ? [trailingGap] : []} onEdit={() => setEditLogOpen(true)} />
      <RestHistoryNotice verification={restHistory} tz={tz} onEdit={() => setEditLogOpen(true)} />
      {/* Manual mode: last verified record ends before now — clocks above are
          verified through that record; current can-drive availability is
          withheld until the driver records the trailing stretch. */}
      <CurrentAvailabilityNotice hos={hos} tz={tz} trailingGap={trailingGap} onEdit={() => setEditLogOpen(true)} />
      <ClaimBanner claims={claims} dateStr={todayKey} tz={tz}
        showCalcNotice={!!(agEval && agEval.anyUnavailable)} onClaimsChanged={reload} editedBy={profile?.legal_name} />

      {/* Clocks gate on hos.calculable (which includes the verified partial
          calculation), NOT timelineValidation.valid — an internal gap no
          longer blanks every clock. When partial, each card carries the
          "based on logged time through X — not current availability" note. */}
      <div className="grid grid-cols-2 gap-2 mb-3">
        <ClockCard label={t('hos.drivingRemaining')} value={hos.calculable && hosEff.driving.applicable ? fmtDur(hosEff.driving.drivingRemainingMs) : '--'}
          sublabel={hos.calculable && hosEff.driving.applicable ? (hosEff.driving.expiresAt ? t('hos.expiresAt', { time: fmtClock(hosEff.driving.expiresAt, tz) }) : t('hos.elevenHourLimit')) : (hosEff.driving.agriculturalUnavailable ? t('agricultural.clockUnavailableShort') : t('hos.unavailable'))}
          note={clockNote && hosEff.driving.applicable ? clockNote : null}
          status={hos.calculable && hosEff.driving.applicable ? clockStatus(hosEff.driving.drivingRemainingMs) : 'disabled'} icon={Truck} />
        <ClockCard label={t('hos.window14')} value={hos.calculable && hosEff.window14.applicable ? fmtDur(hosEff.window14.remainingMs) : '--'}
          sublabel={hos.calculable && hosEff.window14.applicable ? (hosEff.window14.windowStart ? t('hos.sinceTime', { time: fmtClock(hosEff.window14.windowStart, tz) }) : '') : (hosEff.window14.agriculturalUnavailable ? t('agricultural.clockUnavailableShort') : t('hos.unavailable'))}
          note={clockNote && hosEff.window14.applicable ? clockNote : null}
          status={hos.calculable && hosEff.window14.applicable ? clockStatus(hosEff.window14.remainingMs) : 'disabled'} icon={Clock} />
        <ClockCard label={t('hos.break30')} value={hos.calculable && !hosEff.break30.agriculturalUnavailable ? (hosEff.break30.satisfied ? t('hos.satisfied') : t('hos.timeLeft', { time: fmtDur(hosEff.break30.remainingBeforeBreakMs) })) : '--'}
          sublabel={hos.calculable && !hosEff.break30.agriculturalUnavailable ? (hosEff.break30.breakRequired ? t('hos.breakRequiredNow') : t('hos.eightHourRule')) : (hosEff.break30.agriculturalUnavailable ? t('agricultural.clockUnavailableShort') : t('hos.unavailable'))}
          note={clockNote && !hosEff.break30.agriculturalUnavailable ? clockNote : null}
          status={hos.calculable && !hosEff.break30.agriculturalUnavailable ? (hosEff.break30.breakRequired ? 'critical' : 'normal') : 'disabled'} icon={Coffee} />
        <ClockCard label={t('hos.cycleLabel', { limit: hosEff.cycle.cycleLimit, days: hosEff.cycle.cycleDays })} value={hos.calculable && !hosEff.cycle.agriculturalUnavailable ? t('hos.hoursLeft', { hours: hosEff.cycle.cycleRemainingHours.toFixed(1) }) : '--'}
          sublabel={hos.calculable && !hosEff.cycle.agriculturalUnavailable ? t('hos.usedBackTomorrow', { used: hosEff.cycle.cycleUsedHours.toFixed(1), back: hosEff.cycle.returningTomorrowHours.toFixed(1) }) : (hosEff.cycle.agriculturalUnavailable ? t('agricultural.clockUnavailableShort') : t('hos.unavailable'))}
          note={clockNote && !hosEff.cycle.agriculturalUnavailable ? clockNote : null}
          status={hos.calculable && !hosEff.cycle.agriculturalUnavailable ? clockStatus(hosEff.cycle.cycleRemainingHours * 3600000) : 'disabled'} icon={Gauge} />
      </div>

      {restartProgress && (
        <div className="rounded-xl border border-border bg-accent p-3 mb-3">
          <div className="flex items-center gap-2 text-sm font-medium text-accent-foreground">
            <RotateCcw className="w-4 h-4" /> {t('today.restartInProgress')}
          </div>
          <div className="text-xs text-muted-foreground mt-1">
            {t('today.restartStatus', { elapsed: fmtDur(restartProgress.elapsedMs), remaining: fmtDur(restartProgress.remainingMs), eta: fmtClock(restartProgress.estimatedCompletion, tz) })}
          </div>
        </div>
      )}
      {hosEff.split.status !== 'none' && (
        <div className="rounded-xl border border-border bg-card p-3 mb-3">
          <div className="flex items-center gap-2 text-sm font-medium text-card-foreground">
            <Moon className="w-4 h-4" /> {hosEff.split.status === 'active' ? t('today.splitSleeperActive') : t('today.splitSleeperAvailable')}
            <span className="ml-auto text-[10px] font-medium text-muted-foreground border border-border rounded px-1.5 py-0.5">{t('today.optional')}</span>
          </div>
          <div className="text-xs text-muted-foreground mt-1">{hosEff.split.note}</div>
          {hosEff.split.status === 'active' && hosEff.split.firstPeriod && hosEff.split.secondPeriod && (
            <div className="text-xs text-muted-foreground mt-1">
              Paired periods: {fmtDur(hosEff.split.firstPeriod.duration)} {hosEff.split.firstPeriod.status === 'SLEEPER_BERTH' ? 'Sleeper Berth' : 'Off Duty'} + {fmtDur(hosEff.split.secondPeriod.duration)} {hosEff.split.secondPeriod.status === 'SLEEPER_BERTH' ? 'Sleeper Berth' : 'Off Duty'} · 11-hr & 14-hr clocks recalculated from the first qualifying period (FMCSA §395.1(g)).
            </div>
          )}
          {hosEff.split.status === 'available' && !hosEff.split.agriculturalUnavailable && (
            <div className="text-xs text-muted-foreground mt-1 space-y-0.5">
              <div>
                Complete the pair with at least {fmtDur(hosEff.split.requiredSecondMs)} more qualifying rest
                {hosEff.split.secondPeriod ? ` (${fmtDur(hosEff.split.secondPeriod.duration)} taken so far, ${fmtDur(hosEff.split.additionalMs)} more needed)` : ''}.
              </div>
              {hosEff.split.projectedDrivingRemainingMs != null && hosEff.split.projectedWindowRemainingMs != null && (
                <div>
                  Once completed: ~{fmtDur(Math.max(0, hosEff.split.projectedDrivingRemainingMs))} driving and ~{fmtDur(Math.max(0, hosEff.split.projectedWindowRemainingMs))} on the 14-hour window would be available.
                </div>
              )}
              <div className="text-[11px] text-muted-foreground/80">Optional — a full 10-hour rest always works too. Split sleeper does not reset the 60/70-hour cycle.</div>
            </div>
          )}
        </div>
      )}
      {openSafetyDefects.length > 0 && (
        <div className="rounded-xl border border-error/40 bg-error-surface p-3 mb-3 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-error mt-0.5 shrink-0" />
          <div className="text-xs text-error-surface-foreground">
            <span className="font-semibold">{t('today.safetyDefectPending')}</span> {t('today.vehicleUnsafe')}
            <button className="underline ml-1 font-medium" onClick={() => navigate('/vehicle-inspection')}>{t('today.reviewDvir')}</button>
          </div>
        </div>
      )}
      {profile?.dvir_reminder_enabled && openSafetyDefects.length === 0 && (
        <div className="rounded-xl border border-border bg-card p-3 mb-3 flex items-start gap-2">
          <ClipboardCheck className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" />
          <div className="text-xs text-muted-foreground">
            {t('today.dvirReminder')}
            <button className="underline ml-1 font-medium text-foreground" onClick={() => navigate('/vehicle-inspection')}>{t('today.openDvir')}</button>
          </div>
        </div>
      )}
      {!historyComplete && (
        <div className="rounded-xl border border-warning/50 bg-warning-surface p-3 mb-3 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-warning mt-0.5 shrink-0" />
          <div className="text-xs text-warning-surface-foreground">
            {t('today.cycleAvailabilityNote', { cycleDays: cycleType === '70_8' ? t('today.cycle8Day') : t('today.cycle7Day') })}
          </div>
        </div>
      )}

      {/* Daily DVIR — quick status + one-tap access for TODAY only; the full
          history stays on the dedicated Vehicle Inspection page. */}
      <div className="rounded-xl border border-border bg-card p-3 mb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-semibold text-card-foreground">
            <ClipboardCheck className="w-4 h-4" /> {t('today.dailyDvir')}
          </div>
          <Button size="sm" variant="outline" onClick={() => setDvirDialogOpen(true)}>
            <Plus className="w-3.5 h-3.5 mr-1" /> {todayDvirs.length > 0 ? t('today.addAnother') : t('today.startInspection')}
          </Button>
        </div>
        {latestTodayDvir ? (
          <div className="text-xs text-muted-foreground mt-1.5">
            {t('today.latestToday')} <span className={latestTodayDvir.inspection_result === 'defects' ? 'text-error font-medium' : 'text-success font-medium'}>
              {latestTodayDvir.inspection_result === 'defects' ? t('today.defectsReported') : t('today.noDefects')}
            </span> · {t('today.tractorUnit', { unit: latestTodayDvir.tractor_number })}
          </div>
        ) : (
          <div className="text-xs text-muted-foreground mt-1.5">{t('today.noInspectionToday')}</div>
        )}
        <button type="button" onClick={() => navigate('/vehicle-inspection')} className="text-[11px] text-muted-foreground underline mt-1">{t('today.viewInspectionHistory')}</button>
      </div>

      <DailyMilesCard events={events} dateStr={todayKey} tz={tz} speedProfile={speedProfile} />

      {/* Primary action */}
      <Button className="w-full h-14 text-base font-semibold mb-3" disabled={!liveTrackingEnabled} onClick={() => setStatusOpen(true)}>
        {t('today.changeStatus')}
      </Button>

      {/* Secondary actions — stack on phones, side-by-side only when both labels fit (≥640px) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 mb-2.5">
        <Button variant="outline" className="h-12 text-sm" onClick={() => navigate('/log-assistant')}>
          <Bot className="w-4 h-4 shrink-0" /> {t('today.askLogbookAi')}
        </Button>
        <Button variant="outline" className="h-12 text-sm" onClick={() => navigate('/compliance')}>
          <ShieldCheck className="w-4 h-4 shrink-0" /> {t('today.hosCompliance')}
        </Button>
      </div>

      <Button variant="outline" className="w-full h-12 text-sm mb-4" onClick={() => navigate('/logs')}>
        <ClipboardList className="w-4 h-4 shrink-0" /> {t('today.viewFullLog')}
      </Button>

      {/* Help link — small, not a boxed action */}
      <button
        type="button"
        onClick={() => navigate('/log-assistant?tab=whatCanIDo')}
        className="w-full flex items-center justify-center gap-1.5 text-xs text-muted-foreground mb-8 py-1"
      >
        <HelpCircle className="w-3.5 h-3.5" /> {t('today.whatCanIDo')}
      </button>

      <StatusChangeSheet open={statusOpen} onOpenChange={setStatusOpen} onApply={handleChangeStatus}
        defaultEquipment={{ tractor: equipment?.[0]?.unit_number, trailer: equipment?.find(e => e.type === 'trailer')?.unit_number }} />

      <PreTripDialog open={pretripOpen} onOpenChange={setPretripOpen}
        drivingStart={pendingStatus ? new Date() : null}
        defaultCity={pendingStatus?.city} defaultState={pendingStatus?.state}
        onConfirm={handlePretripConfirm} />

      {/* Edit Log — same RodsGraphEditor instance/component Logs.jsx renders,
          fed with Today's own data. Its own reload prop is Today's reload
          (from useDriverData), so saving here refreshes Today's graph/HOS
          immediately — same canonical timeline, same writer, same validation.
          On any touch-primary device (phone OR tablet — see
          shouldUseFullScreenEditGraph in @/lib/editLogChrome) it opens as a
          dedicated full-screen editor instead of a card-sized modal (touch
          accuracy over fitting into a card, and it sidesteps the Radix
          Dialog scroll-lock that broke tablet drag-to-draw); desktop mouse
          keeps the existing centered dialog. Either way it's the exact same
          RodsGraphEditor + event-writing path, just different chrome. */}
      {editLogOpen && useFullScreenEditGraph ? (
        <div className="fixed inset-0 z-50 bg-background flex flex-col">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border safe-top shrink-0">
            <div className="font-semibold text-foreground">{t('logs.editLog')}</div>
            <button type="button" onClick={() => setEditLogOpen(false)} aria-label={t('common.close')} className="p-1 -mr-1 text-muted-foreground">
              <X className="w-5 h-5" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto px-2 py-2">
            <TimezoneIndicator tz={tz} className="mb-1" />
            <RodsGraphEditor events={events} dateStr={todayKey} timezone={tz} carrier={carrier} equipment={equipment} profile={profile} certifications={certifications} reload={reload} />
          </div>
          {/* Fixed footer, clear of the (now-hidden) bottom nav and the home
              indicator. Every actual data change already goes through
              RodsGraphEditor's own EventSheet -> ProposedChangeDialog Apply
              flow and is persisted immediately — these two buttons close the
              full-screen editor, they don't hold back a batch of changes. */}
          <div className="shrink-0 border-t border-border bg-background px-4 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] flex gap-2">
            <Button variant="outline" className="flex-1" onClick={() => setEditLogOpen(false)}>
              <X className="w-4 h-4 mr-1" /> {t('common.cancel')}
            </Button>
            <Button className="flex-1" onClick={() => setEditLogOpen(false)}>
              <Check className="w-4 h-4 mr-1" /> {t('common.save')}
            </Button>
          </div>
        </div>
      ) : (
        <Dialog open={editLogOpen} onOpenChange={setEditLogOpen}>
          {/* grid-cols-1 gives the dialog's grid a DEFINITE column track
              (minmax(0,1fr) = the dialog's own width). Without it the implicit
              auto track sizes itself to the graph content's max-content, and
              RodsGraphEditor's Zoom mode makes content ~4.8x wider than the
              container — so the track grows, the ResizeObserver measures the
              grown container, computeGraphLayout scales content up again, and
              the width runs away to the browser's ~33.5M px layout clamp.
              Result: zoomed pxPerHour becomes millions of px/hour, the
              scrollable range collapses to a few px, and drag-near-edge /
              drag-to-draw stop responding (the exact "zoomed iPad Edit Log
              doesn't respond" bug). A definite track pins the container to
              the dialog width so zoom produces a real ~5h scrollable window. */}
          <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto grid-cols-1">
            <DialogHeader><DialogTitle>{t('logs.editLog')}</DialogTitle></DialogHeader>
            <TimezoneIndicator tz={tz} className="mb-1" />
            <RodsGraphEditor events={events} dateStr={todayKey} timezone={tz} carrier={carrier} equipment={equipment} profile={profile} certifications={certifications} reload={reload} />
          </DialogContent>
        </Dialog>
      )}

      <EventEditor
        open={!!editingEvent}
        event={editingEvent}
        saving={eventSaving}
        saveError={eventSaveError}
        onClose={() => { setEditingEvent(null); setEventSaveError(''); }}
        onSave={handleSaveEventEdit}
        tz={tz}
        carrier={carrier}
        isCertified={false}
        dateStr={todayKey}
      />

      <Dialog open={dvirDialogOpen} onOpenChange={setDvirDialogOpen}>
        <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto">
          <DialogHeader><DialogTitle>{t('today.dailyDvir')}</DialogTitle></DialogHeader>
          <DvirForm
            defaultSignature={profile?.signature_data?.startsWith('data:') ? profile.signature_data : ''}
            defaultSignatureName={profile?.signature_type === 'typed' ? profile?.signature_data : profile?.legal_name}
            defaultTractor={equipment?.find(e => e.type === 'tractor')?.unit_number}
            defaultTrailer={equipment?.find(e => e.type === 'trailer')?.unit_number}
            onSave={handleSaveDvir}
            onCancel={() => setDvirDialogOpen(false)}
          />
        </DialogContent>
      </Dialog>
    </PullToRefresh>
  );
}