import { useMemo, useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { statedMileageWarnings } from '@/lib/statedMileage';
import { validateProposal, hasBlocking, recommendBreakInsertion, buildPreTripEvent, computeProposalTotals, deriveHosDisplay, inspectProposalRoutes, addRouteWarning } from '@/lib/proposalValidation';
import { reconstructDrivingDurations } from '@/lib/drivingDurationReconstruction';
import { existingOutsideReplacedDay } from '@/lib/aiLayer';
import { highestSeverity, fmtClockShort } from '@/lib/logAssistant';
import { dateKeyInTz } from '@/lib/hosEngine';
import { formatLogDate } from '@/lib/timezones';
import LogGraph from '@/components/LogGraph';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Check, X, Pencil, AlertTriangle, ShieldCheck, AlertCircle, Plus, Wrench } from 'lucide-react';
import PreTripDialog from '@/components/PreTripDialog';
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogCancel, AlertDialogAction } from '@/components/ui/alert-dialog';
import TimezoneIndicator from '@/components/TimezoneIndicator';

const STATUS_LABELS = { OFF_DUTY: 'Off Duty', SLEEPER_BERTH: 'Sleeper', DRIVING: 'Driving', ON_DUTY: 'On Duty' };
const STATUSES = ['OFF_DUTY', 'SLEEPER_BERTH', 'DRIVING', 'ON_DUTY'];

// "2 hr 30 min" / "3 hr" (omits "0 min") — matches the route-conflict card copy.
function fmtHoursMinutes(hours) {
  if (hours == null || !Number.isFinite(hours)) return '--';
  const totalMin = Math.round(hours * 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} hr` : `${h} hr ${m} min`;
}

export default function ProposalReview({ existing, proposed, cycleType, tz, onApply, onApplyReplace, onCancel, interpretation, clarifications, onResolveClarification, routeWarning, reconstructionConflicts = [], intent, targetDate, selectedDate, replacesExisting, explicitGuard, narrative, provenance, enteredPriorHistory }) {
  const { t } = useTranslation();
  const isReplaceDay = intent === 'replace_day';
  // A replace_day proposal reconstructs the WHOLE target day from the
  // driver's narrative alone — the day's own pre-existing records (including
  // a live/current-status row Today's quick-status selector created, even
  // still open/ongoing) are being superseded, not merged in as external
  // facts to validate against. See existingOutsideReplacedDay's own header
  // for the full rule. Any OTHER intent keeps full existing/live-status
  // context, unchanged.
  const validationExisting = useMemo(() => {
    if (!isReplaceDay || !targetDate) return existing;
    return existingOutsideReplacedDay(existing, targetDate, tz);
  }, [existing, isReplaceDay, targetDate, tz]);
  const [editable, setEditable] = useState(false);
  const [events, setEvents] = useState(proposed);
  const [mileageEdited, setMileageEdited] = useState(false);
  const [pretripOpen, setPretripOpen] = useState(false);
  const [applying, setApplying] = useState(false);
  // "Fix route timing" overrides: once the driver fixes inferred route times, a
  // fresh route warning (re-evaluated on the corrected events) replaces the
  // parent-supplied one, and any reconstruction gap conflict surfaces here as a
  // manual-review message instead of forcing a shift.
  const [fixedRouteWarning, setFixedRouteWarning] = useState(null);
  const [manualReview, setManualReview] = useState(null);
  const [fixing, setFixing] = useState(false);
  // Explicit-time route-timing conflicts never hard-block (route physics is a
  // plausibility check, not the authoritative record) — they require this
  // acknowledgment instead. Reset whenever the proposal changes so a fresh
  // proposal (or a re-fetched one) always needs a fresh confirmation.
  const [routeAcknowledged, setRouteAcknowledged] = useState(false);
  // "Save Anyway" confirmation: when only non-blocking review warnings remain,
  // Apply first opens an explicit confirmation listing them — the driver can
  // save a valid proposal despite an open timeline gap or compliance notice.
  const [saveAnywayOpen, setSaveAnywayOpen] = useState(false);
  useEffect(() => { setEvents(proposed); setMileageEdited(false); setFixedRouteWarning(null); setManualReview(null); setRouteAcknowledged(false); setSaveAnywayOpen(false); }, [proposed]);

  const evalNow = useMemo(() => {
    let t = new Date();
    for (const p of events) if (p.end_timestamp) t = new Date(p.end_timestamp) > t ? new Date(p.end_timestamp) : t;
    return t;
  }, [events]);

  // MANDATORY validation pipeline (deterministic). routeWarning supplied async by parent.
  const validation = useMemo(
    () => validateProposal(validationExisting, events, { cycleType, tz, now: evalNow, explicitGuard, narrative, provenance, enteredPriorHistory }),
    [validationExisting, events, cycleType, tz, evalNow, explicitGuard, narrative, provenance, enteredPriorHistory]
  );
  // Effective route warning: a locally recomputed one (after Fix route timing)
  // takes precedence over the parent-supplied prop, so the card never shows a
  // stale conflict after the fix.
  const effectiveRouteWarning = fixedRouteWarning !== null ? fixedRouteWarning : routeWarning;
  const canFixRouteTiming = !!(effectiveRouteWarning?.legs?.some(
    (leg) => leg?.evaluation?.conflict && leg?.event?.field_provenance?.end_time === 'inferred'
  ));

  const fixRouteTiming = async () => {
    if (fixing) return;
    setFixing(true);
    setManualReview(null);
    try {
      // Re-route on the current events (cached) so leg eventIndex stays aligned,
      // then reconstruct inferred Driving durations and cascade-shift inferred
      // events up to the first explicit anchor. Explicit times never move.
      const legs = await inspectProposalRoutes(events, { now: evalNow });
      const { events: corrected, conflicts } = reconstructDrivingDurations(events, legs, { now: evalNow });
      const gaps = (conflicts || []).filter((c) => c.type === 'route_time_gap');
      if (gaps.length) { setManualReview(gaps); return; }
      setEvents(corrected);
      setRouteAcknowledged(false);
      // Re-evaluate the route warning on the corrected events (cached routes) so
      // the card reflects the resolved — or still-open — conflict accurately.
      const freshLegs = await inspectProposalRoutes(corrected, { now: evalNow });
      const freshWarning = await addRouteWarning(corrected, { legs: freshLegs, now: evalNow, isFuture });
      setFixedRouteWarning(freshWarning);
    } catch (e) {
      setManualReview([{ type: 'route_time_gap', message: 'Could not reconstruct route timing. Review the times manually.' }]);
    } finally {
      setFixing(false);
    }
  };

  const warnings = useMemo(() => {
    const ws = [...validation.warnings];
    // A successful (conflict-free) route validation is INFORMATIONAL: it renders
    // on its own green card below and never counts as a review warning — it
    // must not turn the proposal amber or persist as a saved review note.
    if (effectiveRouteWarning && effectiveRouteWarning.severity !== 'success') ws.push(effectiveRouteWarning);
    // Driver-stated mileage vs the routed distance: review-only, never blocks
    // and never rewrites the driver's figure.
    if (effectiveRouteWarning?.legs) ws.push(...statedMileageWarnings(effectiveRouteWarning.legs, narrative));
    if (reconstructionConflicts.length && fixedRouteWarning === null) ws.push(...reconstructionConflicts);
    return ws;
  }, [validation.warnings, effectiveRouteWarning, reconstructionConflicts, fixedRouteWarning, narrative]);

  // Route-timing conflicts on FULLY EXPLICIT (driver-stated) times are never a
  // hard blocker — route physics is a plausibility check, not the log itself.
  // They still gate Apply, but through an explicit acknowledgment rather than
  // an unconditional lock (see the dedicated card below).
  const explicitConflictLegs = effectiveRouteWarning?.explicitConflictLegs || [];
  const needsRouteAck = explicitConflictLegs.length > 0;
  const blocking = hasBlocking(warnings) || (needsRouteAck && !routeAcknowledged);
  // The generic warning list below already covers the route_reasonableness
  // entry when it has real BLOCKING (inferred-time) conflicts; a PURE explicit-
  // only conflict gets its own clearer, per-leg card instead of the generic
  // aggregated one, so it isn't shown twice.
  const displayWarnings = warnings.filter(w => !(w.type === 'route_reasonableness' && w.requiresAcknowledgment && !w.blockingConflicts?.length));
  const violations = validation.violations;
  const hos = validation.hos;
  const isFuture = validation.isFuture;

  const severity = blocking ? 'red' : (warnings.length > 0 ? 'amber' : (violations.length > 0 ? highestSeverity(violations) : 'green'));
  const sevStyle = severity === 'green' ? 'border-success/40 bg-success-surface text-success-surface-foreground'
    : severity === 'amber' ? 'border-warning/50 bg-warning-surface text-warning-surface-foreground'
      : 'border-error/40 bg-error-surface text-error-surface-foreground';
  const SevIcon = severity === 'green' ? ShieldCheck : severity === 'amber' ? AlertCircle : AlertTriangle;

  const proposedDate = events[0]?.start_timestamp ? dateKeyInTz(new Date(events[0].start_timestamp), tz) : dateKeyInTz(new Date(), tz);
  const proposalTotals = useMemo(() => computeProposalTotals(events, proposedDate, tz, evalNow), [events, proposedDate, tz, evalNow]);
  const dailyMileage = useMemo(() => events.reduce((sum, event) => sum + (event.duty_status === 'DRIVING' && event.mileage != null && Number.isFinite(Number(event.mileage)) ? Number(event.mileage) : 0), 0), [events]);
  const hasEstimatedMileage = events.some(event => event.duty_status === 'DRIVING' && event.mileage_source === 'estimate');
  // An ongoing or destinationless Driving event never gets fabricated mileage
  // (see proposalValidation.enrichProposalMileage's canEstimateMileage) — it
  // stays mileage:null / mileage_source:'unknown' until a real destination,
  // odometer reading, or driver entry exists. Surfaced distinctly so the
  // total's footer never implies a real number is quietly missing.
  const hasUnknownMileage = events.some(event => event.duty_status === 'DRIVING' && event.mileage == null);
  // A stationary full-day/night proposal has no Driving at all — its 0 mi total
  // is the actual posted value, not a route calculation. Labeled distinctly so
  // the footer never implies a real route was (or should be) computed.
  const isStationary = events.some(event => event.stationary) && !events.some(event => event.duty_status === 'DRIVING');

  // A driver typing a city/state in Edit Proposal is the authoritative source
  // of that location — flag it so the ambiguous-city guard (which blocks a
  // model-chosen state) accepts the driver's own choice.
  // Driver edits are the authoritative source: a location edit marks the
  // location driver-confirmed (ambiguous-city guard), a status edit marks the
  // status driver-confirmed, and a timestamp edit marks the times
  // driver-confirmed — each clears the matching fabricated-start / unrequested
  // event guard for that event.
  const updateField = (i, field, val) => setEvents(prev => prev.map((e, idx) => idx === i
    ? { ...e, [field]: val,
        ...((field === 'city' || field === 'state') ? { driver_confirmed_location: true } : {}),
        ...(field === 'duty_status' ? { driver_confirmed_status: true } : {}) }
    : e));
  const updateMileage = (i, val) => {
    const mileage = val === '' ? '' : Math.max(0, Number(val));
    setMileageEdited(true);
    setEvents(prev => prev.map((event, idx) => idx === i ? { ...event, mileage, mileage_source: 'manual' } : event));
  };
  const updateTs = (i, field, localVal) => setEvents(prev => prev.map((e, idx) => idx === i
    ? { ...e, [field]: localVal ? new Date(localVal).toISOString() : null, driver_confirmed_times: true }
    : e));

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

  // Unresolved (non-blocking) review warnings persist on every saved event so
  // they stay visible on the log after Apply — on the log day and beside the
  // affected entries — until the driver corrects them. Blocking issues never
  // reach this list (they lock Apply instead).
  const unresolvedWarnings = useMemo(() => warnings
    .filter(w => w.severity !== 'blocking')
    .map(w => ({ title: w.title, message: String(w.message || '').slice(0, 240) })), [warnings]);

  // Confirm & Apply: lock immediately, ignore re-entrant taps, keep the
  // proposal visible in a disabled/loading state, and only clear it after
  // successful persistence. On failure the parent returns false and we
  // restore the enabled state so the driver can retry.
  const handleApply = async () => {
    if (applying || blocking) return;
    setApplying(true);
    try {
      // Keep the flagged discrepancy + the driver's acknowledgment on the
      // record itself — the log should make it clear LogbookAI flagged this
      // and the driver confirmed the stated times, not silently drop the flag.
      const eventsToApply = needsRouteAck && routeAcknowledged
        ? events.map((e) => {
            // Match by content (start time + status), not array index — the
            // route warning's legs were computed against the proposal as first
            // generated, and `events` may have since been reordered (e.g. a
            // pre-trip prepended via "Add Pre-Trip").
            const leg = explicitConflictLegs.find(l =>
              l.event?.start_timestamp === e.start_timestamp && l.event?.duty_status === e.duty_status);
            if (!leg) return e;
            const note = `Route timing reviewed & confirmed by driver — logged ${fmtHoursMinutes(leg.evaluation?.requestedDrivingHours)}, ~${fmtHoursMinutes(leg.evaluation?.requiredTruckTime)} estimated.`;
            return { ...e, remark: e.remark ? `${e.remark} [${note}]` : note };
          })
        : events;
      const annotated = unresolvedWarnings.length
        ? eventsToApply.map(e => ({ ...e, review_notes: unresolvedWarnings }))
        : eventsToApply;
      const ok = isReplaceDay
        ? await onApplyReplace?.(annotated, { mileageEdited, dailyMileage })
        : await onApply(annotated, { mileageEdited, dailyMileage });
      if (ok === false) setApplying(false);
    } catch (e) {
      setApplying(false);
    }
  };

  const pretripWarning = warnings.find(w => w.type === 'pretrip');
  const breakWarning = warnings.find(w => w.type === 'break30');

  return (
    <div data-client-version="proposal-review-current-2026-08-20-v2" className="rounded-xl border border-border bg-card p-3 mb-3">
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm font-semibold text-card-foreground">PROPOSED CHANGES — review before saving</div>
        <div className="text-xs text-muted-foreground">Not yet logged</div>
      </div>
      {selectedDate && (
        <div data-testid="proposal-editing-log-date" className="text-sm font-semibold text-card-foreground mb-2">
          {t('logs.editingLog', { date: formatLogDate(selectedDate) })}
        </div>
      )}
      <TimezoneIndicator tz={tz} className="mb-2" />
      {interpretation && <div className="text-sm text-muted-foreground mb-2">{interpretation}</div>}
      {isReplaceDay && (
        <div className="rounded-lg border border-error/40 bg-error-surface p-2 mb-2 text-xs text-error-surface-foreground flex gap-1.5">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <div>This will <span className="font-semibold">replace the existing log timeline for {targetDate || 'that day'}</span>. Everything currently logged for that day is removed and replaced with the events below. This cannot be undone.</div>
        {Array.isArray(replacesExisting) && replacesExisting.length > 0 && (
          <ul className="list-disc ml-4 mt-1">
            {replacesExisting.map((d, i) => <li key={i}>{d}</li>)}
          </ul>
        )}
        </div>
      )}
      {selectedDate && proposedDate && proposedDate !== selectedDate && (
        <div data-testid="date-change-notice" className="rounded-lg border border-warning/50 bg-warning-surface p-2 mb-2 text-xs text-warning-surface-foreground flex gap-1.5">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <div>Date change: this proposal targets <span className="font-semibold">{formatLogDate(proposedDate)}</span>, while you are editing <span className="font-semibold">{formatLogDate(selectedDate)}</span>. Please confirm the date before applying.</div>
        </div>
      )}

      {clarifications?.length > 0 && (
        <div className="rounded-lg border border-warning/50 bg-warning-surface p-2 mb-2 space-y-1">
          {clarifications.map((c, i) => (
            <div key={i} className="text-xs text-warning-surface-foreground">
              <span className="font-medium">Clarification: </span>{c.question}
              {c.options && (
                <div className="flex flex-wrap gap-2 mt-1">
                  {c.options.map((o, j) => (
                    <button key={j} className="rounded border border-warning/70 px-2 py-0.5 hover:bg-warning/20"
                      onClick={() => onResolveClarification?.(i, o)}>{o}</button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Mandatory validation warnings */}
      {displayWarnings.length > 0 && (
        <div className="space-y-2 mb-2">
          {displayWarnings.map((w, i) => (
            <div key={i} className={`rounded-lg border p-2 flex items-start gap-2 ${w.severity === 'blocking' ? 'border-error/40 bg-error-surface' : 'border-warning/50 bg-warning-surface'}`}>
              <AlertTriangle className={`w-4 h-4 mt-0.5 shrink-0 ${w.severity === 'blocking' ? 'text-error' : 'text-warning'}`} />
              <div className="text-xs flex-1 text-warning-surface-foreground">
                <div className={`font-semibold ${w.severity === 'blocking' ? 'text-error-surface-foreground' : 'text-warning-surface-foreground'}`}>{w.title}</div>
                <div>{w.message}</div>
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
                {w.type === 'route_reasonableness' && canFixRouteTiming && !manualReview && (
                  <div className="flex gap-2 mt-1">
                    <Button size="sm" onClick={fixRouteTiming} disabled={fixing}>
                      <Wrench className="w-3.5 h-3.5 mr-1" /> {fixing ? 'Fixing…' : 'Fix route timing'}
                    </Button>
                  </div>
                )}
                {w.type === 'route_reasonableness' && manualReview && (
                  <div className="text-[11px] mt-1 rounded border border-warning/50 bg-warning-surface px-2 py-1 text-warning-surface-foreground">
                    <div className="font-semibold mb-0.5">Manual review needed</div>
                    <div>Reconstructing the inferred times would collide with an explicitly logged event. LogbookAI will not move an explicit time. Review the times or locations by hand.</div>
                    {manualReview.map((g, gi) => <div key={gi} className="opacity-90">{g.message}</div>)}
                  </div>
                )}
                {w.hint && <div className="text-[11px] mt-0.5 opacity-80">{w.hint}</div>}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Successful route validation: informational, never warning-styled. */}
      {effectiveRouteWarning?.severity === 'success' && (
        <div data-testid="route-validation-ok" className="rounded-lg border border-success/40 bg-success-surface p-2 mb-2 flex items-start gap-2">
          <ShieldCheck className="w-4 h-4 mt-0.5 shrink-0 text-success" />
          <div className="text-xs flex-1 text-success-surface-foreground">
            <div className="font-semibold">Route validated</div>
            <div>{effectiveRouteWarning.message}</div>
            {effectiveRouteWarning.note && <div className="text-[11px] mt-0.5 opacity-80">{effectiveRouteWarning.note}</div>}
          </div>
        </div>
      )}

      {/* Explicit-time route-timing conflicts: never auto-changed, never a hard
          blocker — the driver reviews the exact discrepancy per leg and must
          explicitly acknowledge before Apply unlocks. Route calculations are a
          plausibility check, not the authoritative record of trip duration. */}
      {needsRouteAck && (
        <div className="rounded-lg border border-error/40 bg-error-surface p-2 mb-2">
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-error" />
            <div className="text-xs flex-1 text-error-surface-foreground">
              <div className="font-semibold mb-1">Route timing looks unusual</div>
              <div className="space-y-1.5">
                {explicitConflictLegs.map((leg, i) => (
                  <div key={i} className="rounded border border-error/30 bg-card px-2 py-1">
                    <div className="font-medium text-card-foreground">{leg.origin || 'Unknown'} → {leg.destination || 'Unknown'}</div>
                    <div>Logged: {fmtHoursMinutes(leg.evaluation?.requestedDrivingHours)}</div>
                    <div>Estimated truck travel time: ~{fmtHoursMinutes(leg.evaluation?.requiredTruckTime)}</div>
                  </div>
                ))}
              </div>
              <div className="mt-1.5">These times were provided by you. Please verify they are correct before applying.</div>
              <label className="flex items-start gap-2 mt-2 cursor-pointer">
                <input type="checkbox" className="mt-0.5 w-4 h-4" checked={routeAcknowledged}
                  onChange={(e) => setRouteAcknowledged(e.target.checked)} />
                <span className="font-medium">I reviewed these times and confirm they are accurate</span>
              </label>
            </div>
          </div>
        </div>
      )}

      <div className="rounded-lg border border-border p-2 mb-2">
        <div className="text-xs text-muted-foreground mb-1">24-hour RODS graph (proposed)</div>
        <LogGraph events={[...validationExisting, ...events.map(e => ({ ...e, start_timestamp: e.start_timestamp, end_timestamp: e.end_timestamp }))]} dateStr={proposedDate} timezone={tz} totalsOverride={proposalTotals} />
      </div>

      <div className="space-y-1 mb-2">
        {events.map((e, i) => (
          <div
            key={i}
            data-testid="proposal-event"
            data-start-timestamp={e.start_timestamp || ''}
            data-end-timestamp={e.end_timestamp || ''}
            data-duty-status={e.duty_status || ''}
            data-city={e.city || ''}
            data-state={e.state || ''}
            data-activity={e.activity_type || ''}
            data-remark={e.remark || ''}
            className="rounded-lg border border-border p-2 text-xs"
          >
            {editable ? (
              <div className="space-y-1">
                <div className="grid grid-cols-2 gap-1">
                  {STATUSES.map(s => (
                    <button key={s} onClick={() => updateField(i, 'duty_status', s)}
                      className={`rounded border px-1 py-0.5 ${e.duty_status === s ? 'border-primary bg-accent font-medium text-accent-foreground' : 'border-border text-card-foreground'}`}>{STATUS_LABELS[s]}</button>
                  ))}
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
                  <Input type="datetime-local" value={e.start_timestamp ? new Date(e.start_timestamp).toISOString().slice(0, 16) : ''} onChange={(ev) => updateTs(i, 'start_timestamp', ev.target.value)} />
                  <Input type="datetime-local" value={e.end_timestamp ? new Date(e.end_timestamp).toISOString().slice(0, 16) : ''} onChange={(ev) => updateTs(i, 'end_timestamp', ev.target.value)} />
                </div>
                <div className="grid grid-cols-2 gap-1">
                  <Input placeholder="City" value={e.city || ''} onChange={(ev) => updateField(i, 'city', ev.target.value)} />
                  <Input placeholder="State" value={e.state || ''} onChange={(ev) => updateField(i, 'state', ev.target.value.toUpperCase())} maxLength={2} />
                </div>
                <Input placeholder="Remark" value={e.remark || ''} onChange={(ev) => updateField(i, 'remark', ev.target.value)} />
                {e.duty_status === 'DRIVING' && (
                  <div>
                    <div className="text-muted-foreground mb-1">Segment miles</div>
                    <Input aria-label={`Miles for driving segment ${i + 1}`} type="number" min="0" step="0.1" value={e.mileage ?? ''} onChange={(ev) => updateMileage(i, ev.target.value)} />
                    <div className="text-[11px] text-muted-foreground mt-1">Editing miles marks the proposed daily mileage as manual.</div>
                  </div>
                )}
                {e.ambiguous_fields?.length > 0 && <div className="text-warning">Guessed: {e.ambiguous_fields.join(', ')} — please verify.</div>}
              </div>
            ) : (
              <div className="flex items-start gap-2">
                <div className="font-mono text-muted-foreground w-28 shrink-0">
                  {fmtClockShort(e.start_timestamp, tz)} – {e.end_timestamp ? fmtClockShort(e.end_timestamp, tz) : 'ongoing'}
                </div>
                <div className="flex-1">
                  <div className="font-semibold text-card-foreground">{STATUS_LABELS[e.duty_status] || e.duty_status}{e.activity_type ? ` · ${e.activity_type}` : ''}</div>
                  <div className="text-muted-foreground">{[e.city, e.state].filter(Boolean).join(', ')}{e.remark ? ` — ${e.remark}` : ''}</div>
                  {e.field_provenance?.start_time === 'inferred' && (
                    <div className="text-[11px] text-warning mt-1">Start time inferred by LogbookAI — please verify it is correct before applying.</div>
                  )}
                  {e.duty_status === 'DRIVING' && e.mileage != null && Number.isFinite(Number(e.mileage)) && (
                    <div className="text-card-foreground mt-1">{Number(e.mileage).toFixed(1)} mi <span className="text-muted-foreground">({e.mileage_source === 'route' ? 'Route Calculated' : e.mileage_source === 'driver_stated' ? 'Manual · as you stated' : e.mileage_source === 'manual' ? 'Manual · driver edited' : 'Speed Estimated'})</span></div>
                  )}
                  {e.duty_status === 'DRIVING' && e.mileage == null && (
                    <div className="mt-1">
                      <div className="text-card-foreground">Mileage: —</div>
                      <div className="text-[11px] text-muted-foreground">
                        {e.end_timestamp ? 'Route mileage available once a destination is known.' : 'Ongoing — route mileage available once a destination is known.'}
                      </div>
                    </div>
                  )}
                  {e.confidence && e.confidence !== 'high' && <div className="text-warning">Confidence: {e.confidence}</div>}
                  {e.adjustments?.map((adjustment, adjustmentIndex) => (
                    <div key={adjustmentIndex} className="mt-1 rounded border border-warning/50 bg-warning-surface px-2 py-1 text-[11px] text-warning-surface-foreground">
                      <span className="font-semibold">{adjustment.field.replace('_', ' ')} adjusted:</span> {adjustment.original_stated_value} → {adjustment.adjusted_value}
                      {adjustment.reason ? ` — ${adjustment.reason}` : ''}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="rounded-lg border border-border bg-muted/40 p-2 mb-2 flex items-center justify-between text-sm">
        <div>
          <div className="text-xs text-muted-foreground">Proposed daily mileage</div>
          <div className="font-semibold text-card-foreground">{dailyMileage.toFixed(1)} mi</div>
        </div>
        <div className="text-xs text-muted-foreground">
          {mileageEdited ? 'Manual · driver edited'
            : isStationary ? 'Stationary · no driving'
              : hasUnknownMileage ? 'Auto · excludes unknown mileage (destination not yet known)'
                : hasEstimatedMileage ? 'Route Calculated + Speed Estimated' : 'Auto · Route Calculated'}
        </div>
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

      {(() => {
        const d = deriveHosDisplay(hos, validation.historyComplete);
        const card = (label, c) => (
          <div className="rounded border border-border p-2">
            <div className="text-muted-foreground">{label}</div>
            <div className="font-semibold text-card-foreground">{c.value}</div>
            {c.note && <div className="text-[10px] text-muted-foreground mt-0.5">{c.note}</div>}
          </div>
        );
        return (
          <div className="grid grid-cols-2 gap-2 mb-3 text-xs">
            {card('Driving Remaining', d.driving)}
            {card('14-Hour Window', d.window14)}
            {card('30-Min Break', d.break)}
            {card(`Cycle ${hos.cycle.cycleLimit}/${hos.cycle.cycleDays}`, d.cycle)}
          </div>
        );
      })()}

      <div className="flex flex-wrap gap-2">
        <Button data-testid="apply-proposal" className="flex-1" disabled={blocking || applying}
          onClick={() => (!blocking && !applying && unresolvedWarnings.length > 0 ? setSaveAnywayOpen(true) : handleApply())}>
          <Check className="w-4 h-4 mr-1" /> {applying ? 'Applying…' : (isReplaceDay ? 'Replace Day & Apply' : 'Add to Logbook')}
        </Button>
        <Button variant="outline" onClick={() => setEditable(v => !v)}><Pencil className="w-4 h-4 mr-1" /> Edit Proposal</Button>
        <Button data-testid="cancel-proposal" aria-label="Cancel proposal" variant="ghost" onClick={onCancel}><X className="w-4 h-4" /></Button>
      </div>
      {blocking && <div className="text-[11px] text-error mt-2">{isReplaceDay ? 'Replace Day & Apply' : 'Add to Logbook'} is locked until the blocking issue is resolved or the proposal is edited.</div>}
      <div className="text-[11px] text-muted-foreground mt-1">Validation + HOS values are computed by LogbookAI's deterministic engine. Nothing is written to your log until you confirm.</div>

      <PreTripDialog open={pretripOpen} onOpenChange={setPretripOpen}
        drivingStart={pretripWarning?.drivingStart}
        defaultCity={events[0]?.city} defaultState={events[0]?.state}
        onConfirm={addPreTrip} />

      <AlertDialog open={saveAnywayOpen} onOpenChange={setSaveAnywayOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Save anyway?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <div>These review items will stay unresolved on the saved log — you can correct them later. LogbookAI will add only the proposed events; no gaps are filled and no existing entries are changed.</div>
                <ul className="list-disc ml-4">
                  {unresolvedWarnings.map((w, i) => <li key={i}><span className="font-semibold">{w.title}</span> — {w.message}</li>)}
                </ul>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Go Back</AlertDialogCancel>
            <AlertDialogAction onClick={handleApply}>Save Anyway</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}