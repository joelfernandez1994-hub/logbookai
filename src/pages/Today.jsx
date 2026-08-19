import { useState, useMemo, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDriverData } from '@/hooks/useDriverData';
import { computeHOS, fmtDur, fmtClock, dateKeyInTz, hasSufficientCycleHistory } from '@/lib/hosEngine';
import LogGraph from '@/components/LogGraph';
import ClockCard from '@/components/ClockCard';
import StatusChangeSheet from '@/components/StatusChangeSheet';
import { changeStatus, createHistoricalEvent } from '@/lib/driverData';
import { getDvirs } from '@/lib/dvirData';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Truck, Clock, Coffee, RotateCcw, AlertTriangle, MapPin, Bot, FileCheck, ClipboardList, ClipboardCheck, Gauge, Moon, Gavel, HelpCircle } from 'lucide-react';

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

  const tz = carrier?.home_terminal_timezone || profile?.home_terminal_timezone || 'America/Chicago';
  const cycleType = carrier?.hos_cycle || '70_8';

  const historyComplete = useMemo(() => hasSufficientCycleHistory(events, cycleType, profile?.entered_prior_history, tz, now), [events, cycleType, profile, tz, now]);
  const openSafetyDefects = useMemo(() => (dvirs || []).filter(d => d.has_safety_defect && d.repair_status === 'pending'), [dvirs]);

  const hos = useMemo(() => computeHOS(events, cycleType, tz, now, { historyComplete }),
    [events, cycleType, tz, now, historyComplete]);

  // live ticking
  useEffect(() => { const t = setTimeout(() => setNow(new Date()), 30000); return () => clearTimeout(t); }, [now]);

  useEffect(() => { (async () => { try { setDvirs(await getDvirs(30) || []); } catch (e) {} })(); }, [reload]);

  const needsOnboarding = !profile || !profile.onboarded || !profile.has_acknowledged_non_eld;
  useEffect(() => {
    if (!loading && needsOnboarding) navigate('/onboarding', { replace: true });
  }, [loading, needsOnboarding, navigate]);

  if (loading || needsOnboarding) {
    return <div className="flex items-center justify-center h-screen"><div className="w-8 h-8 border-4 border-slate-200 border-t-slate-800 rounded-full animate-spin" /></div>;
  }

  const todayKey = dateKeyInTz(now, tz);
  const current = hos.currentStatus;

  // Pre-trip check: before allowing DRIVING, ensure a pre-trip on-duty event exists in current tour
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
    await changeStatus(details.duty_status, {
      city: details.city, state: details.state, remark: details.remark,
      tractor_number: details.tractor_number, trailer_numbers: details.trailer_numbers,
      carrier_name: carrier?.carrier_name,
    });
    setStatusOpen(false);
    setPretripOpen(false);
    reload();
  };

  const logPretrip = async (minutes) => {
    const start = new Date(Date.now() - minutes * 60000);
    await createHistoricalEvent({
      log_date: todayKey,
      start_timestamp: start.toISOString(),
      end_timestamp: new Date().toISOString(),
      duty_status: 'ON_DUTY',
      remark: 'Pre-Trip Inspection',
      city: pendingStatus?.city || '', state: pendingStatus?.state || '',
      method_of_creation: 'Manual',
    });
    setPretripOpen(false);
    if (pendingStatus) await applyChange(pendingStatus);
    setPendingStatus(null);
    reload();
  };

  const restartProgress = hos.restart.inProgress;

  return (
    <div className="px-4 pt-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">LogbookAI</h1>
          <p className="text-xs text-slate-500">HOS Compliance Assistant · {carrier?.ruleset_version?.split(' — ')[0]}</p>
        </div>
        <div className="text-right">
          <p className="text-sm font-medium">{now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: tz })}</p>
          <p className="text-xs text-slate-500">Logbook: {fmtClock(now, tz)}</p>
        </div>
      </div>

      {/* Current status */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 mb-3">
        <div className="text-xs text-slate-500 font-medium">CURRENT DUTY STATUS</div>
        {current ? (
          <div className="flex items-baseline gap-2 mt-1">
            <span className="text-2xl font-bold">{STATUS_LABELS[current.duty_status]}</span>
            <span className="text-sm text-slate-500">Since {fmtClock(current.start, tz)}</span>
          </div>
        ) : (
          <div className="text-2xl font-bold mt-1 text-slate-400">No active status</div>
        )}
        {current?.city && (
          <div className="flex items-center gap-1 text-sm text-slate-600 mt-1">
            <MapPin className="w-3.5 h-3.5" /> {current.city}{current.state ? `, ${current.state}` : ''}
          </div>
        )}
        <div className="text-[11px] text-slate-400 mt-1">Home terminal: {carrier?.home_terminal_timezone}</div>
      </div>

      {/* HOS Clocks */}
      <div className="grid grid-cols-2 gap-2 mb-3">
        <ClockCard label="Driving Remaining" value={fmtDur(hos.driving.drivingRemainingMs)}
          sublabel={hos.driving.expiresAt ? `expires ${fmtClock(hos.driving.expiresAt, tz)}` : '11-hr limit'}
          status={clockStatus(hos.driving.drivingRemainingMs)} icon={Truck} />
        <ClockCard label="14-Hour Window" value={fmtDur(hos.window14.remainingMs)}
          sublabel={hos.window14.windowStart ? `since ${fmtClock(hos.window14.windowStart, tz)}` : ''}
          status={clockStatus(hos.window14.remainingMs)} icon={Clock} />
        <ClockCard label="30-Min Break" value={hos.break30.satisfied ? 'Satisfied' : `${fmtDur(hos.break30.remainingBeforeBreakMs)} left`}
          sublabel={hos.break30.breakRequired ? 'Break required now' : '8-hr driving rule'}
          status={hos.break30.breakRequired ? 'critical' : 'normal'} icon={Coffee} />
        <ClockCard label={`Cycle ${hos.cycle.cycleLimit}/${hos.cycle.cycleDays}`} value={`${hos.cycle.cycleRemainingHours.toFixed(1)} hr left`}
          sublabel={`${hos.cycle.cycleUsedHours.toFixed(1)} used · ${hos.cycle.returningTomorrowHours.toFixed(1)} back tomorrow`}
          status={clockStatus(hos.cycle.cycleRemainingHours * 3600000)} icon={Gauge} />
      </div>

      {/* 34-hour restart / split sleeper */}
      {restartProgress && (
        <div className="rounded-xl border border-violet-200 bg-violet-50 p-3 mb-3">
          <div className="flex items-center gap-2 text-sm font-medium text-violet-900">
            <RotateCcw className="w-4 h-4" /> 34-Hour Restart In Progress
          </div>
          <div className="text-xs text-violet-700 mt-1">
            Elapsed {fmtDur(restartProgress.elapsedMs)} · {fmtDur(restartProgress.remainingMs)} remaining · est. {fmtClock(restartProgress.estimatedCompletion, tz)}
          </div>
        </div>
      )}
      {hos.split.status !== 'none' && (
        <div className={`rounded-xl border p-3 mb-3 ${hos.split.status === 'active' ? 'border-blue-200 bg-blue-50' : 'border-amber-200 bg-amber-50'}`}>
          <div className={`flex items-center gap-2 text-sm font-medium ${hos.split.status === 'active' ? 'text-blue-900' : 'text-amber-900'}`}>
            <Moon className="w-4 h-4" /> {hos.split.status === 'active' ? 'Split Sleeper Active' : 'Split Sleeper Incomplete'}
          </div>
          <div className={`text-xs mt-1 ${hos.split.status === 'active' ? 'text-blue-700' : 'text-amber-700'}`}>{hos.split.note}</div>
          {hos.split.status === 'active' && hos.split.firstPeriod && hos.split.secondPeriod && (
            <div className="text-xs text-blue-700 mt-1">
              Paired periods: {fmtDur(hos.split.firstPeriod.duration)} {hos.split.firstPeriod.status === 'SLEEPER_BERTH' ? 'Sleeper Berth' : 'Off Duty'} + {fmtDur(hos.split.secondPeriod.duration)} {hos.split.secondPeriod.status === 'SLEEPER_BERTH' ? 'Sleeper Berth' : 'Off Duty'} · 11-hr & 14-hr clocks recalculated from the first qualifying period.
            </div>
          )}
          {hos.split.status === 'incomplete' && (
            <div className="text-xs text-amber-700 mt-1">
              Required second period: at least {fmtDur(hos.split.requiredSecondMs)}{hos.split.secondPeriod ? ` (${fmtDur(hos.split.secondPeriod.duration)} taken so far, ${fmtDur(hos.split.additionalMs)} more)` : ''}.
            </div>
          )}
        </div>
      )}
      {openSafetyDefects.length > 0 && (
        <div className="rounded-xl border border-red-300 bg-red-50 p-3 mb-3 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-red-600 mt-0.5 shrink-0" />
          <div className="text-xs text-red-900">
            <span className="font-semibold">Safety-affecting defect with repair pending.</span> Vehicle should not be operated if unsafe.
            <button className="underline ml-1 font-medium" onClick={() => navigate('/vehicle-inspection')}>Review DVIR →</button>
          </div>
        </div>
      )}
      {profile?.dvir_reminder_enabled && openSafetyDefects.length === 0 && (
        <div className="rounded-xl border border-slate-200 bg-white p-3 mb-3 flex items-start gap-2">
          <ClipboardCheck className="w-4 h-4 text-slate-500 mt-0.5 shrink-0" />
          <div className="text-xs text-slate-700">
            Reminder: review vehicle condition before finishing your work period and report any defects.
            <button className="underline ml-1 font-medium" onClick={() => navigate('/vehicle-inspection')}>Open DVIR →</button>
          </div>
        </div>
      )}
      {!historyComplete && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 mb-3 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
          <div className="text-xs text-amber-900">
            Cycle availability based only on records entered in LogbookAI. Prior duty history was not provided, so cycle balance is not verified until enough history exists to cover your {cycleType === '70_8' ? '8-day' : '7-day'} cycle.
          </div>
        </div>
      )}

      {/* 24-hour graph */}
      <div className="rounded-xl border border-slate-200 bg-white p-3 mb-3">
        <div className="text-sm font-semibold mb-2">Today's 24-Hour Log</div>
        <LogGraph events={events} dateStr={todayKey} timezone={tz} />
      </div>

      {/* Manual Log Assistant — prominent actions */}
      <div className="grid grid-cols-2 gap-2 mb-3">
        <Button className="h-14 text-base" onClick={() => navigate('/log-assistant')}>
          <Bot className="w-5 h-5 mr-2" /> Add / Tell LogbookAI
        </Button>
        <Button variant="outline" className="h-14 text-base" onClick={() => navigate('/log-assistant?tab=makeLegal')}>
          <Gavel className="w-5 h-5 mr-2" /> Make It Legal
        </Button>
      </div>
      <Button variant="outline" className="w-full h-12 text-base mb-3" onClick={() => navigate('/log-assistant?tab=whatCanIDo')}>
        <HelpCircle className="w-5 h-5 mr-2" /> What Can I Do?
      </Button>

      {/* Main actions */}
      <div className="grid grid-cols-2 gap-2 mb-6">
        <Button className="h-14 text-base" onClick={() => setStatusOpen(true)}>Change Status</Button>
        <Button variant="outline" className="h-14 text-base" onClick={() => navigate('/assistant')}>
          <Bot className="w-5 h-5 mr-2" /> AI Assistant
        </Button>
        <Button variant="outline" className="h-14 text-base" onClick={() => navigate('/compliance')}>
          <FileCheck className="w-5 h-5 mr-2" /> Compliance Check
        </Button>
        <Button variant="outline" className="h-14 text-base" onClick={() => navigate('/logs')}>
          <ClipboardList className="w-5 h-5 mr-2" /> View Full Log
        </Button>
      </div>

      <StatusChangeSheet open={statusOpen} onOpenChange={setStatusOpen} onApply={handleChangeStatus}
        defaultEquipment={{ tractor: equipment?.[0]?.unit_number, trailer: equipment?.find(e => e.type === 'trailer')?.unit_number }} />

      {/* Pre-trip prompt */}
      <Dialog open={pretripOpen} onOpenChange={setPretripOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Pre-Trip Vehicle Safety Check</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-slate-600">
            Have you completed or otherwise satisfied your required pre-trip vehicle safety check before operating the vehicle?
          </p>
          <p className="text-xs text-slate-400">These are entry shortcuts, not a universal FMCSA minimum duration.</p>
          <DialogFooter className="flex-col gap-2">
            <div className="flex gap-2 w-full">
              <Button className="flex-1" onClick={() => logPretrip(15)}>Log Pre-Trip · 15 min</Button>
              <Button className="flex-1" onClick={() => logPretrip(30)}>Log Pre-Trip · 30 min</Button>
            </div>
            <div className="flex gap-2 w-full">
              <Button variant="outline" className="flex-1" onClick={() => { setPretripOpen(false); if (pendingStatus) applyChange(pendingStatus); setPendingStatus(null); }}>
                Already Satisfied
              </Button>
              <Button variant="outline" className="flex-1" onClick={() => { setPretripOpen(false); setPendingStatus(null); }}>
                Cancel
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}