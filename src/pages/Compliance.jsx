import { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useDriverData } from '@/hooks/useDriverData';
import { computeHOS, runComplianceCheck, getDailyGrid, dateKeyInTz, hasSufficientCycleHistory, fmtDur, fmtClock } from '@/lib/hosEngine';
import { whatCanIDo } from '@/lib/logAssistant';
import { Button } from '@/components/ui/button';
import { AlertTriangle, CheckCircle2, Info, FileWarning, Lightbulb, RefreshCw, Truck, Clock, Coffee, Gauge, RotateCcw, Moon, ShieldCheck, XCircle } from 'lucide-react';
import Header from '@/components/Header';

const STATUS_LABELS = { OFF_DUTY: 'Off Duty', SLEEPER_BERTH: 'Sleeper', DRIVING: 'Driving', ON_DUTY: 'On Duty' };

export default function Compliance() {
  const { profile, carrier, events, loading, reload } = useDriverData(9);
  const [checking, setChecking] = useState(false);
  const [issues, setIssues] = useState(null);

  const tz = carrier?.home_terminal_timezone || 'America/Chicago';
  const cycleType = carrier?.hos_cycle || '70_8';
  const [now, setNow] = useState(new Date());

  const hos = useMemo(() => computeHOS(events, cycleType, tz, now, { historyComplete: hasSufficientCycleHistory(events, cycleType, profile?.entered_prior_history, tz, now) }), [events, cycleType, tz, now, profile]);
  const info = useMemo(() => whatCanIDo(events, cycleType, tz, now, profile?.entered_prior_history), [events, cycleType, tz, now, profile?.entered_prior_history]);

  const runCheck = () => {
    setChecking(true);
    setNow(new Date());
    const t = new Date();
    const todayKey = dateKeyInTz(t, tz);
    const grid = getDailyGrid(events, todayKey, tz);
    const result = runComplianceCheck(events, cycleType, tz, t, {
      historyComplete: hasSufficientCycleHistory(events, cycleType, profile?.entered_prior_history, tz, t),
      dailyTotal: grid.totalHours,
      firstDrivingWithoutPretrip: false,
      equipmentMissing: false,
    });
    setIssues(result);
    setChecking(false);
  };

  useEffect(() => { runCheck(); }, [events]);

  if (loading) return <div className="flex justify-center h-screen items-center"><div className="w-8 h-8 border-4 border-muted border-t-foreground rounded-full animate-spin" /></div>;

  const renderSection = (title, items, icon, colorClass) => (
    items.length > 0 && (
      <div className="rounded-xl border border-border bg-card p-3 mb-3">
        <div className={`flex items-center gap-2 font-semibold text-sm mb-2 ${colorClass}`}>
          {icon} {title}
        </div>
        <div className="space-y-1.5">
          {items.map((it, i) => (
            <div key={i} className="text-xs text-muted-foreground border-l-2 border-border pl-2">
              {it.rule ? <span className="font-medium text-card-foreground">{it.rule}: </span> : null}{it.message}
            </div>
          ))}
        </div>
      </div>
    )
  );

  return (
    <div className="px-4 pt-6 pb-6">
      <Header title="HOS / Compliance" />
      <div className="text-[11px] text-muted-foreground mb-3 flex items-center gap-1">
        <ShieldCheck className="w-3.5 h-3.5" /> Deterministic — computed from your actual log records. No AI request is used.
      </div>
      <div className="flex justify-end mb-3">
        <Button size="sm" variant="outline" onClick={runCheck} disabled={checking}>
          <RefreshCw className="w-3.5 h-3.5 mr-1" /> {checking ? 'Checking...' : 'Re-check'}
        </Button>
      </div>

      {/* One-click HOS verdict: can drive now, exact blockers, eligible time */}
      <div className={`rounded-xl border p-3 mb-3 ${info.unavailable ? 'border-warning/50 bg-warning-surface text-warning-surface-foreground' : info.canDrive ? 'border-success/40 bg-success-surface text-success-surface-foreground' : 'border-error/40 bg-error-surface text-error-surface-foreground'}`}>
        <div className="flex items-center gap-2">
          {info.unavailable ? <AlertTriangle className="w-5 h-5" /> : info.canDrive ? <CheckCircle2 className="w-5 h-5" /> : <XCircle className="w-5 h-5" />}
          <div className="font-semibold">{info.unavailable ? 'HOS availability unavailable' : info.canDrive ? 'You can drive right now' : 'You cannot drive right now'}</div>
        </div>
        {info.unavailable && (
          <div className="mt-2">
            <p className="text-xs">{info.unavailableReason}</p>
            <Button asChild variant="outline" size="sm" className="mt-2 bg-transparent">
              <Link to="/logs">Correct timeline</Link>
            </Button>
          </div>
        )}
        {!info.unavailable && !info.canDrive && info.driveBlockers?.length > 0 && (
          <div className="mt-2 space-y-1.5 text-xs">
            {info.driveBlockers.map((b, i) => (
              <div key={i} className="flex items-start gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <div>
                  <div className="font-medium">{b.rule}</div>
                  <div>{b.message}</div>
                  {b.eligibleAt && <div className="opacity-80">Eligible at {fmtClock(b.eligibleAt, tz)}.</div>}
                </div>
              </div>
            ))}
            {info.driveEligibleAt && (
              <div className="pt-1 border-t border-error/30 mt-1">
                Earliest you may drive again: <b>{fmtClock(info.driveEligibleAt, tz)}</b>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Usable-now vs remaining-on-clock distinction */}
      <div className="grid grid-cols-2 gap-2 mb-3">
        <div className="rounded-xl border border-border bg-card p-3">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground"><Truck className="w-3.5 h-3.5" /> Driving usable now</div>
          <div className={`text-xl font-bold mt-1 ${info.usableDriveMs > 0 ? 'text-success' : 'text-muted-foreground'}`}>{fmtDur(info.usableDriveMs)}</div>
          <div className="text-[10px] text-muted-foreground">what you can actually drive this shift</div>
        </div>
        <div className="rounded-xl border border-border bg-card p-3">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground"><Truck className="w-3.5 h-3.5" /> Driving remaining</div>
          <div className="text-xl font-bold mt-1 text-card-foreground">{fmtDur(info.driveRemainingMs)}</div>
          <div className="text-[10px] text-muted-foreground">11-hour driving limit total</div>
        </div>
      </div>
      {!info.unavailable && info.usableDriveMs < info.driveRemainingMs && info.usableDriveMs > 0 && (
        <div className="text-[11px] text-warning-surface-foreground bg-warning-surface rounded-md px-2 py-1 mb-3">
          Your 14-hour window limits usable driving to {fmtDur(info.usableDriveMs)} even though {fmtDur(info.driveRemainingMs)} remains on the drive clock.
        </div>
      )}
      {!info.unavailable && info.usableDriveMs === 0 && info.driveRemainingMs > 0 && !info.canDrive && (
        <div className="text-[11px] text-warning-surface-foreground bg-warning-surface rounded-md px-2 py-1 mb-3">
          {fmtDur(info.driveRemainingMs)} remains on your driving clock, but you cannot legally use it until the blockers above clear.
        </div>
      )}

      {/* HOS clock grid */}
      <div className="grid grid-cols-2 gap-2 mb-3">
        <ClockCard icon={Clock} label="14-hour window" value={info.windowRemainingMs == null ? '--' : fmtDur(info.windowRemainingMs)} />
        <ClockCard icon={Coffee} label="30-min break" value={info.unavailable ? '--' : (info.breakSatisfied ? 'Satisfied' : (info.breakRequired ? 'Required now' : 'Not yet required'))} />
        <ClockCard icon={Gauge} label={`Cycle ${hos.cycle.cycleLimit}/${hos.cycle.cycleDays}`} value={info.cycleRemainingHours == null ? '--' : `${info.cycleRemainingHours.toFixed(1)} hr left`} note={!info.unavailable && info.cycleUnverified ? info.cycleUnverifiedReason : ''} />
        <ClockCard icon={RotateCcw} label="34-hour restart" value={info.unavailable ? '--' : (info.restartCompleted ? 'Completed' : (info.restartInProgress ? `${fmtDur(info.restartInProgress.remainingMs)} left` : 'Not in progress'))} />
      </div>

      {/* Split sleeper — always informational, never a warning */}
      {hos.split.status !== 'none' && (
        <div className="rounded-xl border border-border bg-card p-3 mb-3">
          <div className="flex items-center gap-2 text-sm font-medium text-card-foreground">
            <Moon className="w-4 h-4" /> {hos.split.status === 'active' ? 'Split Sleeper Active' : 'Split Sleeper Available'}
            <span className="ml-auto text-[10px] font-medium text-muted-foreground border border-border rounded px-1.5 py-0.5">Optional</span>
          </div>
          <div className="text-xs text-muted-foreground mt-1">{hos.split.note}</div>
          {hos.split.status === 'available' && hos.split.projectedDrivingRemainingMs != null && hos.split.projectedWindowRemainingMs != null && (
            <div className="text-xs text-muted-foreground mt-1">
              If completed: ~{fmtDur(Math.max(0, hos.split.projectedDrivingRemainingMs))} driving and ~{fmtDur(Math.max(0, hos.split.projectedWindowRemainingMs))} on the 14-hour window available.
            </div>
          )}
        </div>
      )}

      {/* Violations (HOS rules) — deterministic */}
      {issues?.hos?.length > 0 && (
        <div className="rounded-xl border border-error/40 bg-error-surface p-3 mb-3">
          <div className="flex items-center gap-2 font-semibold text-sm mb-2 text-error-surface-foreground">
            <AlertTriangle className="w-4 h-4" /> Violations
          </div>
          <div className="space-y-1.5">
            {issues.hos.map((it, i) => (
              <div key={i} className="text-xs text-error-surface-foreground border-l-2 border-error/50 pl-2">
                {it.rule ? <span className="font-medium">{it.rule}: </span> : null}{it.message}
              </div>
            ))}
          </div>
        </div>
      )}

      {issues ? (
        <>
          {renderSection('Missing Information', issues.missingInfo, <Info className="w-4 h-4" />, 'text-warning')}
          {renderSection('Supporting Document Conflicts', issues.docConflicts, <FileWarning className="w-4 h-4" />, 'text-warning')}
          {renderSection('Suggestions', issues.suggestions, <Lightbulb className="w-4 h-4" />, 'text-success')}
          {issues.hos.length === 0 && issues.missingInfo.length === 0 && issues.docConflicts.length === 0 && (
            <div className="rounded-xl border border-success/40 bg-success-surface p-4 text-success-surface-foreground text-sm flex items-center gap-2">
              <CheckCircle2 className="w-5 h-5" /> No issues detected by the current LogbookAI compliance checks.
            </div>
          )}
        </>
      ) : (
        <div className="text-sm text-muted-foreground text-center py-8">Running compliance check...</div>
      )}
    </div>
  );
}

function ClockCard({ icon: Icon, label, value, note }) {
  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground"><Icon className="w-3.5 h-3.5" /> {label}</div>
      <div className="font-semibold mt-1 text-card-foreground">{value}</div>
      {note && <div className="text-[10px] text-muted-foreground mt-1">{note}</div>}
    </div>
  );
}