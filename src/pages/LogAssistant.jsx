import { useState, useMemo, useEffect } from 'react';
import { useDriverData } from '@/hooks/useDriverData';
import { base44 } from '@/api/base44Client';
import { getAppSettings, getAIUsage, createHistoricalEvent, updateEvent } from '@/lib/driverData';
import { computeHOS, fmtDur } from '@/lib/hosEngine';
import { whatCanIDo, computeProposedHOS, buildCorrectionVersion } from '@/lib/logAssistant';
import { addRouteWarning, fetchRoute, DEFAULT_SPEED_PROFILE } from '@/lib/proposalValidation';
import AssistantInput from '@/components/logAssistant/AssistantInput';
import ProposalReview from '@/components/logAssistant/ProposalReview';
import WhatCanIDoPanel from '@/components/logAssistant/WhatCanIDoPanel';
import MakeItLegal from '@/components/logAssistant/MakeItLegal';
import { Button } from '@/components/ui/button';
import { Bot, Gavel, HelpCircle, AlertTriangle, Mic } from 'lucide-react';

const TABS = [
  { id: 'tell', label: 'Tell LogbookAI', icon: Bot },
  { id: 'makeLegal', label: 'Make It Legal', icon: Gavel },
  { id: 'whatCanIDo', label: 'What Can I Do?', icon: HelpCircle },
];

export default function LogAssistant() {
  const { profile, carrier, equipment, events, loading, reload } = useDriverData();
  const initialTab = new URLSearchParams(window.location.search).get('tab') || 'tell';
  const [tab, setTab] = useState(['tell', 'makeLegal', 'whatCanIDo'].includes(initialTab) ? initialTab : 'tell');
  const [mlMode, setMlMode] = useState('past'); // past | future
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [proposal, setProposal] = useState(null); // interpret result
  const [pastResult, setPastResult] = useState(null);
  const [futureResult, setFutureResult] = useState(null);
  const [futureInput, setFutureInput] = useState('');
  const [usage, setUsage] = useState({ used: 0, allowance: 20 });
  const [now, setNow] = useState(new Date());
  const [routeWarning, setRouteWarning] = useState(null);
  const speedProfile = profile?.trip_planning_speed_profile || DEFAULT_SPEED_PROFILE;

  const tz = carrier?.home_terminal_timezone || profile?.home_terminal_timezone || 'America/Chicago';
  const cycleType = carrier?.hos_cycle || '70_8';

  useEffect(() => { (async () => {
    const used = await getAIUsage();
    const s = await getAppSettings();
    setUsage({ used, allowance: profile?.ai_allowance_override ?? s.default_ai_allowance ?? 20 });
  })(); }, [profile]);
  useEffect(() => { const t = setTimeout(() => setNow(new Date()), 30000); return () => clearTimeout(t); }, [now]);

  const hos = useMemo(() => computeHOS(events, cycleType, tz, now, { historyComplete: true }), [events, cycleType, tz, now]);
  const hosSummary = useMemo(() => buildHosSummary(hos), [hos]);

  const whatInfo = useMemo(() => whatCanIDo(events, cycleType, tz, now), [events, cycleType, tz, now]);

  // Async route reasonableness for the proposed driving segments (real road route).
  useEffect(() => {
    if (!proposal?.proposed_events) { setRouteWarning(null); return; }
    let cancelled = false;
    const firstStart = proposal.proposed_events[0]?.start_timestamp;
    const isFuture = firstStart ? new Date(firstStart) > new Date() : false;
    addRouteWarning(proposal.proposed_events, { routingProvider: fetchRoute, speedProfile, now: new Date(), isFuture })
      .then(w => { if (!cancelled) setRouteWarning(w); })
      .catch(() => { if (!cancelled) setRouteWarning(null); });
    return () => { cancelled = true; };
  }, [proposal, speedProfile]);

  const resetResults = () => { setProposal(null); setPastResult(null); setFutureResult(null); setError(''); setRouteWarning(null); };

  const callAssistant = async (mode, input, extra = {}) => {
    setBusy(true); setError('');
    try {
      const res = await base44.functions.invoke('manualLogAssistant', {
        mode, input,
        events: events.map(simplifyEvent),
        documents: extra.documents || [],
        currentLocation: extra.currentLocation || '',
        tractor: equipment?.[0]?.unit_number || '',
        trailer: equipment?.find(e => e.type === 'trailer')?.unit_number || '',
        hosSummary,
        origin: extra.origin, destination: extra.destination, requestedArrival: extra.requestedArrival,
      });
      if (res.status === 429 || res.data?.limit) setError(res.data?.error || 'AI limit reached.');
      else if (res.data?.disabled) setError(res.data?.error || 'AI disabled.');
      else if (res.data?.error) setError(res.data.error);
      else {
        if (mode === 'interpret') setProposal(res.data);
        else if (mode === 'make_legal_past') setPastResult(res.data);
        else if (mode === 'make_legal_future') setFutureResult(res.data);
      }
      const used = await getAIUsage(); setUsage(u => ({ ...u, used }));
    } catch (e) { setError(e.response?.data?.error || e.message); }
    setBusy(false);
  };

  // --- TELL: apply proposed events ---
  const applyProposal = async (proposedEvents) => {
    if (!proposedEvents?.length) { reload(); return; }
    const firstStart = new Date(proposedEvents[0].start_timestamp).toISOString();
    const ongoing = events.find(e => e.is_ongoing);
    if (ongoing) await base44.entities.DutyStatusEvent.update(ongoing.id, { end_timestamp: firstStart, is_ongoing: false });
    for (let i = 0; i < proposedEvents.length; i++) {
      const p = proposedEvents[i];
      const isLast = i === proposedEvents.length - 1;
      await createHistoricalEvent({
        log_date: (p.date || new Date(p.start_timestamp).toISOString().slice(0, 10)),
        start_timestamp: p.start_timestamp,
        end_timestamp: p.end_timestamp || (isLast ? null : p.end_timestamp),
        duty_status: p.duty_status,
        city: p.city || '', state: p.state || '',
        remark: p.remark || p.activity_type || '',
        tractor_number: p.tractor_number || '', trailer_numbers: p.trailer_numbers || '',
        carrier_name: carrier?.carrier_name,
        method_of_creation: p.source === 'voice' ? 'Voice AI' : 'Typed AI',
        is_ongoing: isLast && !p.end_timestamp,
      });
    }
    setProposal(null); reload();
  };

  const resolveClarification = (idx, answer) => {
    const c = proposal?.clarifications?.[idx];
    if (!c) return;
    if (c.type === 'pretrip' && /(\d+)\s*min/i.test(answer)) {
      const mins = parseInt(RegExp.$1, 10);
      const firstDrive = proposal.proposed_events.findIndex(p => p.duty_status === 'DRIVING');
      if (firstDrive >= 0) {
        const driveStart = new Date(proposal.proposed_events[firstDrive].start_timestamp);
        const preStart = new Date(driveStart.getTime() - mins * 60000);
        const pre = {
          date: proposal.proposed_events[firstDrive].date,
          start_timestamp: preStart.toISOString(),
          end_timestamp: driveStart.toISOString(),
          duty_status: 'ON_DUTY',
          activity_type: 'Pre-Trip',
          remark: 'Pre-Trip Inspection',
          city: proposal.proposed_events[firstDrive].city,
          state: proposal.proposed_events[firstDrive].state,
          source: 'manual', confidence: 'high', ambiguous_fields: [],
        };
        setProposal(p => ({ ...p, proposed_events: [pre, ...p.proposed_events], clarifications: p.clarifications.filter((_, i) => i !== idx) }));
      }
    } else {
      setProposal(p => ({ ...p, clarifications: p.clarifications.filter((_, i) => i !== idx) }));
    }
  };

  // --- MAKE IT LEGAL: PAST ---
  const pastHosBeforeAfter = useMemo(() => {
    if (!pastResult?.factual_corrections) return [];
    return pastResult.factual_corrections.map((c) => {
      if (c.event_index == null || c.event_index < 0 || !c.proposed_event) return {};
      const before = computeHOS(events, cycleType, tz, now, { historyComplete: true });
      const copy = events.map((e, i) => i === c.event_index ? {
        ...e,
        duty_status: c.proposed_event.duty_status,
        start_timestamp: c.proposed_event.start_timestamp || e.start_timestamp,
        end_timestamp: c.proposed_event.end_timestamp || e.end_timestamp,
        city: c.proposed_event.city ?? e.city, state: c.proposed_event.state ?? e.state,
        remark: c.proposed_event.remark || e.remark,
      } : e);
      const after = computeHOS(copy, cycleType, tz, now, { historyComplete: true });
      return { before: { driveRemMs: before.driving.drivingRemainingMs }, after: { driveRemMs: after.driving.drivingRemainingMs } };
    });
  }, [pastResult, events, cycleType, tz, now]);

  const applyCorrection = async (idx) => {
    const c = pastResult.factual_corrections[idx];
    if (!c || c.event_index == null || c.event_index < 0 || !c.proposed_event) return;
    const target = events[c.event_index];
    if (!target) return;
    // preserve version + supersede certification (same audit logic as Logs edit)
    const cert = await base44.entities.Certification.filter({ log_date: target.log_date });
    const active = (cert || []).find(x => !x.is_superseded);
    await base44.entities.EventVersion.create(buildCorrectionVersion(target, c.description, profile?.legal_name));
    if (active) await base44.entities.Certification.update(active.id, { is_superseded: true });
    await updateEvent(target.id, {
      duty_status: c.proposed_event.duty_status,
      start_timestamp: c.proposed_event.start_timestamp || target.start_timestamp,
      end_timestamp: c.proposed_event.end_timestamp || target.end_timestamp,
      city: c.proposed_event.city ?? target.city, state: c.proposed_event.state ?? target.state,
      remark: c.proposed_event.remark || target.remark,
      method_of_creation: 'Correction',
    });
    setPastResult(p => ({ ...p, factual_corrections: p.factual_corrections.filter((_, i) => i !== idx) }));
    reload();
  };

  // --- MAKE IT LEGAL: FUTURE ---
  const savePlan = async (stops) => {
    if (!stops?.length) return;
    const trip = await base44.entities.Trip.create({
      pickup_city: futureResult?.origin || '', pickup_state: '',
      delivery_city: futureResult?.destination || '', delivery_state: '',
      status: 'planned', is_achievable: futureResult?.feasibility === 'feasible',
      feasibility_note: futureResult?.notes || '',
    });
    for (const s of stops) {
      await base44.entities.TripStop.create({ ...s, trip_id: trip.id, planned: true });
    }
    setFutureResult(null); setFutureInput('');
    reload();
  };

  if (loading) return <div className="flex items-center justify-center h-screen"><div className="w-8 h-8 border-4 border-slate-200 border-t-slate-800 rounded-full animate-spin" /></div>;

  const remaining = usage.allowance - usage.used;

  return (
    <div className="px-4 pt-6 pb-6 max-w-2xl mx-auto">
      <h1 className="text-xl font-bold mb-1">Manual Log Assistant</h1>
      <p className="text-xs text-slate-500 mb-3">LogbookAI checks the information you provide against the configured FMCSA HOS rules. LogbookAI is not an ELD. The driver remains responsible for the accuracy, completeness, and certification of the record. {remaining} of {usage.allowance} AI requests remaining.</p>

      <div className="grid grid-cols-3 gap-2 mb-3">
        {TABS.map(t => {
          const Icon = t.icon;
          return (
            <button key={t.id} onClick={() => { setTab(t.id); resetResults(); }}
              className={`rounded-xl border p-3 text-xs font-medium flex flex-col items-center gap-1 ${tab === t.id ? 'border-slate-900 bg-slate-50' : 'border-slate-200'}`}>
              <Icon className="w-5 h-5" /> {t.label}
            </button>
          );
        })}
      </div>

      {error && <div className="rounded-lg border border-amber-300 bg-amber-50 p-2 mb-3 text-xs text-amber-900 flex gap-1"><AlertTriangle className="w-4 h-4 shrink-0" /> {error}</div>}

      {tab === 'tell' && (
        <>
          <AssistantInput onSend={(text, type) => callAssistant('interpret', text, {})} disabled={busy || remaining <= 0} />
          {busy && <div className="text-sm text-slate-500 text-center py-4"><Bot className="w-4 h-4 inline animate-pulse mr-1" /> Interpreting…</div>}
          {proposal && !busy && (
            <ProposalReview
              existing={events}
              proposed={proposal.proposed_events}
              interpretation={proposal.interpretation}
              clarifications={proposal.clarifications}
              cycleType={cycleType} tz={tz}
              onApply={applyProposal}
              onCancel={() => setProposal(null)}
              onResolveClarification={resolveClarification}
              routeWarning={routeWarning}
            />
          )}
          {proposal?.refuses_fabrication && (
            <div className="rounded-xl border border-red-300 bg-red-50 p-3 text-red-800 text-sm mb-3">
              <AlertTriangle className="w-4 h-4 inline mr-1" /> LogbookAI will not fabricate or hide events to make a log appear legal. Review what actually happened.
            </div>
          )}
        </>
      )}

      {tab === 'makeLegal' && (
        <>
          <div className="flex gap-2 mb-3">
            <Button variant={mlMode === 'past' ? 'default' : 'outline'} size="sm" onClick={() => { setMlMode('past'); setPastResult(null); }}>Past / Current Log</Button>
            <Button variant={mlMode === 'future' ? 'default' : 'outline'} size="sm" onClick={() => { setMlMode('future'); setFutureResult(null); }}>Future Plan</Button>
          </div>
          {mlMode === 'past' ? (
            <>
              <AssistantInput onSend={(text) => callAssistant('make_legal_past', text, {})} disabled={busy || remaining <= 0} />
              {busy && <div className="text-sm text-slate-500 text-center py-4"><Gavel className="w-4 h-4 inline animate-pulse mr-1" /> Analyzing your log…</div>}
              {!busy && <MakeItLegal mode="past" past={pastResult} hosBeforeAfter={pastHosBeforeAfter} tz={tz} onApplyCorrection={applyCorrection} />}
            </>
          ) : (
            <>
              <AssistantInput onSend={(text) => callAssistant('make_legal_future', text, {})} disabled={busy || remaining <= 0} />
              {busy && <div className="text-sm text-slate-500 text-center py-4"><Gavel className="w-4 h-4 inline animate-pulse mr-1" /> Building a compliant plan…</div>}
              {!busy && <MakeItLegal mode="future" future={futureResult} tz={tz} onSavePlan={savePlan} />}
            </>
          )}
        </>
      )}

      {tab === 'whatCanIDo' && (
        <>
          <div className="text-xs text-slate-500 mb-2">Answers from your actual records — no AI request used.</div>
          <WhatCanIDoPanel info={whatInfo} tz={tz} />
        </>
      )}
    </div>
  );
}

function simplifyEvent(e) {
  return {
    start_timestamp: e.start_timestamp, end_timestamp: e.end_timestamp,
    duty_status: e.duty_status, city: e.city, state: e.state, remark: e.remark,
    tractor_number: e.tractor_number, trailer_numbers: e.trailer_numbers,
    is_ongoing: e.is_ongoing,
  };
}

function buildHosSummary(hos) {
  return [
    `Driving remaining: ${fmtDur(hos.driving.drivingRemainingMs)}`,
    `14-hour window remaining: ${fmtDur(hos.window14.remainingMs)}`,
    `30-min break: ${hos.break30.satisfied ? 'satisfied' : (hos.break30.breakRequired ? 'required' : 'not yet required')}`,
    `Cycle ${hos.cycle.cycleLimit}/${hos.cycle.cycleDays} remaining: ${hos.cycle.cycleRemainingHours.toFixed(1)} hr`,
    `Split sleeper: ${hos.split.status}`,
    `34h restart: ${hos.restart.inProgress ? 'in progress' : (hos.restart.completed ? 'completed' : 'none')}`,
  ].join('\n');
}