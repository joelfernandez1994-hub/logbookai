import { Link } from 'react-router-dom';
import { fmtDur } from '@/lib/hosEngine';
import { fmtClockShort } from '@/lib/logAssistant';
import { Button } from '@/components/ui/button';
import { Truck, Clock, Coffee, Gauge, CheckCircle2, XCircle, AlertTriangle } from 'lucide-react';

export default function WhatCanIDoPanel({ info, tz }) {
  if (!info) return null;
  const eligibleStr = info.driveEligibleAt ? fmtClockShort(info.driveEligibleAt, tz) : null;

  return (
    <div className="space-y-3">
      {/* Can-drive verdict with EXACT reason + eligible time */}
      <div className={`rounded-xl border p-3 ${info.unavailable || info.undetermined ? 'border-warning/50 bg-warning-surface text-warning-surface-foreground' : info.canDrive ? 'border-success/40 bg-success-surface text-success-surface-foreground' : 'border-error/40 bg-error-surface text-error-surface-foreground'}`}>
        <div className="flex items-center gap-2">
          {info.unavailable || info.undetermined ? <AlertTriangle className="w-5 h-5" /> : info.canDrive ? <CheckCircle2 className="w-5 h-5" /> : <XCircle className="w-5 h-5" />}
          <div className="font-semibold">{info.unavailable ? 'HOS availability unavailable' : info.undetermined ? 'Availability undetermined' : info.canDrive ? 'You can drive right now' : 'You cannot drive right now'}</div>
        </div>
        {info.undetermined && (
          <div className="mt-2">
            <p className="text-xs">{info.undeterminedReason}</p>
            <Button asChild variant="outline" size="sm" className="mt-2 bg-transparent">
              <Link to="/agricultural">Review claims</Link>
            </Button>
          </div>
        )}
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
                  {b.eligibleAt && <div className="opacity-80">Eligible at {fmtClockShort(b.eligibleAt, tz)}.</div>}
                </div>
              </div>
            ))}
            {eligibleStr && (
              <div className="pt-1 border-t border-error/30 mt-1">
                Earliest you may drive again: <b>{eligibleStr}</b>
              </div>
            )}
          </div>
        )}
      </div>

      {/* USABLE vs REMAINING distinction */}
      <div className="rounded-xl border border-border bg-card p-3">
        <div className="text-xs font-semibold text-card-foreground mb-1.5 flex items-center gap-1.5">
          <Truck className="w-4 h-4" /> Driving time
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className="text-[11px] text-muted-foreground">Usable now</div>
            <div className={`text-lg font-bold ${info.usableDriveMs > 0 ? 'text-success' : 'text-muted-foreground'}`}>{fmtDur(info.usableDriveMs)}</div>
            <div className="text-[10px] text-muted-foreground">{info.unavailable ? 'Unavailable — driver-claimed agricultural interval affects this clock' : 'what you can actually drive this shift'}</div>
          </div>
          <div>
            <div className="text-[11px] text-muted-foreground">Remaining on clock</div>
            <div className="text-lg font-bold text-card-foreground">{fmtDur(info.driveRemainingMs)}</div>
            <div className="text-[10px] text-muted-foreground">{info.unavailable ? 'Unavailable — driver-claimed agricultural interval affects this clock' : '11-hr driving limit total'}</div>
          </div>
        </div>
        {info.usableDriveMs < info.driveRemainingMs && info.usableDriveMs > 0 && (
          <div className="text-[11px] text-warning-surface-foreground bg-warning-surface rounded-md px-2 py-1 mt-2">
            Your 14-hour window limits usable driving to {fmtDur(info.usableDriveMs)} even though {fmtDur(info.driveRemainingMs)} remains on the drive clock.
          </div>
        )}
        {info.usableDriveMs === 0 && info.driveRemainingMs > 0 && !info.canDrive && (
          <div className="text-[11px] text-warning-surface-foreground bg-warning-surface rounded-md px-2 py-1 mt-2">
            {fmtDur(info.driveRemainingMs)} remains on your driving clock, but you cannot legally use it until the blockers above clear.
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Card icon={Clock} label="14-hour window" value={fmtDur(info.windowRemainingMs)} note={info.unavailable ? 'Unavailable — driver-claimed agricultural interval affects this clock' : ''} />
        <Card icon={Coffee} label="30-min break" value={(info.unavailable || info.breakAgriculturalUnavailable) ? '--' : info.breakSatisfied ? 'Satisfied' : (info.breakRequired ? 'Required now' : 'Not yet required')} note={info.unavailable ? 'Unavailable — driver-claimed agricultural interval affects this clock' : ''} />
        <Card icon={Gauge} label="Cycle remaining" value={info.cycleRemainingHours == null ? '--' : `${info.cycleRemainingHours.toFixed(1)} hr`} note={info.unavailable ? 'Unavailable — driver-claimed agricultural interval affects this clock' : info.cycleUnverified ? info.cycleUnverifiedReason : ''} />
      </div>

      <Section title="Rest completion (from your actual records)">
        <Row label="Full 10-hour rest completes at" value={info.unavailable ? '--' : info.tenHourCompletesAt ? fmtClockShort(info.tenHourCompletesAt, tz) : info.restingNow ? 'Already complete' : 'Not currently resting'} />
        <Row label="34-hour restart completes at" value={info.unavailable ? '--' : info.thirtyFourCompletesAt ? fmtClockShort(info.thirtyFourCompletesAt, tz) : info.restartCompleted ? 'Already complete' : info.restartInProgress ? fmtClockShort(info.restartInProgress.estimatedCompletion, tz) : 'Not in progress'} />
      </Section>

      <Section title="Split sleeper (optional)">
        {info.unavailable
          ? <div className="text-xs font-medium text-card-foreground">--</div>
          : info.splitAvailableNow
            ? <div className="text-xs text-muted-foreground">Active — your qualifying periods form a valid split, so the 11h & 14h clocks are already recalculated. This is an optional optimization; the 60/70-hour cycle is unchanged.</div>
            : info.splitConditional
              ? <div className="text-xs text-muted-foreground"><div className="font-medium">{info.splitConditional.label}.</div>{info.splitConditional.description}</div>
              : <div className="text-xs text-muted-foreground">No qualifying split-sleeper periods in your current records. A split is never required — a full 10-hour rest always works.</div>}
      </Section>

      <Section title="Cycle hours returning">
        <Row label="Tomorrow" value={info.unavailable || info.cycleUnverified ? '--' : `${info.cycleReturningTomorrow.toFixed(1)} hr`} />
      </Section>

      <div className="text-[11px] text-muted-foreground">All values are computed deterministically from your actual log records. No AI request was used. The driver remains responsible for the accuracy of the record.</div>
    </div>
  );
}

function Card({ icon: Icon, label, value, note }) {
  return (
    <div className="rounded-lg border border-border bg-card p-2">
      <div className="flex items-center gap-1 text-xs text-muted-foreground"><Icon className="w-3.5 h-3.5" /> {label}</div>
      <div className="font-semibold mt-0.5 text-card-foreground">{value}</div>
      {note && <div className="text-[10px] text-muted-foreground mt-0.5">{note}</div>}
    </div>
  );
}
function Section({ title, children }) {
  return (
    <div className="rounded-lg border border-border bg-card p-2">
      <div className="text-xs font-semibold text-card-foreground mb-1">{title}</div>
      {children}
    </div>
  );
}
function Row({ label, value }) {
  return <div className="flex items-center justify-between text-xs py-0.5"><span className="text-muted-foreground">{label}</span><span className="font-medium text-card-foreground">{value}</span></div>;
}