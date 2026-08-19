import { useMemo, useState, useEffect } from 'react';
import { validateProposal, hasBlocking, recommendBreakInsertion, buildPreTripEvent } from '@/lib/proposalValidation';
import { highestSeverity, fmtClockShort } from '@/lib/logAssistant';
import { fmtDur, dateKeyInTz } from '@/lib/hosEngine';
import LogGraph from '@/components/LogGraph';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Check, X, Pencil, AlertTriangle, ShieldCheck, AlertCircle, Plus } from 'lucide-react';
import PreTripDialog from '@/components/PreTripDialog';

const STATUS_LABELS = { OFF_DUTY: 'Off Duty', SLEEPER_BERTH: 'Sleeper', DRIVING: 'Driving', ON_DUTY: 'On Duty' };
const STATUSES = ['OFF_DUTY', 'SLEEPER_BERTH', 'DRIVING', 'ON_DUTY'];

export default function ProposalReview({ existing, proposed, cycleType, tz, onApply, onCancel, interpretation, clarifications, onResolveClarification, routeWarning }) {
  const [editable, setEditable] = useState(false);
  const [events, setEvents] = useState(proposed);
  const [pretripOpen, setPretripOpen] = useState(false);
  useEffect(() => { setEvents(proposed); }, [proposed]);

  const evalNow = useMemo(() => {
    let t = new Date();
    for (const p of events) if (p.end_timestamp) t = new Date(p.end_timestamp) > t ? new Date(p.end_timestamp) : t;
    return t;
  }, [events]);

  // MANDATORY validation pipeline (deterministic). routeWarning supplied async by parent.
  const validation = useMemo(
    () => validateProposal(existing, events, { cycleType, tz, now: evalNow }),
    [existing, events, cycleType, tz, evalNow]
  );
  const warnings = useMemo(() => {
    const ws = [...validation.warnings];
    if (routeWarning) ws.push(routeWarning);
    return ws;
  }, [validation.warnings, routeWarning]);

  const blocking = hasBlocking(warnings);
  const violations = validation.violations;
  const hos = validation.hos;
  const isFuture = validation.isFuture;

  const severity = blocking ? 'red' : (warnings.length > 0 ? 'amber' : (violations.length > 0 ? highestSeverity(violations) : 'green'));
  const sevStyle = severity === 'green' ? 'border-emerald-300 bg-emerald-50 text-emerald-800'
    : severity === 'amber' ? 'border-amber-300 bg-amber-50 text-amber-800'
      : 'border-red-300 bg-red-50 text-red-800';
  const SevIcon = severity === 'green' ? ShieldCheck : severity === 'amber' ? AlertCircle : AlertTriangle;

  const proposedDate = events[0]?.start_timestamp ? dateKeyInTz(new Date(events[0].start_timestamp), tz) : dateKeyInTz(new Date(), tz);

  const updateField = (i, field, val) => setEvents(prev => prev.map((e, idx) => idx === i ? { ...e, [field]: val } : e));
  const updateTs = (i, field, localVal) => updateField(i, field, localVal ? new Date(localVal).toISOString() : null);

  const addPreTrip = ({ start_timestamp, duration_min, city, state, alreadySatisfied }) => {
    if (alreadySatisfied) { setPretripOpen(false); return; }
    const firstDriveIdx = events.findIndex(p => p.duty_status === 'DRIVING');
    const driveStart = firstDriveIdx >= 0 ? new Date(events[firstDriveIdx].start_timestamp) : new Date();
    const pre = buildPreTripEvent({ start_timestamp, duration_min, city, state, date: dateKeyInTz(driveStart, tz), source: 'manual' });
    setEvents(prev => [pre, ...prev]);
    setPretripOpen(false);
  };

  const addRecommendedBreak = () => {
    const br = recommendBreakInsertion(events, evalNow);
    if (!br) return;
    setEvents(prev => [...prev, br].sort((a, b) => new Date(a.start_timestamp) - new Date(b.start_timestamp)));
  };

  const pretripWarning = warnings.find(w => w.type === 'pretrip');
  const breakWarning = warnings.find(w => w.type === 'break30');

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3 mb-3">
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm font-semibold">PROPOSED LOG — review before saving</div>
        <div className="text-xs text-slate-400">Not yet logged</div>
      </div>
      {interpretation && <div className="text-sm text-slate-700 mb-2">{interpretation}</div>}

      {clarifications?.length > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-2 mb-2 space-y-1">
          {clarifications.map((c, i) => (
            <div key={i} className="text-xs text-amber-900">
              <span className="font-medium">Clarification: </span>{c.question}
              {c.options && (
                <div className="flex gap-2 mt-1">
                  {c.options.map((o, j) => (
                    <button key={j} className="rounded border border-amber-400 px-2 py-0.5 hover:bg-amber-100"
                      onClick={() => onResolveClarification?.(i, o)}>{o}</button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Mandatory validation warnings */}
      {warnings.length > 0 && (
        <div className="space-y-2 mb-2">
          {warnings.map((w, i) => (
            <div key={i} className={`rounded-lg border p-2 flex items-start gap-2 ${w.severity === 'blocking' ? 'border-red-300 bg-red-50' : 'border-amber-300 bg-amber-50'}`}>
              <AlertTriangle className={`w-4 h-4 mt-0.5 shrink-0 ${w.severity === 'blocking' ? 'text-red-600' : 'text-amber-600'}`} />
              <div className="text-xs flex-1">
                <div className={`font-semibold ${w.severity === 'blocking' ? 'text-red-900' : 'text-amber-900'}`}>{w.title}</div>
                <div className={w.severity === 'blocking' ? 'text-red-800' : 'text-amber-800'}>{w.message}</div>
                {w.type === 'pretrip' && (
                  <div className="flex gap-2 mt-1">
                    <Button size="sm" onClick={() => setPretripOpen(true)}><Plus className="w-3.5 h-3.5 mr-1" /> Add Pre-Trip</Button>
                  </div>
                )}
                {w.type === 'break30' && isFuture && (
                  <Button size="sm" className="mt-1" onClick={addRecommendedBreak}><Plus className="w-3.5 h-3.5 mr-1" /> Add 30-min break (planned)</Button>
                )}
                {w.type === 'break30' && !isFuture && (
                  <div className="text-[11px] mt-0.5">If a real stop occurred, add the actual event via Edit Proposal. LogbookAI will not fabricate a break.</div>
                )}
                {w.hint && <div className="text-[11px] mt-0.5 opacity-80">{w.hint}</div>}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="rounded-lg border border-slate-100 p-2 mb-2">
        <div className="text-xs text-slate-500 mb-1">24-hour RODS graph (proposed)</div>
        <LogGraph events={[...existing, ...events.map(e => ({ ...e, start_timestamp: e.start_timestamp, end_timestamp: e.end_timestamp }))]} dateStr={proposedDate} timezone={tz} />
      </div>

      <div className="space-y-1 mb-2">
        {events.map((e, i) => (
          <div key={i} className="rounded-lg border border-slate-100 p-2 text-xs">
            {editable ? (
              <div className="space-y-1">
                <div className="grid grid-cols-2 gap-1">
                  {STATUSES.map(s => (
                    <button key={s} onClick={() => updateField(i, 'duty_status', s)}
                      className={`rounded border px-1 py-0.5 ${e.duty_status === s ? 'border-slate-900 bg-slate-50 font-medium' : 'border-slate-200'}`}>{STATUS_LABELS[s]}</button>
                  ))}
                </div>
                <div className="grid grid-cols-2 gap-1">
                  <Input type="datetime-local" value={e.start_timestamp ? new Date(e.start_timestamp).toISOString().slice(0, 16) : ''} onChange={(ev) => updateTs(i, 'start_timestamp', ev.target.value)} />
                  <Input type="datetime-local" value={e.end_timestamp ? new Date(e.end_timestamp).toISOString().slice(0, 16) : ''} onChange={(ev) => updateTs(i, 'end_timestamp', ev.target.value)} />
                </div>
                <div className="grid grid-cols-2 gap-1">
                  <Input placeholder="City" value={e.city || ''} onChange={(ev) => updateField(i, 'city', ev.target.value)} />
                  <Input placeholder="State" value={e.state || ''} onChange={(ev) => updateField(i, 'state', ev.target.value.toUpperCase())} maxLength={2} />
                </div>
                <Input placeholder="Remark" value={e.remark || ''} onChange={(ev) => updateField(i, 'remark', ev.target.value)} />
                {e.ambiguous_fields?.length > 0 && <div className="text-amber-600">Guessed: {e.ambiguous_fields.join(', ')} — please verify.</div>}
              </div>
            ) : (
              <div className="flex items-start gap-2">
                <div className="font-mono text-slate-400 w-28 shrink-0">
                  {fmtClockShort(e.start_timestamp, tz)} – {e.end_timestamp ? fmtClockShort(e.end_timestamp, tz) : 'ongoing'}
                </div>
                <div className="flex-1">
                  <div className="font-semibold">{STATUS_LABELS[e.duty_status] || e.duty_status}{e.activity_type ? ` · ${e.activity_type}` : ''}</div>
                  <div className="text-slate-600">{[e.city, e.state].filter(Boolean).join(', ')}{e.remark ? ` — ${e.remark}` : ''}</div>
                  {e.confidence && e.confidence !== 'high' && <div className="text-amber-600">Confidence: {e.confidence}</div>}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className={`rounded-lg border p-2 mb-2 flex items-start gap-2 ${sevStyle}`}>
        <SevIcon className="w-4 h-4 mt-0.5 shrink-0" />
        <div className="text-xs">
          <div className="font-semibold">
            {blocking ? 'Resolve the issue(s) above before confirming' : severity === 'green' ? 'No HOS violation detected' : severity === 'amber' ? 'Review needed' : 'HOS violation detected'}
          </div>
          {!blocking && violations.length > 0 && (
            <ul className="list-disc ml-4 mt-0.5">
              {violations.map((v, i) => <li key={i}>{v.rule}: {v.message}</li>)}
            </ul>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 mb-3 text-xs">
        <div className="rounded border border-slate-100 p-2"><div className="text-slate-500">Driving Remaining</div><div className="font-semibold">{fmtDur(hos.driving.drivingRemainingMs)}</div></div>
        <div className="rounded border border-slate-100 p-2"><div className="text-slate-500">14-Hour Window</div><div className="font-semibold">{fmtDur(hos.window14.remainingMs)}</div></div>
        <div className="rounded border border-slate-100 p-2"><div className="text-slate-500">30-Min Break</div><div className="font-semibold">{validation.break.satisfied ? 'Satisfied' : (validation.break.required ? 'Required' : 'Not yet')}</div></div>
        <div className="rounded border border-slate-100 p-2"><div className="text-slate-500">Cycle {hos.cycle.cycleLimit}/{hos.cycle.cycleDays}</div><div className="font-semibold">{hos.cycle.cycleRemainingHours.toFixed(1)} hr</div></div>
      </div>

      <div className="flex gap-2">
        <Button className="flex-1" disabled={blocking} onClick={() => onApply(events)}><Check className="w-4 h-4 mr-1" /> Confirm & Apply</Button>
        <Button variant="outline" onClick={() => setEditable(v => !v)}><Pencil className="w-4 h-4 mr-1" /> Edit Proposal</Button>
        <Button variant="ghost" onClick={onCancel}><X className="w-4 h-4" /></Button>
      </div>
      {blocking && <div className="text-[11px] text-red-600 mt-2">Confirm & Apply is locked until the blocking issue is resolved or the proposal is edited.</div>}
      <div className="text-[11px] text-slate-400 mt-1">Validation + HOS values are computed by LogbookAI's deterministic engine. Nothing is written to your log until you confirm.</div>

      <PreTripDialog open={pretripOpen} onOpenChange={setPretripOpen}
        drivingStart={pretripWarning?.drivingStart}
        defaultCity={events[0]?.city} defaultState={events[0]?.state}
        onConfirm={addPreTrip} />
    </div>
  );
}