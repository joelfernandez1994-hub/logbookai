import { useState, useMemo, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDriverData } from '@/hooks/useDriverData';
import { computeHOS, fmtDur, fmtClock, dateKeyInTz, hasSufficientCycleHistory } from '@/lib/hosEngine';
import LogGraph from '@/components/LogGraph';
import ClockCard from '@/components/ClockCard';
import StatusChangeSheet from '@/components/StatusChangeSheet';
import { changeStatus, insertEvent } from '@/lib/timelineWriter';
import { validateTimeline } from '@/lib/timelineEngine';
import { getDvirs } from '@/lib/dvirData';
import { Button } from '@/components/ui/button';
import PreTripDialog from '@/components/PreTripDialog';
import { Truck, Clock, Coffee, RotateCcw, AlertTriangle, MapPin, Bot, ClipboardList, ClipboardCheck, Gauge, Moon, HelpCircle, ShieldCheck } from 'lucide-react';
import DailyMilesCard from '@/components/DailyMilesCard';
import TimezoneIndicator from '@/components/TimezoneIndicator';
import TimelineGapNotice from '@/components/TimelineGapNotice';
import PullToRefresh from '@/components/PullToRefresh';

const STATUS_LABELS = {
  OFF_DUTY: 'OFF DUTY',
  SLEEPER_BERTH: 'SLEEPER BERTH',
  DRIVING: 'DRIVING',
  ON_DUTY: 'ON DUTY',
};

function clockStatus(ms) {
  if (ms == null) return 'normal';
  if (ms <= 0) return 'critical';
  if (ms < 3600000) return 'warning';
  return 'normal';
}

export default function Today() {
  const { profile, carrier, equipment, events, loading, reload } = useDriverData();
  const navigate = useNavigate();
  const [statusOpen, setStatusOpen] = useState(false);
  const [pretripOpen, setPretripOpen] = useState(false);
  const [pendingStatus, setPendingStatus] = useState(null);
  const [now, setNow] = useState(new Date());
  const [dvirs, setDvirs] = useState([]);
  const [optimisticStatus, setOptimisticStatus] = useState(null);
  const [optimisticSince, setOptimisticSince] = useState(null);

  const tz = carrier?.home_terminal_timezone || 'America/Chicago';
  const cycleType = carrier?.hos_cycle || '70_8';
  const speedProfile = profile?.trip_planning_speed_profile || 'conservative';

  const historyComplete = useMemo(() => hasSufficientCycleHistory(events, cycleType, profile?.entered_prior_history, tz, now), [events, cycleType, profile, tz, now]);
  const openSafetyDefects = useMemo(() => (dvirs || []).filter(d => d.has_safety_defect && d.repair_status === 'pending'), [dvirs]);

  const timelineValidation = useMemo(() => validateTimeline(events, { now, dateStr: dateKeyInTz(now, tz), timezone: tz }), [events, now, tz]);
  const hos = useMemo(() => computeHOS(events, cycleType, tz, now, { historyComplete }),
    [events, cycleType, tz, now, historyComplete]);

  useEffect(() => { const t = setTimeout(() => setNow(new Date()), 30000); return () => clearTimeout(t); }, [now]);

  useEffect(() => { (async () => { try { setDvirs(await getDvirs(30) || []); } catch (e) {} })(); }, [reload]);

  const needsOnboarding = !profile || !profile.onboarded || !profile.has_acknowledged_non_eld;
  useEffect(() => {
    if (!loading && needsOnboarding) navigate('/onboarding', { replace: true });
  }, [loading, needsOnboarding, navigate]);

  if (loading || needsOnboarding) {
    return <div className="flex items-center justify-center h-screen"><div className="w-8 h-8 border-4 border-muted border-t-foreground rounded-full animate-spin" /></div>;
  }

  const todayKey = dateKeyInTz(now, tz);
  const current = hos.currentStatus;
  const displayStatus = optimisticStatus || current?.duty_status;
  const displaySince = optimisticStatus ? optimisticSince : current?.start;

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

  const restartProgress = hos.restart.inProgress;

  return (
    <PullToRefresh onRefresh={reload} className="px-4 pt-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">LogbookAI</h1>
          <p className="text-xs text-muted-foreground">HOS Compliance Assistant · {carrier?.ruleset_version?.split(' — ')[0]}</p>
        </div>
        <div className="text-right">
          <p className="text-sm font-medium text-foreground">{now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: tz })}</p>
          <p className="text-xs text-muted-foreground">Logbook: {fmtClock(now, tz)}</p>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card p-4 mb-3">
        <div className="text-xs text-muted-foreground font-medium">CURRENT DUTY STATUS</div>
        {(displayStatus || current) ? (
          <div className="flex items-baseline gap-2 mt-1">
            <span className="text-2xl font-bold text-card-foreground">{STATUS_LABELS[displayStatus || current.duty_status]}</span>
            <span className="text-sm text-muted-foreground">Since {fmtClock(displaySince || current.start, tz)}</span>
          </div>
        ) : (
          <div className="text-2xl font-bold mt-1 text-muted-foreground">No active status</div>
        )}
        {current?.city && (
          <div className="flex items-center gap-1 text-sm text-muted-foreground mt-1">
            <MapPin className="w-3.5 h-3.5" /> {current.city}{current.state ? `, ${current.state}` : ''}
          </div>
        )}
        <TimezoneIndicator tz={tz} className="mt-1" />
      </div>

      {!timelineValidation.valid && (
        <div className="rounded-xl border border-error/40 bg-error-surface p-3 mb-3 text-xs text-error-surface-foreground flex gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" /> Timeline correction required. HOS calculations are unavailable until elapsed coverage is continuous and conflict-free.
        </div>
      )}
      <TimelineGapNotice events={events} dateStr={todayKey} tz={tz} now={now} />
      <DailyMilesCard events={events} dateStr={todayKey} tz={tz} speedProfile={speedProfile} />

      <div className="grid grid-cols-2 gap-2 mb-3">
        <ClockCard label="Driving Remaining" value={timelineValidation.valid ? fmtDur(hos.driving.drivingRemainingMs) : '--'}
          sublabel={timelineValidation.valid ? (hos.driving.expiresAt ? `expires ${fmtClock(hos.driving.expiresAt, tz)}` : '11-hr limit') : 'Unavailable until timeline is valid'}
          status={timelineValidation.valid ? clockStatus(hos.driving.drivingRemainingMs) : 'disabled'} icon={Truck} />
        <ClockCard label="14-Hour Window" value={timelineValidation.valid ? fmtDur(hos.window14.remainingMs) : '--'}
          sublabel={timelineValidation.valid ? (hos.window14.windowStart ? `since ${fmtClock(hos.window14.windowStart, tz)}` : '') : 'Unavailable until timeline is valid'}
          status={timelineValidation.valid ? clockStatus(hos.window14.remainingMs) : 'disabled'} icon={Clock} />
        <ClockCard label="30-Min Break" value={timelineValidation.valid ? (hos.break30.satisfied ? 'Satisfied' : `${fmtDur(hos.break30.remainingBeforeBreakMs)} left`) : '--'}
          sublabel={timelineValidation.valid ? (hos.break30.breakRequired ? 'Break required now' : '8-hr driving rule') : 'Unavailable until timeline is valid'}
          status={timelineValidation.valid ? (hos.break30.breakRequired ? 'critical' : 'normal') : 'disabled'} icon={Coffee} />
        <ClockCard label={`Cycle ${hos.cycle.cycleLimit}/${hos.cycle.cycleDays}`} value={timelineValidation.valid ? `${hos.cycle.cycleRemainingHours.toFixed(1)} hr left` : '--'}
          sublabel={timelineValidation.valid ? `${hos.cycle.cycleUsedHours.toFixed(1)} used · ${hos.cycle.returningTomorrowHours.toFixed(1)} back tomorrow` : 'Unavailable until timeline is valid'}
          status={timelineValidation.valid ? clockStatus(hos.cycle.cycleRemainingHours * 3600000) : 'disabled'} icon={Gauge} />
      </div>

      {restartProgress && (
        <div className="rounded-xl border border-border bg-accent p-3 mb-3">
          <div className="flex items-center gap-2 text-sm font-medium text-accent-foreground">
            <RotateCcw className="w-4 h-4" /> 34-Hour Restart In Progress
          </div>
          <div className="text-xs text-muted-foreground mt-1">
            Elapsed {fmtDur(restartProgress.elapsedMs)} · {fmtDur(restartProgress.remainingMs)} remaining · est. {fmtClock(restartProgress.estimatedCompletion, tz)}
          </div>
        </div>
      )}
      {hos.split.status !== 'none' && (
        <div className="rounded-xl border border-border bg-card p-3 mb-3">
          <div className="flex items-center gap-2 text-sm font-medium text-card-foreground">
            <Moon className="w-4 h-4" /> {hos.split.status === 'active' ? 'Split Sleeper Active' : 'Split Sleeper Available'}
            <span className="ml-auto text-[10px] font-medium text-muted-foreground border border-border rounded px-1.5 py-0.5">Optional</span>
          </div>
          <div className="text-xs text-muted-foreground mt-1">{hos.split.note}</div>
          {hos.split.status === 'active' && hos.split.firstPeriod && hos.split.secondPeriod && (
            <div className="text-xs text-muted-foreground mt-1">
              Paired periods: {fmtDur(hos.split.firstPeriod.duration)} {hos.split.firstPeriod.status === 'SLEEPER_BERTH' ? 'Sleeper Berth' : 'Off Duty'} + {fmtDur(hos.split.secondPeriod.duration)} {hos.split.secondPeriod.status === 'SLEEPER_BERTH' ? 'Sleeper Berth' : 'Off Duty'} · 11-hr & 14-hr clocks recalculated from the first qualifying period (FMCSA §395.1(g)).
            </div>
          )}
          {hos.split.status === 'available' && (
            <div className="text-xs text-muted-foreground mt-1 space-y-0.5">
              <div>
                Complete the pair with at least {fmtDur(hos.split.requiredSecondMs)} more qualifying rest
                {hos.split.secondPeriod ? ` (${fmtDur(hos.split.secondPeriod.duration)} taken so far, ${fmtDur(hos.split.additionalMs)} more needed)` : ''}.
              </div>
              {hos.split.projectedDrivingRemainingMs != null && hos.split.projectedWindowRemainingMs != null && (
                <div>
                  Once completed: ~{fmtDur(Math.max(0, hos.split.projectedDrivingRemainingMs))} driving and ~{fmtDur(Math.max(0, hos.split.projectedWindowRemainingMs))} on the 14-hour window would be available.
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
            <span className="font-semibold">Safety-affecting defect with repair pending.</span> Vehicle should not be operated if unsafe.
            <button className="underline ml-1 font-medium" onClick={() => navigate('/vehicle-inspection')}>Review DVIR →</button>
          </div>
        </div>
      )}
      {profile?.dvir_reminder_enabled && openSafetyDefects.length === 0 && (
        <div className="rounded-xl border border-border bg-card p-3 mb-3 flex items-start gap-2">
          <ClipboardCheck className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" />
          <div className="text-xs text-muted-foreground">
            Reminder: review vehicle condition before finishing your work period and report any defects.
            <button className="underline ml-1 font-medium text-foreground" onClick={() => navigate('/vehicle-inspection')}>Open DVIR →</button>
          </div>
        </div>
      )}
      {!historyComplete && (
        <div className="rounded-xl border border-warning/50 bg-warning-surface p-3 mb-3 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-warning mt-0.5 shrink-0" />
          <div className="text-xs text-warning-surface-foreground">
            Cycle availability based only on records entered in LogbookAI. Prior duty history was not provided, so cycle balance is not verified until enough history exists to cover your {cycleType === '70_8' ? '8-day' : '7-day'} cycle.
          </div>
        </div>
      )}

      <div className="rounded-xl border border-border bg-card p-3 mb-4">
        <div className="flex items-center justify-between mb-2"><div className="text-sm font-semibold text-card-foreground">Today's 24-Hour Log</div><TimezoneIndicator tz={tz} /></div>
        <LogGraph events={events} dateStr={todayKey} timezone={tz} />
      </div>

      {/* Primary action */}
      <Button className="w-full h-14 text-base font-semibold mb-3" onClick={() => setStatusOpen(true)}>
        Change Status
      </Button>

      {/* Secondary actions — stack on phones, side-by-side only when both labels fit (≥640px) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 mb-2.5">
        <Button variant="outline" className="h-12 text-sm" onClick={() => navigate('/log-assistant')}>
          <Bot className="w-4 h-4 shrink-0" /> Ask LogbookAI
        </Button>
        <Button variant="outline" className="h-12 text-sm" onClick={() => navigate('/compliance')}>
          <ShieldCheck className="w-4 h-4 shrink-0" /> HOS / Compliance
        </Button>
      </div>

      <Button variant="outline" className="w-full h-12 text-sm mb-4" onClick={() => navigate('/logs')}>
        <ClipboardList className="w-4 h-4 shrink-0" /> View Full Log
      </Button>

      {/* Help link — small, not a boxed action */}
      <button
        type="button"
        onClick={() => navigate('/log-assistant?tab=whatCanIDo')}
        className="w-full flex items-center justify-center gap-1.5 text-xs text-muted-foreground mb-8 py-1"
      >
        <HelpCircle className="w-3.5 h-3.5" /> What can LogbookAI do?
      </button>

      <StatusChangeSheet open={statusOpen} onOpenChange={setStatusOpen} onApply={handleChangeStatus}
        defaultEquipment={{ tractor: equipment?.[0]?.unit_number, trailer: equipment?.find(e => e.type === 'trailer')?.unit_number }} />

      <PreTripDialog open={pretripOpen} onOpenChange={setPretripOpen}
        drivingStart={pendingStatus ? new Date() : null}
        defaultCity={pendingStatus?.city} defaultState={pendingStatus?.state}
        onConfirm={handlePretripConfirm} />
    </PullToRefresh>
  );
}