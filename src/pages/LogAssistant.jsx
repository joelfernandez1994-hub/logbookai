import { useState, useMemo, useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { useDriverData } from '@/hooks/useDriverData';
import { base44 } from '@/api/base44Client';
import { getAppSettings, getAIUsage, getAgriculturalClaims } from '@/lib/driverData';
import { computeHOS, fmtDur, dateKeyInTz } from '@/lib/hosEngine';
import { whatCanIDo, earliestLegalEta } from '@/lib/logAssistant';
import { evaluateAgriculturalClocks, availabilityUndeterminedSummary } from '@/lib/agriculturalClaims';
import { formatLogDate } from '@/lib/timezones';
import { addRouteWarning, enrichProposalMileage, fetchRoute, truckEtaHours, DEFAULT_SPEED_PROFILE } from '@/lib/proposalValidation';
import { reconstructDrivingDurations } from '@/lib/drivingDurationReconstruction';
import { saveProposalMiles } from '@/lib/tripSync';
import { resolvePreferredMph } from '@/lib/mileageSpeed';
import { insertEventsBatch, editEvent, deleteEventById, replaceRangeEvents } from '@/lib/timelineWriter';
import { parseVoiceCommand } from '@/lib/voiceParser';
import { validateInterpretResult, isQuestionIntent, shouldOfferApply, replaceDayRange, resolveEditTargets } from '@/lib/aiLayer';
import { isMultiEventNarrative, referencesHere } from '@/lib/narrativeClassifier';
import { parseStationaryDay, parseLocationReply, mergeLocationReply } from '@/lib/stationaryDayRule';
import { detectFeasibilityQuestion, answerFeasibilityQuestion } from '@/lib/feasibilityQuestion';
import { describeEvent } from '@/lib/eventReference';
import { normalizeCandidateTimeline } from '@/lib/timelineNormalization';
import AssistantInput from '@/components/logAssistant/AssistantInput';
import ProposalReview from '@/components/logAssistant/ProposalReview';
import WhatCanIDoPanel from '@/components/logAssistant/WhatCanIDoPanel';
import MakeItLegal from '@/components/logAssistant/MakeItLegal';
import Header from '@/components/Header';
import { Button } from '@/components/ui/button';
import { useTranslation } from 'react-i18next';
import { Bot, Gavel, HelpCircle, AlertTriangle } from 'lucide-react';

const TABS = [
  { id: 'tell', label: 'Create Log', icon: Bot },
  { id: 'makeLegal', label: 'HOS Check', icon: Gavel },
  { id: 'whatCanIDo', label: 'What Can I Do?', icon: HelpCircle },
];

export default function LogAssistant() {
  const { t } = useTranslation();
  const { profile, carrier, equipment, events, loading, reload } = useDriverData();
  const location = useLocation();
  const initialTab = new URLSearchParams(window.location.search).get('tab') || 'tell';
  // The selected log date, passed explicitly from Logs (?date=YYYY-MM-DD in the
  // URL — survives refresh) or via router state. Never silently guessed: when
  // the assistant is opened directly (no date context) it defaults to today's
  // log and the "Editing log" banner says so plainly.
  const routeDate = new URLSearchParams(window.location.search).get('date') || location.state?.date || '';
  const [logDate, setLogDate] = useState(routeDate);
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
  const [claims, setClaims] = useState([]);
  const [routeWarning, setRouteWarning] = useState(null);
  const [reconstructionConflicts, setReconstructionConflicts] = useState([]);
  // Pending delete-by-reference confirmation ("delete the second fuel stop").
  // { targets: [{id, description}] } when a real event was resolved (from
  // either the deterministic parser or a resolved AI delete_events proposal);
  // { targets: null, question } when it could not be confidently resolved and
  // the driver needs to rephrase — LogbookAI never deletes a guess.
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  // Pending "which state?" clarification from the deterministic stationary
  // full-day rule: { originalText, city }. A purely-location reply is merged
  // back into the original request so the stated city is preserved exactly.
  const [pendingStateAsk, setPendingStateAsk] = useState(null);
  // Pending AI clarification: the request the clarification question belongs
  // to, sent as context with the driver's reply so stated locations carry
  // across replies and are never re-guessed.
  const [pendingAiClarification, setPendingAiClarification] = useState(null);
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
  // No date in the URL/state (opened directly): once the carrier (→ logbook
  // timezone) is loaded, target today's log. Kept in the URL so refresh and
  // back navigation preserve it.
  useEffect(() => { if (!logDate && carrier) setLogDate(dateKeyInTz(new Date(), tz)); }, [carrier, logDate, tz]);
  useEffect(() => {
    if (!logDate) return;
    const p = new URLSearchParams(window.location.search);
    if (p.get('date') !== logDate) { p.set('date', logDate); window.history.replaceState(null, '', `${window.location.pathname}?${p.toString()}`); }
  }, [logDate]);
  useEffect(() => { const t = setTimeout(() => setNow(new Date()), 30000); return () => clearTimeout(t); }, [now]);

  const hos = useMemo(() => computeHOS(events, cycleType, tz, now, { historyComplete: true }), [events, cycleType, tz, now]);
  // Agricultural claims: clocks a claim's history affects are reported as
  // unavailable — both to the driver (What Can I Do?) and to the AI itself
  // (hosSummary carries the same unavailability + an explicit instruction).
  const agEval = useMemo(() => evaluateAgriculturalClocks({ claims, events, hos, cycleType, tz, now }),
    [claims, events, hos, cycleType, tz, now]);
  const hosSummary = useMemo(() => buildHosSummary(hos, agEval), [hos, agEval]);

  useEffect(() => { (async () => { try { setClaims((await getAgriculturalClaims()) || []); } catch (e) {} })(); }, []);

  const whatInfo = useMemo(
    () => whatCanIDo(events, cycleType, tz, now, profile?.entered_prior_history, agEval),
    [events, cycleType, tz, now, profile?.entered_prior_history, agEval]
  );

  const prepareProposal = async (value) => {
    if (!value?.proposed_events?.length) { setRouteWarning(null); setReconstructionConflicts([]); return value; }
    // Normalize the PROPOSED set's own boundaries before anything else runs
    // (mileage/route calculations, and what the driver sees/edits/applies) —
    // closes any non-last event with no end against the next one's start and
    // truncates an inferred/defaulted end that runs past a later boundary.
    // Never moves an explicit fact. A genuine explicit-vs-explicit conflict
    // within the proposed set itself is left exactly as stated here; it is
    // still caught and surfaced by ProposalReview's own validateProposal call
    // (which re-normalizes the full existing+proposed timeline for warnings).
    const { events: selfNormalized } = normalizeCandidateTimeline(value.proposed_events);
    const enriched = await enrichProposalMileage(selfNormalized, { routingProvider: fetchRoute, speedProfile, averageMph: resolvePreferredMph(profile), now: new Date(), narrative: value.original_input || '' });
    // Route-aware reconstruction: replace AI-inferred Driving durations with
    // routed truck-realistic travel time and cascade-shift subsequent inferred
    // events (explicit driver timestamps are never moved). Runs at proposal time
    // only; routed mileage is never reduced to fit an old inferred time. Reuses
    // the routes already fetched by enrichment — no extra routing calls.
    const { events: reconstructed, conflicts: reconstructionConflicts } = reconstructDrivingDurations(enriched.events, enriched.legs, { now: new Date() });
    const firstStart = reconstructed[0]?.start_timestamp;
    const isFuture = firstStart ? new Date(firstStart) > new Date() : false;
    const warning = await addRouteWarning(reconstructed, { routingProvider: fetchRoute, speedProfile, now: new Date(), isFuture });
    setRouteWarning(warning);
    setReconstructionConflicts(reconstructionConflicts);
    // The selected log date is authoritative: an AI proposal without its own
    // explicit target date targets the day being edited, never silently today.
    return { proposal_id: value.proposal_id || newProposalId(), ...value, target_date: value.target_date || logDate, proposed_events: reconstructed };
  };

  const resetResults = () => { setProposal(null); setPastResult(null); setFutureResult(null); setError(''); setRouteWarning(null); setReconstructionConflicts([]); setDeleteConfirm(null); setPendingStateAsk(null); setPendingAiClarification(null); };

  // ---------------------------------------------------------------------------
  // TELL tab: deterministic voice/text command parser runs FIRST (no quota).
  // If it confidently handles the command, we propose deterministically and
  // never call the backend. Otherwise we fall back to the OpenAI-backed function.
  // Returns true on success (so AssistantInput clears the input), false on
  // failure (input is preserved for retry).
  // ---------------------------------------------------------------------------
  // The driver's most recently logged city/state — the natural notion of
  // "current location" for a route-feasibility question, consistent with how
  // Trip Planner infers pickup from the day's first event.
  const lastLoggedLocation = () => {
    const withCity = [...events].filter((e) => e.city && e.start_timestamp)
      .sort((a, b) => new Date(b.start_timestamp) - new Date(a.start_timestamp));
    return withCity[0] ? { city: withCity[0].city, state: withCity[0].state } : null;
  };

  // Emit a deterministic stationary-day proposal (full-day add, "Already
  // logged", or replace-day preview). A "which state?" clarification keeps
  // the driver's stated city so their reply merges back into the original
  // request; other stationary clarifications carry the original request as
  // AI context so their replies are interpreted together with it.
  const emitStationary = (stat, originalText, type) => {
    if (stat.already_logged) {
      setProposal({
        intent: 'question', target_date: stat.target_date, requires_clarification: false, clarification_question: '',
        interpretation: stat.interpretation, summary: stat.interpretation,
        proposed_events: [], clarifications: [], location_confirmations: [],
        refuses_fabrication: false, _deterministic: true, _stationary: true,
      });
      return true;
    }
    const statEvents = (stat.proposed_events || []).map((e) => ({
      ...e,
      source: type === 'voice' ? 'voice' : 'manual',
      confidence: 'high',
      ambiguous_fields: [],
    }));
    setRouteWarning(null);
    setReconstructionConflicts([]);
    setProposal({
      intent: stat.intent,
      target_date: stat.target_date,
      requires_clarification: !!stat.requires_clarification,
      clarification_question: stat.clarification_question || '',
      interpretation: stat.interpretation,
      proposed_events: statEvents,
      clarifications: [],
      refuses_fabrication: false,
      original_input: originalText,
      location_confirmations: [],
      replaces_existing: stat.replaces_existing || [],
      _deterministic: true,
      _stationary: true,
      proposal_id: newProposalId(),
    });
    if (stat.requires_clarification) {
      if (stat.pending_location_city) setPendingStateAsk({ originalText, city: stat.pending_location_city });
      else setPendingAiClarification({ originalInput: originalText, question: stat.clarification_question || '' });
    }
    return true;
  };

  const handleTell = async (text, type) => {
    setError('');

    // 1a. PENDING "WHICH STATE?" CLARIFICATION — a purely-location reply
    //     ("IL", "Illinois", "in Miami, FL") is merged back into the ORIGINAL
    //     full-day request and re-parsed, so the stated city is preserved
    //     exactly and never substituted. Any other reply falls through and
    //     is treated as a fresh request.
    if (pendingStateAsk) {
      const reply = parseLocationReply(text);
      if (reply) {
        const merged = mergeLocationReply(pendingStateAsk.originalText, reply);
        const stat = parseStationaryDay(merged, { now: new Date(), timezone: tz, selectedDate: logDate, existingEvents: events, lang: profile?.language === 'es' ? 'es' : 'en' });
        if (stat?.matched) { setPendingStateAsk(null); return emitStationary(stat, merged, type); }
      }
      setPendingStateAsk(null);
    }

    // 1. DETERMINISTIC ROUTE-FEASIBILITY ANSWER ("Can I make it to Atlanta
    //    tonight?") — real road mileage (fetchRoute) + the driver's ACTUAL
    //    current HOS (earliestLegalEta, the same simulator the Future Plan
    //    tab uses). Zero AI cost, never touches the log. Falls through to
    //    Ask LogbookAI when it can't confidently answer (unknown current
    //    location, unresolvable destination, no road route).
    // Agricultural claims: availability is undetermined — never a numeric
    // yes/no feasibility answer while the 14-hour transition is unresolved.
    if (agEval && agEval.anyUnavailable && detectFeasibilityQuestion(text)) {
      setProposal({
        intent: 'question', target_date: '', requires_clarification: false, clarification_question: '',
        interpretation: availabilityUndeterminedSummary(agEval), summary: availabilityUndeterminedSummary(agEval),
        proposed_events: [], clarifications: [], location_confirmations: [],
        refuses_fabrication: false, _deterministic: true,
      });
      return true;
    }
    if (detectFeasibilityQuestion(text)) {
      const feasibility = await answerFeasibilityQuestion(text, {
        currentLocation: lastLoggedLocation(),
        hos, now: new Date(),
        fetchRouteFn: fetchRoute,
        truckEtaHoursFn: (route) => truckEtaHours(route, speedProfile),
        earliestLegalEtaFn: earliestLegalEta,
        isSpanish: /\b(puedo|podr[eé])\b/i.test(text),
      });
      if (feasibility.handled) {
        setProposal({
          intent: 'question', target_date: '', requires_clarification: false, clarification_question: '',
          interpretation: feasibility.answer, summary: feasibility.answer,
          proposed_events: [], clarifications: [], location_confirmations: [],
          refuses_fabrication: false, _deterministic: true,
        });
        return true;
      }
      // Not confidently answerable deterministically — fall through to AI.
    }

    // 1b. DETERMINISTIC STATIONARY FULL-DAY / ALL-NIGHT STATUS — single
    //     stationary intent (e.g. "off duty all day in X", "sleeper all day in
    //     X", "off duty all night in X"). The stated location is a STATIONARY
    //     EVENT location, never a travel destination, so it can never trigger
    //     the DESCRIBED_DRIVING_MISSING false positive the movement guard's
    //     provenance backstop produced. Zero AI cost, zero routing. A genuine
    //     travel narrative (drove/headed/left/...) is rejected inside the rule
    //     and falls through to the normal AI + movement validation below.
    //     Runs before the multi-event classifier so a full-day stationary
    //     status is never sent to the LLM.
    const stat = parseStationaryDay(text, { now: new Date(), timezone: tz, selectedDate: logDate, existingEvents: events, lang: profile?.language === 'es' ? 'es' : 'en' });
    if (stat?.matched) return emitStationary(stat, text, type);

    // AI-first routing: any narrative describing more than one event/activity
    // goes straight to manualLogAssistant. The deterministic parser is kept
    // only for trivial single-intent commands ("off duty now", "sleeper at 10 PM")
    // and edit-by-reference corrections ("change my last fuel stop to 8:15").
    if (isMultiEventNarrative(text)) {
      const aiCtx = pendingAiClarification;
      setPendingAiClarification(null);
      return callAssistant('interpret', text, { source: type, clarificationOf: aiCtx });
    }
    // Pass the driver's actual logged events so ambiguous-hour resolution
    // can prefer continuity with a neighboring real event (tier 3 of the
    // AM/PM disambiguation) when narrative chronology alone isn't decisive,
    // and so edit-by-reference/delete commands can resolve a REAL target.
    const det = parseVoiceCommand(text, { now: new Date(), timezone: tz, events, selectedDate: logDate });

    // 2. DELETE-BY-REFERENCE ("delete the second fuel stop") — resolved
    //    against a real logged event; never silently guessed.
    if (det.handled && det.deleteEvent) {
      if (det.target?.id) {
        setDeleteConfirm({ targets: [{ id: det.target.id, description: det.target.description }] });
      } else {
        setDeleteConfirm({ targets: null, question: det.clarifications?.[0]?.question || 'Which event did you mean? Please describe it more specifically.' });
      }
      return true;
    }

    if (det.handled) {
      const detEvents = (det.events || []).map((e) => ({
        ...e,
        // Calendar date in the LOG timezone — never a raw UTC slice, which
        // would shift an evening event onto the wrong day.
        date: e.start_timestamp ? dateKeyInTz(new Date(e.start_timestamp), tz) : '',
        source: type === 'voice' ? 'voice' : 'manual',
        confidence: 'high',
        ambiguous_fields: [e._ambiguous?.time && 'start_timestamp', e._ambiguous?.location && 'state', e._ambiguous?.duty_status && 'duty_status'].filter(Boolean),
      }));
      // "here" can never be resolved in this flow (no confirmed current
      // location) — ask instead of leaving a silent blank location.
      const hereClarifications = referencesHere(text) && !detEvents.some((e) => e.city)
        ? [{ type: 'location_here', question: 'Where is "here"? Enter the city and state for this event in Edit Proposal before applying — LogbookAI will not guess your location.' }]
        : [];
      const detClarifications = [...(det.clarifications || []), ...hereClarifications];
      if (detClarifications.length > 0) {
        setPendingAiClarification({ originalInput: text, question: detClarifications[0]?.question || '' });
      }
      const prepared = await prepareProposal({
        intent: det.edit ? 'edit_events' : 'add_events',
        target_date: detEvents[0]?.date || logDate,
        requires_clarification: detClarifications.length > 0,
        clarification_question: detClarifications[0]?.question || '',
        interpretation: det.correction ? 'I understood this as a correction to an existing event:' : 'I understood:',
        proposed_events: detEvents,
        clarifications: detClarifications,
        refuses_fabrication: false,
        _deterministic: true,
      });
      setProposal(prepared);
      return true;
    }
    const aiCtx = pendingAiClarification;
    setPendingAiClarification(null);
    return callAssistant('interpret', text, { source: type, clarificationOf: aiCtx });
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
        selected_date: logDate || '',
        events: events.map(simplifyEvent),
        documents: extra.documents || [],
        clarification_of: extra.clarificationOf || null,
        currentLocation: extra.currentLocation || '',
        tractor: equipment?.[0]?.unit_number || '',
        trailer: equipment?.find(e => e.type === 'trailer')?.unit_number || '',
        hosSummary,
        origin: extra.origin, destination: extra.destination, requestedArrival: extra.requestedArrival,
      });
      if (res.status === 429 || res.data?.limit) setError(res.data?.error || 'AI limit reached.');
      else if (res.data?.disabled) setError(res.data?.error || 'AI disabled.');
      else if (res.data?.configuration_required) setError(res.data?.error || 'Carrier home-terminal timezone not configured — set it before generating a proposal.');
      else if (res.data?.unavailable) setError(res.data?.error || 'LogbookAI is temporarily unavailable. Your request has not been applied.');
      else if (res.data?.error) setError(res.data.error);
      else {
        if (mode === 'interpret') {
          const { valid, errors, normalized } = validateInterpretResult(res.data);
          if (!valid && errors.length) {
            // Defensive: still show what we got, but surface the validation issue.
            setError('LogbookAI returned an unexpected response. Please rephrase and try again.');
          }
          let toShow = normalized || res.data;
          // edit_events/delete_events proposals only ever point at an INDEX
          // into the events array we sent — resolve it back to a real event
          // id here. An unresolved target is NEVER silently turned into a
          // new inserted event (that would duplicate/overlap the timeline);
          // it becomes a clarification instead.
          let deleteResolved = null;
          if (toShow?.intent === 'delete_events') {
            const { resolvedDeletes, unresolvedDeletes } = resolveEditTargets(events, toShow);
            if (resolvedDeletes.length && !unresolvedDeletes.length) {
              deleteResolved = resolvedDeletes.map(r => ({ id: r.event.id, description: describeEvent(r.event, tz) }));
            } else {
              toShow = {
                ...toShow, intent: 'clarification', proposed_events: [], requires_clarification: true,
                clarification_question: toShow.clarification_question || 'Which event did you mean? Please describe it more specifically (e.g. the approximate time or activity).',
              };
            }
          } else if (toShow?.intent === 'edit_events') {
            const { resolvedEdits, unresolvedEdits } = resolveEditTargets(events, toShow);
            if (resolvedEdits.length && !unresolvedEdits.length) {
              toShow = { ...toShow, proposed_events: resolvedEdits.map(r => ({ ...r.proposed, target_event_id: r.target.id })) };
            } else {
              toShow = {
                ...toShow, proposed_events: [], requires_clarification: true,
                clarification_question: toShow.clarification_question || 'Which event did you mean? Please describe it more specifically (e.g. the approximate time or activity).',
              };
            }
          }
          // A clarification reply keeps the earlier request as context so any
          // stated location carries across replies instead of being re-guessed.
          if (toShow?.requires_clarification) {
            setPendingAiClarification({ originalInput: toShow.original_input || input, question: toShow.clarification_question || '' });
          }
          if (deleteResolved) setDeleteConfirm({ targets: deleteResolved });
          else setProposal(await prepareProposal(toShow));
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

  // Shape a proposed event for the canonical writer. field_provenance is
  // carried through so AI-inferred timestamps persist on the saved record —
  // the route-aware reconstruction engine ("Fix route timing") can then move
  // only inferred times and never touch explicit driver times.
  // Per-proposal identifier (idempotency key): every proposal — AI-backed,
  // deterministic parser, or stationary-day — gets one id; saved events carry
  // it so re-applying the same proposal can never duplicate them.
  const newProposalId = () => (typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `prop_${Date.now()}_${Math.random().toString(36).slice(2)}`);

  const shapeEvent = (p, isLast) => ({
    // log_date is always the calendar date of the event's own start in the LOG
    // timezone (never a raw UTC slice — that shifts evening events), falling
    // back to the selected log date, never silently to today.
    log_date: (p.date || (p.start_timestamp ? dateKeyInTz(new Date(p.start_timestamp), tz) : (logDate || dateKeyInTz(new Date(), tz)))),
    start_timestamp: p.start_timestamp,
    end_timestamp: p.end_timestamp || (isLast && !p.end_timestamp ? null : p.end_timestamp),
    duty_status: p.duty_status,
    city: p.city || '', state: p.state || '',
    remark: p.remark || p.activity_type || '',
    tractor_number: p.tractor_number || '', trailer_numbers: p.trailer_numbers || '',
    method_of_creation: p.source === 'voice' ? 'Voice AI' : 'Typed AI',
    is_ongoing: isLast && !p.end_timestamp,
    ...(p.field_provenance ? { field_provenance: p.field_provenance } : {}),
    ...(p.proposal_id ? { proposal_id: p.proposal_id } : {}),
    ...(Array.isArray(p.review_notes) && p.review_notes.length ? { review_notes: p.review_notes } : {}),
  });

  // --- TELL: apply proposed events. A proposed event carrying
  // target_event_id is a CORRECTION to a real existing event (resolved by
  // eventReference.js or the AI's edit_target_index) — it is routed through
  // the canonical editEvent() writer so it replaces that record in place
  // rather than being inserted as a new, duplicate/overlapping event. Only
  // events WITHOUT a target are genuinely new activity and go through the
  // batch inserter. ---
  const applyProposal = async (proposedEvents, mileageMeta = {}) => {
    if (applyingRef.current) return false;
    if (!proposedEvents?.length) { setProposal(null); reload(); return true; }
    applyingRef.current = true;
    try {
      const edits = proposedEvents.filter((p) => p.target_event_id);
      const inserts = proposedEvents.filter((p) => !p.target_event_id);
      for (const p of edits) {
        // Preserve ongoing-ness: a correction may target the current open
        // event (e.g. "I actually started driving at 7" fixing the still-
        // running Driving segment) — isLast is derived from whether the
        // event itself still has no end_timestamp, not assumed false.
        const res = await editEvent(events, p.target_event_id, shapeEvent(p, !p.end_timestamp), {
          carrierName: carrier?.carrier_name,
          methodOfCreation: 'Typed AI',
          editedBy: profile?.legal_name,
          reason: 'AI Correction',
        });
        if (res?.error) { setError(res.error); return false; }
      }
      if (inserts.length) {
        // Proposal-identifier idempotency: if this exact proposal was already
        // saved (e.g. a retry after a lost connection), skip inserts entirely —
        // never create duplicates. The writer's (start, status) dedupe remains
        // as a second layer for a re-submitted-but-new proposal.
        const pid = proposal?.proposal_id || inserts[0]?.proposal_id;
        if (pid) {
          try {
            const already = await base44.entities.DutyStatusEvent.filter({ proposal_id: pid }, { limit: 1 });
            if ((already?.items || []).length) { setProposal(null); reload(); return true; }
          } catch (e) { /* best-effort — fall through to the normal insert path */ }
        }
        const shaped = inserts.map((p, i) => shapeEvent(pid ? { ...p, proposal_id: pid } : p, i === inserts.length - 1));
        const res = await insertEventsBatch(events, shaped, {
          carrierName: carrier?.carrier_name,
          methodOfCreation: 'Typed AI',
          editedBy: profile?.legal_name,
          reason: 'AI Apply',
        });
        if (res?.error) { setError(res.error); return false; }
      }
      const date = proposedEvents[0]?.start_timestamp ? dateKeyInTz(new Date(proposedEvents[0].start_timestamp), tz) : proposal?.target_date;
      if (date && Number.isFinite(mileageMeta.dailyMileage)) await saveProposalMiles(date, mileageMeta.dailyMileage, mileageMeta.mileageEdited);
      setProposal(null); reload();
      return true;
    } catch (e) { setError(e?.message || 'Failed to apply proposed events.'); return false; }
    finally { applyingRef.current = false; }
  };

  // --- TELL: delete-by-reference confirmation ("delete the second fuel stop").
  // Routes through the canonical deleteEventById writer — same writer manual
  // Logs deletion would use. Only ever called with a real, resolved event id.
  const applyDeleteConfirmed = async () => {
    if (applyingRef.current || !deleteConfirm?.targets?.length) return;
    applyingRef.current = true;
    try {
      for (const t of deleteConfirm.targets) {
        const res = await deleteEventById(events, t.id, {
          carrierName: carrier?.carrier_name,
          methodOfCreation: 'Typed AI',
          editedBy: profile?.legal_name,
          reason: 'AI Delete',
        });
        if (res?.error) { setError(res.error); return; }
      }
      setDeleteConfirm(null); reload();
    } catch (e) { setError(e?.message || 'Failed to delete the event.'); }
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
        field_provenance: { start_time: 'explicit', end_time: 'explicit' },
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
    if (agEval && agEval.anyUnavailable) { setError(availabilityUndeterminedSummary(agEval)); return false; }
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
      <Header title="Log with AI" />
      {logDate && (
        <div data-testid="editing-log-date" className="rounded-lg border border-primary/40 bg-accent px-3 py-2 mb-3 text-sm font-semibold text-accent-foreground">
          {t('logs.editingLog', { date: formatLogDate(logDate) })}
        </div>
      )}
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
          {deleteConfirm && (
            <div className="rounded-xl border border-error/40 bg-error-surface p-3 mb-3">
              {deleteConfirm.targets ? (
                <>
                  <div className="text-sm font-semibold text-error-surface-foreground mb-2">
                    Delete {deleteConfirm.targets.length === 1 ? 'this event' : `these ${deleteConfirm.targets.length} events`}? This cannot be undone.
                  </div>
                  <ul className="text-xs text-error-surface-foreground mb-3 list-disc ml-4">
                    {deleteConfirm.targets.map((t, i) => <li key={i}>{t.description}</li>)}
                  </ul>
                  <div className="flex gap-2">
                    <Button className="bg-error hover:bg-error/90 text-white" onClick={applyDeleteConfirmed} disabled={busy}>Delete</Button>
                    <Button variant="outline" onClick={() => setDeleteConfirm(null)}>Cancel</Button>
                  </div>
                </>
              ) : (
                <>
                  <div className="text-xs text-error-surface-foreground mb-2">{deleteConfirm.question}</div>
                  <Button variant="outline" onClick={() => setDeleteConfirm(null)}>Dismiss</Button>
                </>
              )}
            </div>
          )}
          {showProposal && !isQuestion && canApply && (
            <ProposalReview
              key="current-proposal-review-v2"
              existing={events}
              proposed={proposal.proposed_events}
              interpretation={proposal.interpretation}
              clarifications={proposal.clarifications}
              intent={proposal.intent}
              targetDate={proposal.target_date}
              selectedDate={logDate}
              replacesExisting={proposal.replaces_existing}
              cycleType={cycleType} tz={tz}
              onApply={applyProposal}
              onApplyReplace={applyReplaceDay}
              onCancel={() => setProposal(null)}
              onResolveClarification={resolveClarification}
              routeWarning={routeWarning}
              reconstructionConflicts={reconstructionConflicts}
              explicitGuard={proposal.explicit_guard}
              narrative={proposal.original_input}
              provenance={{ summary: proposal.interpretation, location_confirmations: proposal.location_confirmations }}
              enteredPriorHistory={profile?.entered_prior_history}
            />
          )}
          {showProposal && !isQuestion && !canApply && (
            <div className="rounded-xl border border-border bg-card p-3 mb-3">
              {proposal.interpretation && <div className="text-sm text-muted-foreground mb-2">{proposal.interpretation}</div>}
              {/* Partial proposal while a clarification is pending: events whose
                  details ARE clear are shown read-only (not applied until the
                  driver confirms what the clarification asks). */}
              {proposal.proposed_events?.length > 0 && (
                <ul className="text-xs text-card-foreground mb-2 space-y-1" data-testid="partial-proposal-events">
                  {proposal.proposed_events.map((e, i) => (
                    <li key={i} data-testid="partial-proposal-event">
                      {e.duty_status}{e.start_time_local || e.start_timestamp ? ` · ${(e.start_time_local || e.start_timestamp).slice(11, 16)}` : ''}
                      {e.city ? ` — ${[e.city, e.state].filter(Boolean).join(', ')}` : ''}
                    </li>
                  ))}
                </ul>
              )}
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
              {proposal.explicit_guard?.blocking && (
                <div className="rounded-xl border border-error/40 bg-error-surface p-3 text-error-surface-foreground text-sm mb-3">
                  <div className="font-semibold flex items-center gap-1 mb-1"><AlertTriangle className="w-4 h-4" /> Could not safely build a proposal</div>
                  <div>
                    {[...(proposal.explicit_guard.alteredExplicitFacts || []), ...(proposal.explicit_guard.droppedExplicitEvents || [])]
                      .map(issue => `${issue.reason || `${issue.field || issue.type}: review required`}${issue.value ? ` ("${issue.value}")` : ''}`).join(' ')}
                  </div>
                  <div className="text-[11px] mt-1 opacity-80">Try rephrasing with a bit more detail, or describe the day in smaller pieces.</div>
                </div>
              )}
              {!proposal.requires_clarification && !proposal.refuses_fabrication && !proposal.explicit_guard?.blocking && (
                <div className="rounded-xl border border-warning/50 bg-warning-surface p-3 text-warning-surface-foreground text-sm mb-3">
                  <AlertTriangle className="w-4 h-4 inline mr-1" /> LogbookAI understood your message but did not produce any proposed events to review. Try rephrasing or adding more detail.
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

function buildHosSummary(hos, agEval = null) {
  const c = (agEval && agEval.clocks) || {};
  const agLine = (key, fallback) => (c[key] && c[key].unavailable
    ? 'unavailable — a driver-claimed agricultural interval affects this clock; agricultural HOS calculations are disabled pending resolution of the 14-hour transition rules'
    : fallback);
  return [
    `Driving remaining: ${hos.driving.applicable ? fmtDur(hos.driving.drivingRemainingMs) : agLine('driving', 'unavailable — no verified reset in the contiguous timeline')}`,
    `14-hour window remaining: ${hos.window14.applicable ? fmtDur(hos.window14.remainingMs) : agLine('window14', 'unavailable — no verified reset in the contiguous timeline')}`,
    `30-min break: ${c.break30 && c.break30.unavailable ? 'unavailable — a driver-claimed agricultural interval affects this clock' : (hos.break30.satisfied ? 'satisfied' : (hos.break30.breakRequired ? 'required' : 'not yet required'))}`,
    `Cycle ${hos.cycle.cycleLimit}/${hos.cycle.cycleDays} remaining: ${c.cycle && c.cycle.unavailable ? 'unavailable — a driver-claimed agricultural interval affects the cycle window' : `${hos.cycle.cycleRemainingHours.toFixed(1)} hr`}`,
    `Split sleeper: ${c.split && c.split.unavailable ? 'unavailable (agricultural claim overlaps rest history)' : hos.split.status}`,
    `34h restart: ${c.restart && c.restart.unavailable ? 'unavailable (agricultural claim overlaps rest history)' : (hos.restart.inProgress ? 'in progress' : (hos.restart.completed ? 'completed' : 'none'))}`,
    agEval && agEval.anyUnavailable
      ? 'AGRICULTURAL NOTICE: Availability is UNDETERMINED while a driver-claimed agricultural interval affects the clock history. If asked whether the driver can drive, answer that availability is UNDETERMINED — never a yes/no answer and never a numeric remaining-hours value for the affected clocks.'
      : '',
  ].filter(Boolean).join('\n');
}