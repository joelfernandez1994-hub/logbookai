import { fmtDur } from '@/lib/hosEngine';
import { fmtClockShort } from '@/lib/logAssistant';
import { Truck, Clock, Coffee, Gauge, Moon, RotateCcw, CheckCircle2, XCircle } from 'lucide-react';

export default function WhatCanIDoPanel({ info, tz }) {
  if (!info) return null;
  return (
    <div className="space-y-3">
      <div className={`rounded-xl border p-3 flex items-center gap-2 ${info.canDrive ? 'border-emerald-300 bg-emerald-50 text-emerald-800' : 'border-red-300 bg-red-50 text-red-800'}`}>
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
          ? <div className="text-xs text-emerald-700">Available now — your existing qualifying periods form a valid split; 11h & 14h clocks are already recalculated.</div>
          : info.splitConditional
            ? <div className="text-xs text-amber-700"><div className="font-medium">Would become available if you complete qualifying rest.</div>{info.splitConditional.description}</div>
            : <div className="text-xs text-slate-500">No qualifying split-sleeper periods in your current records.</div>}
      </Section>

      <Section title="Cycle hours returning">
        <Row label="Tomorrow" value={`${info.cycleReturningTomorrow.toFixed(1)} hr`} />
      </Section>

      <div className="text-[11px] text-slate-400">All values are computed deterministically from your actual log records. No AI request was used. The driver remains responsible for the accuracy of the record.</div>
    </div>
  );
}

function Card({ icon: Icon, label, value }) {
  return (
    <div className="rounded-lg border border-slate-100 p-2">
      <div className="flex items-center gap-1 text-xs text-slate-500"><Icon className="w-3.5 h-3.5" /> {label}</div>
      <div className="font-semibold mt-0.5">{value}</div>
    </div>
  );
}
function Section({ title, children }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-2">
      <div className="text-xs font-semibold text-slate-600 mb-1">{title}</div>
      {children}
    </div>
  );
}
function Row({ label, value }) {
  return <div className="flex items-center justify-between text-xs py-0.5"><span className="text-slate-500">{label}</span><span className="font-medium">{value}</span></div>;
}