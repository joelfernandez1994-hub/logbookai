import { fmtDur } from '@/lib/hosEngine';
import { fmtClockShort } from '@/lib/logAssistant';
import { Truck, Clock, Coffee, Gauge, Moon, RotateCcw, CheckCircle2, XCircle } from 'lucide-react';

export default function WhatCanIDoPanel({ info, tz }) {
  if (!info) return null;
  return (
    <div className="space-y-3">
      <div className={`rounded-xl border p-3 flex items-center gap-2 ${info.canDrive ? 'border-success/40 bg-success-surface text-success-surface-foreground' : 'border-error/40 bg-error-surface text-error-surface-foreground'}`}>
        {info.canDrive ? <CheckCircle2 className="w-5 h-5" /> : <XCircle className="w-5 h-5" />}
        <div className="font-semibold">{info.canDrive ? 'You can drive right now' : 'You cannot drive right now'}</div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Card icon={Truck} label="Driving remaining" value={fmtDur(info.driveRemainingMs)} />
        <Card icon={Clock} label="14-hour window" value={fmtDur(info.windowRemainingMs)} />
        <Card icon={Coffee} label="30-min break" value={info.breakSatisfied ? 'Satisfied' : (info.breakRequired ? 'Required now' : 'Not yet required')} />
        <Card icon={Gauge} label="Cycle remaining" value={`${info.cycleRemainingHours.toFixed(1)} hr`} />
      </div>

      <Section title="Rest completion (from your actual records)">
        <Row label="Full 10-hour rest completes at" value={info.tenHourCompletesAt ? fmtClockShort(info.tenHourCompletesAt, tz) : info.restingNow ? 'Already complete' : 'Not currently resting'} />
        <Row label="34-hour restart completes at" value={info.thirtyFourCompletesAt ? fmtClockShort(info.thirtyFourCompletesAt, tz) : info.restartCompleted ? 'Already complete' : info.restartInProgress ? fmtClockShort(info.restartInProgress.estimatedCompletion, tz) : 'Not in progress'} />
      </Section>

      <Section title="Split sleeper">
        {info.splitAvailableNow
          ? <div className="text-xs text-success-surface-foreground">Available now — your existing qualifying periods form a valid split; 11h & 14h clocks are already recalculated.</div>
          : info.splitConditional
            ? <div className="text-xs text-warning-surface-foreground"><div className="font-medium">Would become available if you complete qualifying rest.</div>{info.splitConditional.description}</div>
            : <div className="text-xs text-muted-foreground">No qualifying split-sleeper periods in your current records.</div>}
      </Section>

      <Section title="Cycle hours returning">
        <Row label="Tomorrow" value={`${info.cycleReturningTomorrow.toFixed(1)} hr`} />
      </Section>

      <div className="text-[11px] text-muted-foreground">All values are computed deterministically from your actual log records. No AI request was used. The driver remains responsible for the accuracy of the record.</div>
    </div>
  );
}

function Card({ icon: Icon, label, value }) {
  return (
    <div className="rounded-lg border border-border bg-card p-2">
      <div className="flex items-center gap-1 text-xs text-muted-foreground"><Icon className="w-3.5 h-3.5" /> {label}</div>
      <div className="font-semibold mt-0.5 text-card-foreground">{value}</div>
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