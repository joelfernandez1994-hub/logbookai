import { fmtDur } from '@/lib/hosEngine';
import { fmtClockShort, planToStops } from '@/lib/logAssistant';
import { Button } from '@/components/ui/button';
import { AlertTriangle, ShieldCheck, AlertCircle, Check, ArrowRight, MapPin } from 'lucide-react';

const STATUS_LABELS = { OFF_DUTY: 'Off Duty', SLEEPER_BERTH: 'Sleeper', DRIVING: 'Driving', ON_DUTY: 'On Duty' };

export default function MakeItLegal({ mode, past, future, hosBeforeAfter, tz, onApplyCorrection, onSavePlan, loading }) {
  if (loading) return <div className="text-sm text-slate-500 text-center py-4">Analyzing…</div>;

  if (mode === 'past') {
    if (past?.refuses_fabrication) {
      return (
        <div className="rounded-xl border border-red-300 bg-red-50 p-3 text-red-800 text-sm">
          <AlertTriangle className="w-4 h-4 inline mr-1" />
          LogbookAI cannot make this change. Making a log "legal" never means fabricating or hiding events. Review what actually happened and correct genuine data-entry mistakes only.
        </div>
      );
    }
    return (
      <div className="space-y-3">
        {past?.analysis && <div className="text-sm text-slate-700 rounded-lg border border-slate-200 bg-white p-2">{past.analysis}</div>}
        {past?.factual_corrections?.length > 0 ? (
          past.factual_corrections.map((c, i) => {
            const ba = hosBeforeAfter?.[i] || {};
            return (
              <div key={i} className="rounded-xl border border-amber-300 bg-amber-50 p-3">
                <div className="text-sm font-semibold text-amber-900 mb-1">Possible logging error found</div>
                <div className="text-xs text-amber-800 mb-2">{c.description}</div>
                {c.evidence && <div className="text-xs text-amber-700 mb-2"><span className="font-medium">Evidence: </span>{c.evidence}</div>}
                <div className="grid grid-cols-2 gap-2 mb-2 text-xs">
                  <div className="rounded border border-amber-200 bg-white p-2">
                    <div className="font-medium text-slate-600 mb-1">BEFORE</div>
                    <div>{c.before_event}</div>
                    {ba.before && <div className="text-slate-500 mt-1">Driving rem: {fmtDur(ba.before.driveRemMs)}</div>}
                  </div>
                  <div className="rounded border border-emerald-200 bg-white p-2">
                    <div className="font-medium text-slate-600 mb-1">AFTER</div>
                    <div>{c.after_event}</div>
                    {ba.after && <div className="text-emerald-600 mt-1">Driving rem: {fmtDur(ba.after.driveRemMs)}</div>}
                  </div>
                </div>
                <div className="text-xs text-amber-900 mb-2"><span className="font-medium">Confirm: </span>{c.question_for_driver}</div>
                <Button size="sm" onClick={() => onApplyCorrection(i)}><Check className="w-3.5 h-3.5 mr-1" /> Yes, that's what happened — apply</Button>
              </div>
            );
          })
        ) : (
          <div className="rounded-xl border border-slate-200 bg-white p-3 text-sm text-slate-600">No factual correction could be identified from your records and supporting documents.</div>
        )}
        {past?.violations_remain?.length > 0 && (
          <div className="rounded-xl border border-red-300 bg-red-50 p-3 text-red-800 text-sm">
            <div className="font-semibold mb-1">HOS violation remains</div>
            <div className="text-xs mb-2">Based on the information provided, LogbookAI cannot identify a factual correction that eliminates this violation.</div>
            {past.violations_remain.map((v, i) => <div key={i} className="text-xs">{v.rule}: {v.message}</div>)}
            <div className="text-xs mt-2">Options: Add a driver annotation, correct an entry, or review the timeline. The driver remains responsible for the accuracy of the record.</div>
          </div>
        )}
      </div>
    );
  }

  // FUTURE
  if (!future) return null;
  const feasible = future.feasibility === 'feasible';
  return (
    <div className="space-y-3">
      <div className={`rounded-xl border p-3 flex items-start gap-2 ${feasible ? 'border-emerald-300 bg-emerald-50 text-emerald-800' : 'border-red-300 bg-red-50 text-red-800'}`}>
        {feasible ? <ShieldCheck className="w-4 h-4 mt-0.5" /> : <AlertCircle className="w-4 h-4 mt-0.5" />}
        <div className="text-sm">
          <div className="font-semibold">{feasible ? 'HOS-compliant plan generated' : 'Requested arrival is not HOS-feasible'}</div>
          {future.earliest_eta && <div className="text-xs mt-0.5">Earliest reasonable compliant ETA: {fmtClockShort(future.earliest_eta, tz)}</div>}
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-3">
        <div className="text-xs text-slate-400 font-medium mb-2">PLANNED — NOT YET LOGGED</div>
        <div className="space-y-1">
          {(future.plan || []).map((s, i) => (
            <div key={i} className="flex items-center gap-2 text-xs">
              <div className="font-mono text-slate-400 w-20 shrink-0">{fmtClockShort(s.start_offset_min != null ? new Date(Date.now() + s.start_offset_min * 60000) : null, tz)}</div>
              <div className="font-semibold w-24 shrink-0">{STATUS_LABELS[s.duty_status] || s.duty_status}</div>
              <div className="flex-1 text-slate-600">{s.label}{s.city ? ` · ${s.city}${s.state ? `, ${s.state}` : ''}` : ''}</div>
              <div className="text-slate-400">{s.duration_min ? `${(s.duration_min / 60).toFixed(1)}h` : ''}</div>
            </div>
          ))}
        </div>
        {future.notes && <div className="text-xs text-slate-500 mt-2">{future.notes}</div>}
      </div>

      <Button onClick={() => onSavePlan(planToStops(future.plan))} disabled={!future.plan?.length}>
        <ArrowRight className="w-4 h-4 mr-1" /> Save as Planned Trip
      </Button>
      <div className="text-[11px] text-slate-400">Planned events are saved as a future trip and do not affect your current HOS clocks until you actually log them.</div>
    </div>
  );
}