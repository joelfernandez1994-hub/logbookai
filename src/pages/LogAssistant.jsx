import { useState, useMemo, useEffect, useRef } from 'react';
import { useDriverData } from '@/hooks/useDriverData';
import { base44 } from '@/api/base44Client';
import { getAppSettings, getAIUsage } from '@/lib/driverData';
import { computeHOS, fmtDur, startOfDayInTz, dateKeyInTz } from '@/lib/hosEngine';
import { whatCanIDo, computeProposedHOS, earliestLegalEta } from '@/lib/logAssistant';
import { addRouteWarning, enrichProposalMileage, fetchRoute, truckEtaHours, DEFAULT_SPEED_PROFILE } from '@/lib/proposalValidation';
import { saveProposalMiles } from '@/lib/tripSync';
import { insertEventsBatch, editEvent, replaceRangeEvents } from '@/lib/timelineWriter';
import { parseVoiceCommand } from '@/lib/voiceParser';
import { validateInterpretResult, isQuestionIntent, shouldOfferApply, replaceDayRange } from '@/lib/aiLayer';
import AssistantInput from '@/components/logAssistant/AssistantInput';
import ProposalReview from '@/components/logAssistant/ProposalReview';
import WhatCanIDoPanel from '@/components/logAssistant/WhatCanIDoPanel';
import MakeItLegal from '@/components/logAssistant/MakeItLegal';
import Header from '@/components/Header';
import { Button } from '@/components/ui/button';
import { Bot, Gavel, HelpCircle, AlertTriangle } from 'lucide-react';

const TABS = [
  { id: 'tell', label: 'Tell LogbookAI', icon: Bot },
  { id: 'makeLegal', label: 'HOS Check', icon: Gavel },
  { id: 'whatCanIDo', label: 'What Can I Do?', icon: HelpCircle },
];

// Detects narratives that describe more than one event/activity and should go
// straight to the AI instead of the deterministic single-intent parser.
function isMultiEventNarrative(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return false;
  if (/\bdrove\s+from\b/.test(t) || /\bcontinued\s+to\b/.test(t) || /\bcontinued\s+driving\b/.test(t)) return true;
  if (/\brest of (?:the )?day\b/.test(t) || /\bdone for the day\b/.test(t) || /\bend of (?:the )?day\b/.test(t)) return true;
  const hasDriving = /\b(driv|drove|drive)\b/.test(t);
  const hasOtherActivity = /\b(fuel|fueled|load|loaded|unload|unloaded|lunch|post[-\s]?trip|pre[-\s]?trip|sleeper|break|inspection|drop|hook)\b/.test(t);
  if (hasDriving && hasOtherActivity) return true;
  const concepts = ['driving', 'drove', 'fuel', 'fueled', 'load', 'loaded', 'unload', 'unloaded', 'pre-trip', 'pretrip', 'post-trip', 'posttrip', 'sleeper', 'off duty', 'off-duty', 'on duty', 'on-duty', 'lunch', 'break', 'inspection'];
  let distinct = 0;
  for (const c of concepts) if (new RegExp(`\\b${c}\\b`).test(t)) distinct++;
  return distinct >= 2;
}

export default function LogAssistant() {
  const { profile, carrier, equipment, events, loading, reload } = useDriverData();
  const initialTab = new URLSearchParams(window.location.search).get('tab') || 'tell';
  const [tab, setTab] = useState(['tell', 'makeLegal', 'whatCanIDo'].includes(initialTab) ? initialTab : 'tell');
  const [mlMode, setMlMode] = useState('past'); // past | future
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [proposal, setProposal] = useState(null); // interpret result (normalized)
  const [pastResult, setPastResult] = useState(null);
  const [futureResult, setFutureResult] = useState(null);
  const [futureInput, setFutureInput] = useState('');
  const [usage, setUsage] = useState({ used: 0, allowance: 20 });
  const [now, setNow] = useState(new Date());
  const [routeWarning, setRouteWarning] = useState(null);
  // In-flight Apply guard: a single Apply flow may not be re-entered. The
  // ProposalReview button also locks visually; this ref defends against any
  // other caller invoking applyProposal/applyReplaceDay while one is running.
  const applyingRef = useRef(false);
  const speedProfile = profile?.trip_planning_speed_profile || DEFAULT_SPEED_PROFILE;

  const tz = carrier?.home_terminal_timezone || 'America/Chicago';
  const cycleType = carrier?.hos_cycle || '70_8';

  useEffect(() => { (async () => {
    const used = await getAIUsage();
    const s = await getAppSettings();
    setUsage({ used, allowance: profile?.ai_allowance_override ?? s.default_ai_allowance ?? 20 });
  })(); }, [profile]);
  useEffect(() => { const t = setTimeout(() => setNow(new Date()), 30000); return () => clearTimeout(t); }, [now]);

  const hos = useMemo(() => computeHOS(events, cycleType, tz, now, { historyComplete: true }), [events, cycleType, tz, now]);
  const hosSummary = useMemo(() => buildHosSummary(hos), [hos]);

  const whatInfo = useMemo(
    () => whatCanIDo(events, cycleType, tz, now, profile?.entered_prior_history),
    [events, cycleType, tz, now, profile?.entered_prior_history]
  );

  const prepareProposal = async (value) => {
    if (!value?.proposed_events?.length) { setRouteWarning(null); return value; }
    const enriched = await enrichProposalMileage(value.proposed_events, { routingProvider: fetchRoute, speedProfile, now: new Date() });
    const firstStart = enriched.events[0]?.start_timestamp;
    const isFuture = firstStart ? new Date(firstStart) > new Date() : false;
    const warning = await addRouteWarning(enriched.events, { routingProvider: fetchRoute, speedProfile, now: new Date(), isFuture, legs: enriched.legs });
    setRouteWarning(warning);
    return { ...value, proposed_events: enriched.events };
  };

  const resetResults = () => { setProposal(null); setPastResult(null); setFutureResult(null); setError(''); setRouteWarning(null); };

  // ---------------------------------------------------------------------------
  // TELL tab: deterministic voice/text command parser runs FIRST (no quota).
  // If it confidently handles the command, we propose deterministically and
  // never call the backend. Otherwise we fall back to the OpenAI-backed function.
  // Returns true on success (so AssistantInput clears the input), false on
  // failure (input is preserved for retry).
  // ---------------------------------------------------------------------------
  const handleTell = async (text, type) => {
    setError('');
    // AI-first routing: any narrative describing more than one event/activity
    // goes straight to manualLogAssistant. The deterministic parser is kept
    // only for trivial single-intent commands ("off duty now", "sleeper at 10 PM").
    if (isMultiEventNarrative(text)) {
      return callAssistant('interpret', text, { source: type });
    }
    const det = parseVoiceCommand(text, { now: new Date(), timezone: tz });
    if (det.handled) {
      const detEvents = (det.events || []).map((e) => ({
        ...e,
        date: e.start_timestamp ? e.start_timestamp.slice(0, 10) : '',
        source: type === 'voice' ? 'voice' : 'manual',
        confidence: 'high',
        ambiguous_fields: [e._ambiguous?.time && 'start_timestamp', e._ambiguous?.location && 'state'].filter(Boolean),
      }));
      const prepared = await prepareProposal({
        intent: det.edit ? 'edit_events' : 'add_events',
        target_date: detEvents[0]?.date || dateKeyInTz(new Date(), tz),
        requires_clarification: (det.clarifications || []).length > 0,
        clarification_question: det.clarifications?.[0]?.question || '',
        interpretation: 'I understood:',
        proposed_events: detEvents,
        clarifications: det.clarifications || [],
        refuses_fabrication: false,
        _deterministic: true,
      });
      setProposal(prepared);
      return true;
    }
    return callAssistant('interpret', text, { source: type });
  };

  // ---------------------------------------------------------------------------
  // OpenAI-backed call. Returns true on success (clear input), false on
  // failure (preserve input). On unavailability the driver's request is NOT
  // applied and the typed text is kept for retry.
  // ---------------------------------------------------------------------------
  const callAssistant = async (mode, input, extra = {}) => {
    setBusy(true); setError('');
    let ok = false;
    try {
      const res = await base44.functions.invoke('manualLogAssistant', {
        mode, input,
        source: extra.source || 'typed',
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
      else if (res.data?.unavailable) setError(res.data?.error || 'LogbookAI is temporarily unavailable. Your request has not been applied.');
      else if (res.data?.error) setError(res.data.error);
      else {
        if (mode === 'interpret') {
          const { valid, errors, normalized } = validateInterpretResult(res.data);
          if (!valid && errors.length) {
            // Defensive: still show what we got, but surface the validation issue.
            setError('LogbookAI returned an unexpected response. Please rephrase and try again.');
          }
          setProposal(await prepareProposal(normalized || res.data));
        } else if (mode === 'make_legal_past') setPastResult(res.data);
        else if (mode === 'make_legal_future') setFutureResult(res.data);
        ok = true;
      }
      const used = await getAIUsage(); setUsage(u => ({ ...u, used }));
    } catch (e) {
      setError('LogbookAI is temporarily unavailable. Your request has not been applied.');
    }
    setBusy(false);
    return ok;
  };

  // Shape a proposed event for the canonical writer.
  const shapeEvent = (p, isLast) => ({
    log_date: (p.date || (p.start_timestamp ? p.start_timestamp.slice(0, 10) : dateKeyInTz(new Date(), tz))),
    start_timestamp: p.start_timestamp,
    end_timestamp: p.end_timestamp || (isLast && !p.end_timestamp ? null : p.end_timestamp),
    duty_status: p.duty_status,
    city: p.city || '', state: p.state || '',
    remark: p.remark || p.activity_type || '',
    tractor_number: p.tractor_number || '', trailer_numbers: p.trailer_numbers || '',
    method_of_creation: p.source === 'voice' ? 'Voice AI' : 'Typed AI',
    is_ongoing: isLast && !p.end_timestamp,
  });

  // --- TELL: apply proposed events (canonical batch insert) ---
  const applyProposal = async (proposedEvents, mileageMeta = {}) => {
    if (applyingRef.current) return false;
    if (!proposedEvents?.length) { setProposal(null); reload(); return true; }
    applyingRef.current = true;
    const shaped = proposedEvents.map((p, i) => shapeEvent(p, i === proposedEvents.length - 1));
    try {
      const res = await insertEventsBatch(events, shaped, {
        carrierName: carrier?.carrier_name,
        methodOfCreation: 'Typed AI',
        editedBy: profile?.legal_name,
        reason: 'AI Apply',
      });
      if (res?.error) { setError(res.error); return false; }
      const date = proposedEvents[0]?.start_timestamp ? dateKeyInTz(new Date(proposedEvents[0].start_timestamp), tz) : proposal?.target_date;
      if (date && Number.isFinite(mileageMeta.dailyMileage)) await saveProposalMiles(date, mileageMeta.dailyMileage, mileageMeta.mileageEdited);
      setProposal(null); reload();
      return true;
    } catch (e) { setError(e?.message || 'Failed to apply proposed events.'); return false; }
    finally { applyingRef.current = false; }
  };

  // --- TELL: replace-day (redo an entire day) routes through the canonical
  // replace-range writer — it REPLACES the period, never stacks a second
  // timeline. Requires the driver's explicit Apply (the labeled button). ---
  const applyReplaceDay = async (proposedEvents, mileageMeta = {}) => {
    if (applyingRef.current) return false;
    if (!proposedEvents?.length) { setError('Nothing to replace the day with.'); return false; }
    applyingRef.current = true;
    const { dayStart, dayEnd } = replaceDayRange(proposal?.target_date || proposedEvents[0]?.start_timestamp?.slice(0, 10), tz);
    const shaped = proposedEvents.map((p) => shapeEvent(p, false));
    try {
      await replaceRangeEvents(events, dayStart, dayEnd, shaped, {
        carrierName: carrier?.carrier_name,
        methodOfCreation: 'Typed AI',
        editedBy: profile?.legal_name,
        reason: 'AI Replace Day',
      });
      const date = proposal?.target_date || dateKeyInTz(new Date(proposedEvents[0].start_timestamp), tz);
      if (date && Number.isFinite(mileageMeta.dailyMileage)) await saveProposalMiles(date, mileageMeta.dailyMileage, mileageMeta.mileageEdited);
      setProposal(null); reload();
      return true;
    } catch (e) { setError(e?.message || 'Failed to replace the day.'); return false; }
    finally { applyingRef.current = false; }
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

  // --- HOS CHECK: PAST ---
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
    try {
      await editEvent(events, target.id, {
        duty_status: c.proposed_event.duty_status,
        start_timestamp: c.proposed_event.start_timestamp || target.start_timestamp,
        end_timestamp: c.proposed_event.end_timestamp || target.end_timestamp,
        city: c.proposed_event.city ?? target.city, state: c.proposed_event.state ?? target.state,
        remark: c.proposed_event.remark || target.remark,
        method_of_creation: 'Correction',
      }, { carrierName: carrier?.carrier_name, editedBy: profile?.legal_name, reason: c.description || 'AI correction' });
      setPastResult(p => ({ ...p, factual_corrections: p.factual_corrections.filter((_, i) => i !== idx) }));
      reload();
    } catch (e) { setError(e?.message || 'Failed to apply correction.'); }
  };

  // --- HOS CHECK: FUTURE ---
  // OpenAI parses only origin/destination/requested arrival. OSRM supplies the
  // road route and earliestLegalEta uses the actual deterministic HOS outputs.
  const handleFuture = async (text) => {
    if (!hos.calculable) { setError('Correct the duty timeline before calculating a legal future plan.'); return false; }
    setBusy(true); setError('');
    try {
      const res = await base44.functions.invoke('manualLogAssistant', {
        mode: 'parse_future', input: text, source: 'typed', hosSummary,
      });
      if (res.status === 429 || res.data?.limit) { setError(res.data?.error || 'AI limit reached.'); return false; }
      if (res.data?.unavailable || res.data?.error) { setError(res.data?.error || 'LogbookAI is temporarily unavailable.'); return false; }
      const parsed = res.data;
      if (parsed.refuses_fabrication) {
        setFutureResult({ feasibility: 'not_feasible', plan: [], earliest_eta: null, notes: parsed.notes, refuses_fabrication: true, origin: parsed.origin, destination: parsed.destination });
        return true;
      }
      if (!parsed.origin || !parsed.destination) { setError('Please include an origin and destination.'); return false; }
      const route = await fetchRoute(parsed.origin, parsed.destination);
      const driveHours = truckEtaHours(route, speedProfile);
      if (!route || !Number.isFinite(driveHours)) { setError('Could not calculate the road route. Check the city and state.'); return false; }
      const legal = earliestLegalEta(hos, driveHours * 3600000, new Date());
      if (!legal.eta) { setError(legal.error || 'A legal ETA could not be calculated.'); return false; }
      const requested = parsed.requestedArrival ? new Date(parsed.requestedArrival) : null;
      const feasible = !requested || legal.eta <= requested;
      setFutureResult({
        origin: parsed.origin,
        destination: parsed.destination,
        requested_arrival: parsed.requestedArrival,
        earliest_eta: legal.eta.toISOString(),
        feasibility: feasible ? 'feasible' : 'not_feasible',
        plan: legal.segments.map((s, i) => ({ ...s, sequence: i + 1, city: '', state: '' })),
        notes: `OSRM road route: ${Math.round(route.miles)} mi · truck planning time: ${driveHours.toFixed(1)} hr. ${parsed.notes || ''}`.trim(),
        deterministic_inputs: legal.inputs,
      });
      const used = await getAIUsage(); setUsage(u => ({ ...u, used }));
      return true;
    } catch (e) {
      setError('LogbookAI is temporarily unavailable. Your request has not been applied.');
      return false;
    } finally {
      setBusy(false);
    }
  };

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

  if (loading) return <div className="flex items-center justify-center h-screen"><div className="w-8 h-8 border-4 border-muted border-t-foreground rounded-full animate-spin" /></div>;

  const remaining = usage.allowance - usage.used;
  const showProposal = proposal && !busy;
  const isQuestion = showProposal && isQuestionIntent(proposal.intent);
  const canApply = showProposal && shouldOfferApply(proposal);

  return (
    <div data-client-version="log-assistant-current-2026-08-20-v2" className="px-4 pt-6 pb-6 max-w-2xl mx-auto">
      <Header title="Ask LogbookAI" />
      <p className="text-xs text-muted-foreground mb-3">LogbookAI checks the information you provide against the configured FMCSA HOS rules. LogbookAI is not an ELD. The driver remains responsible for the accuracy, completeness, and certification of the record. {remaining} of {usage.allowance} AI requests remaining this month.</p>

      <div className="grid grid-cols-3 gap-2 mb-3">
        {TABS.map(t => {
          const Icon = t.icon;
          return (
            <button key={t.id} onClick={() => { setTab(t.id); resetResults(); }}
              className={`rounded-xl border p-3 text-xs font-medium flex flex-col items-center gap-1 ${tab === t.id ? 'border-primary bg-accent text-accent-foreground' : 'border-border text-card-foreground'}`}>
              <Icon className="w-5 h-5" /> {t.label}
            </button>
          );
        })}
      </div>

      {error && <div className="rounded-lg border border-warning/50 bg-warning-surface p-2 mb-3 text-xs text-warning-surface-foreground flex gap-1"><AlertTriangle className="w-4 h-4 shrink-0" /> {error}</div>}

      {tab === 'tell' && (
        <>
          {/* Deterministic basic commands bypass the AI quota; complex requests fall back to OpenAI. */}
          <AssistantInput onSend={handleTell} disabled={busy} />
          {busy && <div className="text-sm text-muted-foreground text-center py-4"><Bot className="w-4 h-4 inline animate-pulse mr-1" /> Interpreting…</div>}
          {showProposal && !isQuestion && canApply && (
            <ProposalReview
              key="current-proposal-review-v2"
              existing={events}
              proposed={proposal.proposed_events}
              interpretation={proposal.interpretation}
              clarifications={proposal.clarifications}
              intent={proposal.intent}
              targetDate={proposal.target_date}
              cycleType={cycleType} tz={tz}
              onApply={applyProposal}
              onApplyReplace={applyReplaceDay}
              onCancel={() => setProposal(null)}
              onResolveClarification={resolveClarification}
              routeWarning={routeWarning}
              explicitGuard={proposal.explicit_guard}
              narrative={proposal.original_input}
              provenance={{ summary: proposal.interpretation, location_confirmations: proposal.location_confirmations }}
              enteredPriorHistory={profile?.entered_prior_history}
            />
          )}
          {showProposal && !isQuestion && !canApply && (
            <div className="rounded-xl border border-border bg-card p-3 mb-3">
              {proposal.interpretation && <div className="text-sm text-muted-foreground mb-2">{proposal.interpretation}</div>}
              {proposal.requires_clarification && (
                <div className="rounded-lg border border-warning/50 bg-warning-surface p-2 mb-2 text-xs text-warning-surface-foreground">
                  <span className="font-medium">Please confirm: </span>{proposal.clarification_question}
                </div>
              )}
              {proposal.refuses_fabrication && (
                <div className="rounded-xl border border-error/40 bg-error-surface p-3 text-error-surface-foreground text-sm mb-3">
                  <AlertTriangle className="w-4 h-4 inline mr-1" /> LogbookAI will not fabricate or hide events to make a log appear compliant. Review what actually happened.
                </div>
              )}
              <Button variant="outline" onClick={() => setProposal(null)}>Dismiss</Button>
            </div>
          )}
          {showProposal && isQuestion && (
            <div className="rounded-xl border border-border bg-card p-3 mb-3">
              {proposal.interpretation && <div className="text-sm text-card-foreground mb-3">{proposal.interpretation}</div>}
              <WhatCanIDoPanel info={whatInfo} tz={tz} />
              <Button variant="outline" className="w-full mt-2" onClick={() => setProposal(null)}>Dismiss</Button>
            </div>
          )}
        </>
      )}

      {tab === 'makeLegal' && (
        <>
          <div className="flex flex-col sm:flex-row gap-2 mb-3">
            <Button variant={mlMode === 'past' ? 'default' : 'outline'} size="sm" onClick={() => { setMlMode('past'); setPastResult(null); }}>Past / Current Log</Button>
            <Button variant={mlMode === 'future' ? 'default' : 'outline'} size="sm" onClick={() => { setMlMode('future'); setFutureResult(null); }}>Future Plan</Button>
          </div>
          {mlMode === 'past' ? (
            <>
              <AssistantInput onSend={(text) => callAssistant('make_legal_past', text, {})} disabled={busy || remaining <= 0} />
              {busy && <div className="text-sm text-muted-foreground text-center py-4"><Gavel className="w-4 h-4 inline animate-pulse mr-1" /> Analyzing your log…</div>}
              {!busy && <MakeItLegal mode="past" past={pastResult} hosBeforeAfter={pastHosBeforeAfter} tz={tz} onApplyCorrection={applyCorrection} />}
            </>
          ) : (
            <>
              <AssistantInput onSend={handleFuture} disabled={busy || remaining <= 0} />
              {busy && <div className="text-sm text-muted-foreground text-center py-4"><Gavel className="w-4 h-4 inline animate-pulse mr-1" /> Building a compliant plan…</div>}
              {!busy && <MakeItLegal mode="future" future={futureResult} tz={tz} onSavePlan={savePlan} />}
            </>
          )}
        </>
      )}

      {tab === 'whatCanIDo' && (
        <>
          <div className="text-xs text-muted-foreground mb-2">Answers from your actual records — no AI request used.</div>
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