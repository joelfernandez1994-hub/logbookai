import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useDriverData } from '@/hooks/useDriverData';
import { computeHOS, fmtDur, dateKeyInTz } from '@/lib/hosEngine';
import { whatCanIDo } from '@/lib/logAssistant';
import { truckEtaHours, speedProfileLabel } from '@/lib/proposalValidation';
import { limitingClock, maxDriveMiles, buildComplianceEdits, planTripStops, withFuelOpportunities, FRESH_TRIP_HOS_BASIS } from '@/lib/complianceStop';
import { buildParkingHandoff } from '@/lib/parkingProvider';
import { findTruckStopsNearStop, rankTruckStops, pickTopStopsForType, classifyFit, buildPlannedStopFromTruckStop } from '@/lib/truckStopProvider';
import { firstEventOfDay, loggedFuelStops, getFuelReceipts } from '@/lib/tripSync';
import DailyMilesCard from '@/components/DailyMilesCard';
import TimelineGapNotice from '@/components/TimelineGapNotice';
import BottomSelect from '@/components/BottomSelect';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import LocationInput from '@/components/LocationInput';
import { Switch } from '@/components/ui/switch';
import { Map, Clock, Check, X, Plus, MapPin, AlertTriangle, Sparkles, Moon, RefreshCw, Coffee, BedDouble, Fuel, Truck } from 'lucide-react';

// Always render durations as X hr YY min — never raw floating point.
const fmtHM = (h) => {
  if (h == null || isNaN(h)) return '—';
  const totalMin = Math.round(h * 60);
  const hh = Math.floor(totalMin / 60);
  const mm = totalMin % 60;
  return `${hh} hr ${String(mm).padStart(2, '0')} min`;
};
// Labeled row for the structured rest-stop breakdown.
const Row = ({ label, value }) => (
  <div className="flex gap-2">
    <div className="w-28 shrink-0 text-muted-foreground">{label}</div>
    <div className="flex-1 text-card-foreground">{value}</div>
  </div>
);
// Strip AI/web citation markup, URLs and search brackets from provider notes.
const cleanNotes = (s) => (s || '')
  .replace(/\[+https?:[^\]]*\]+/g, '')
  .replace(/https?:\/\/\S+/g, '')
  .replace(/\[\d+\]/g, '')
  .replace(/\s+/g, ' ')
  .trim();

export default function Trip() {
  const { t } = useTranslation();
  const { profile, carrier, events, loading, reload } = useDriverData(9);
  const [pickup, setPickup] = useState({ city: '', state: '' });
  const [delivery, setDelivery] = useState({ city: '', state: '' });
  const [pickupTime, setPickupTime] = useState('');
  const [deliveryTime, setDeliveryTime] = useState('');
  const [estimate, setEstimate] = useState(null);
  const [estimating, setEstimating] = useState(false);
  const [stops, setStops] = useState([]);
  const [trips, setTrips] = useState([]);
  const [fuelReceipts, setFuelReceipts] = useState([]);
  const [pickupTouched, setPickupTouched] = useState(false);
  const [stopsTouched, setStopsTouched] = useState(false);

  const tz = carrier?.home_terminal_timezone || 'America/Chicago';
  const cycleType = carrier?.hos_cycle || '70_8';
  const speedProfile = profile?.trip_planning_speed_profile || 'conservative';
  const now = new Date();
  const todayKey = dateKeyInTz(now, tz);
  const availability = whatCanIDo(events, cycleType, tz, now, profile?.entered_prior_history);
  // REGRESSION FIX: this used to also require `!availability.cycleUnverified`,
  // which silently disabled the ENTIRE stop-suggestion pipeline (auto AND the
  // manual "Suggest a Rest Stop" button) whenever the driver hadn't entered
  // prior cycle history — a common, normal state, not a broken timeline.
  // driveRemainingMs/windowRemainingMs/break30 are all valid independent of
  // cycle verification (see whatCanIDo in logAssistant.js — only
  // cycleRemainingHours becomes null when unverified). Only a genuinely
  // invalid/incomplete timeline (`availability.unavailable`) should block
  // feasibility and stop suggestions.
  const hosVerified = !availability.unavailable;
  const cycleVerified = !availability.cycleUnverified;
  const hos = computeHOS(events, cycleType, tz, now, { historyComplete: hosVerified && cycleVerified });

  useEffect(() => { getFuelReceipts(30).then(setFuelReceipts); }, []);
  useEffect(() => {
    if (pickupTouched) return;
    const first = firstEventOfDay(events, todayKey, tz);
    if (first && first.city) setPickup({ city: first.city, state: first.state || '' });
  }, [events, todayKey, tz, pickupTouched]);
  useEffect(() => {
    if (stopsTouched) return;
    const fs = loggedFuelStops(events, fuelReceipts, todayKey, tz);
    setStops(fs.map(s => ({
      type: 'fuel',
      city: `${s.city}${s.state ? `, ${s.state}` : ''}`,
      note: s.source === 'receipt' ? t('trip.fromFuelReceipt') : t('trip.fromLoggedFuelEvent'),
    })));
  }, [events, fuelReceipts, todayKey, tz, stopsTouched]);

  const [autoAssist, setAutoAssist] = useState(() => localStorage.getItem('logbook_auto_compliance') !== 'false');
  useEffect(() => { localStorage.setItem('logbook_auto_compliance', autoAssist ? 'true' : 'false'); }, [autoAssist]);

  const [stopSugg, setStopSugg] = useState(null);
  const [stopLoading, setStopLoading] = useState(false);
  const [stopError, setStopError] = useState(null);
  const [edits, setEdits] = useState(null);
  const [applied, setApplied] = useState(false);

  const loadTrips = async () => {
    const list = await base44.entities.Trip.list('-created_date', 20);
    setTrips(list || []);
  };
  useEffect(() => { loadTrips(); }, []);

  const estimateRoute = async () => {
    setEstimating(true);
    setStopSugg(null); setEdits(null); setApplied(false); setStopError(null);
    try {
      const res = await base44.functions.invoke('tripEstimate', {
        origin: `${pickup.city}, ${pickup.state}`,
        destination: `${delivery.city}, ${delivery.state}`,
      });
      setEstimate(res.data);
    } catch (e) {
      setEstimate({ error: e.message });
    }
    setEstimating(false);
  };

  const checkFeasibility = () => {
    if (!estimate || !hosVerified) return null;
    const neededHours = truckEtaHours(estimate, speedProfile) ?? estimate.hours;
    const drivingRemaining = availability.driveRemainingMs / 3600000;
    const windowRemaining = availability.windowRemainingMs / 3600000;
    const cycleRemaining = availability.cycleRemainingHours;
    const achievable = neededHours <= drivingRemaining && neededHours <= windowRemaining && neededHours <= cycleRemaining;
    return { neededHours, drivingRemaining, windowRemaining, cycleRemaining, achievable };
  };
  const feasibility = checkFeasibility();

  // Full-route multi-stop plan (breaks / rests / restarts / fuel) — restored
  // automatic suggestion pipeline. Reuses the SAME canonical HOS numbers
  // already computed above (hos.break30 / hos.driving / hos.window14 /
  // hos.cycle); planTripStops() only converts those hours into route miles —
  // it never recomputes an HOS rule of its own.
  //
  // When the driver's ACTUAL current HOS cannot be verified (an invalid/
  // gapped log, not just unverified cycle history), we do NOT silently return
  // an empty plan. We plan against FRESH_TRIP_HOS_BASIS — the standard
  // property-carrying limits as if starting a fresh, fully-rested day — and
  // clearly label the result as an assumption (see freshHosFallbackNote
  // banner below). This is still the ONE canonical planTripStops() function;
  // only the input HOS numbers differ, never a second implementation.
  const usingFreshHosFallback = !!(estimate && !estimate.error && !hosVerified);
  const stopsHosBasis = hosVerified ? hos : FRESH_TRIP_HOS_BASIS;
  const rawRouteStops = (estimate && !estimate.error)
    ? planTripStops({ hos: stopsHosBasis, profileId: speedProfile, cycleType, totalMiles: estimate.miles })
    : [];
  // Fuel range is a separate, non-HOS mileage heuristic — fills in fuel
  // opportunities on long stretches the break/rest cadence alone wouldn't cover.
  const routeStops = (estimate && !estimate.error)
    ? withFuelOpportunities(rawRouteStops, estimate.miles, 500)
    : [];

  // Real locations along the actual route (never invented) — resolved via the
  // same complianceStop backend already used for the single-stop suggestion
  // below, called once per planned stop mileage.
  const [resolvedStops, setResolvedStops] = useState([]);
  const [resolvingStops, setResolvingStops] = useState(false);
  useEffect(() => {
    let cancelled = false;
    async function resolveLocations() {
      if (!routeStops.length || !pickup.city || !delivery.city) { setResolvedStops([]); return; }
      setResolvingStops(true);
      const originStr = `${pickup.city}, ${pickup.state}`;
      const destStr = `${delivery.city}, ${delivery.state}`;
      const out = [];
      for (const stop of routeStops) {
        if (cancelled) return;
        try {
          const res = await base44.functions.invoke('complianceStop', { origin: originStr, destination: destStr, max_drive_miles: stop.mile });
          const s = res?.data || res;
          out.push({ ...stop, city: s?.stop_city || '', state: s?.stop_state || '', verified: !!s?.verified, lat: s?.stop_lat ?? null, lng: s?.stop_lng ?? null });
        } catch (e) {
          out.push({ ...stop, city: '', state: '', verified: false, lat: null, lng: null });
        }
      }
      if (!cancelled) { setResolvedStops(out); setResolvingStops(false); }
    }
    resolveLocations();
    return () => { cancelled = true; };
  }, [estimate?.miles, usingFreshHosFallback, pickup.city, pickup.state, delivery.city, delivery.state]);

  const displayStops = resolvedStops.length === routeStops.length ? resolvedStops : routeStops;

  const STOP_META = {
    break: { label: t('trip.stopBreakLabel'), icon: Coffee, addType: 'break' },
    rest: { label: t('trip.stopRestLabel'), icon: Moon, addType: 'rest' },
    restart: { label: t('trip.stopRestartLabel'), icon: BedDouble, addType: 'rest' },
    fuel: { label: t('trip.stopFuelLabel'), icon: Fuel, addType: 'fuel' },
  };

  const addRouteStopToPlan = (stop) => {
    const meta = STOP_META[stop.type];
    setStopsTouched(true);
    setStops((prev) => [...prev, {
      type: meta.addType,
      city: stop.verified && stop.city ? `${stop.city}${stop.state ? `, ${stop.state}` : ''}` : '',
      note: t('trip.routeStopAddedNote', { label: meta.label, mile: Math.round(stop.mile), reason: stop.reason }),
    }]);
  };

  const fetchComplianceStop = async () => {
    if (!estimate || !pickup.city || !delivery.city || !hosVerified) return;
    setStopLoading(true); setStopError(null);
    try {
      const maxMiles = maxDriveMiles(hos, speedProfile);
      const res = await base44.functions.invoke('complianceStop', {
        origin: `${pickup.city}, ${pickup.state}`,
        destination: `${delivery.city}, ${delivery.state}`,
        max_drive_miles: maxMiles,
      });
      const s = res?.data || res;
      if (!s || s.error) { setStopError(s?.error || t('trip.noStopFound')); setStopSugg(null); setEdits(null); }
      else {
        setStopSugg(s);
        setEdits(buildComplianceEdits({
          origin: `${pickup.city}, ${pickup.state}`,
          destination: `${delivery.city}, ${delivery.state}`,
          stop: s, hos, profileId: speedProfile, cycleType,
        }));
      }
    } catch (e) { setStopError(e.message); }
    setStopLoading(false);
  };

  useEffect(() => {
    if (hosVerified && autoAssist && estimate && feasibility && !feasibility.achievable && !stopSugg && !stopLoading && !stopError) {
      fetchComplianceStop();
    }
    if (!hosVerified || feasibility?.achievable) { setStopSugg(null); setEdits(null); setApplied(false); setStopError(null); }
  }, [estimate, feasibility?.achievable, autoAssist, hosVerified]);

  const applyEdits = () => {
    if (!edits) return;
    setStopsTouched(true);
    setStops(prev => [...prev, { type: 'rest', city: edits.stopEvent.city, note: edits.stopEvent.note }]);
    setApplied(true);
  };

  const saveTrip = async () => {
    await base44.entities.Trip.create({
      pickup_city: pickup.city, pickup_state: pickup.state,
      pickup_appointment: pickupTime ? new Date(pickupTime).toISOString() : null,
      delivery_city: delivery.city, delivery_state: delivery.state,
      delivery_appointment: deliveryTime ? new Date(deliveryTime).toISOString() : null,
      mileage: estimate?.miles, estimated_travel_hours: estimate?.hours,
      estimated_route: estimate?.notes || '',
      is_achievable: feasibility?.achievable,
      feasibility_note: feasibility ? (feasibility.achievable ? 'Likely achievable under current HOS.' : `Not achievable. Limiting clock: ${feasibility.neededHours > feasibility.drivingRemaining ? '11-hour driving' : feasibility.neededHours > feasibility.windowRemaining ? '14-hour window' : 'cycle'}.`) : '',
      commodity: '',
    });
    loadTrips();
  };

  if (loading) return <div className="flex justify-center h-screen items-center"><div className="w-8 h-8 border-4 border-muted border-t-foreground rounded-full animate-spin" /></div>;

  return (
    <div className="px-4 pt-6">
      <h1 className="text-xl font-bold mb-3 text-foreground">{t('trip.title')}</h1>
      <p className="text-xs text-muted-foreground mb-4">{t('trip.intro')}</p>

      <TimelineGapNotice events={events} dateStr={todayKey} tz={tz} now={now} />
      <DailyMilesCard events={events} dateStr={todayKey} tz={tz} speedProfile={speedProfile} />

      <div className="rounded-xl border border-border bg-card p-3 mb-4 flex items-center justify-between">
        <div className="flex items-start gap-2">
          <Sparkles className="w-4 h-4 text-success mt-0.5" />
          <div>
            <div className="text-sm font-medium text-card-foreground">{t('trip.autoAssistTitle')}</div>
            <div className="text-[11px] text-muted-foreground">{t('trip.autoAssistDescription')}</div>
          </div>
        </div>
        <Switch checked={autoAssist} onCheckedChange={setAutoAssist} />
      </div>

      {availability.unavailable && (
        <div className="rounded-xl border border-warning/50 bg-warning-surface p-3 mb-4 text-warning-surface-foreground">
          <div className="text-sm font-semibold">{t('trip.availabilityUnavailable')}</div>
          <p className="text-xs mt-1">{availability.unavailableReason}</p>
          <Button asChild variant="outline" size="sm" className="mt-2 bg-transparent"><Link to="/logs">{t('trip.correctTimeline')}</Link></Button>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 mb-4">
        <div className="rounded-xl border border-border bg-card p-3 text-sm">
          <div className="text-xs text-muted-foreground">{t('trip.drivingAvailable')}</div>
          <div data-testid="trip-driving-available" className="font-bold text-card-foreground">{availability.unavailable ? '--' : fmtDur(availability.driveRemainingMs)}</div>
          {!availability.unavailable && availability.driveRemainingMs === 0 && <div className="text-[10px] text-muted-foreground mt-1">{availability.driveBlockers.find(b => b.rule === '11-hour driving limit')?.message}</div>}
        </div>
        <div className="rounded-xl border border-border bg-card p-3 text-sm">
          <div className="text-xs text-muted-foreground">{t('trip.windowAvailable')}</div>
          <div data-testid="trip-window-available" className="font-bold text-card-foreground">{availability.unavailable ? '--' : fmtDur(availability.windowRemainingMs)}</div>
          {!availability.unavailable && availability.windowRemainingMs === 0 && <div className="text-[10px] text-muted-foreground mt-1">{availability.driveBlockers.find(b => b.rule === '14-hour window')?.message}</div>}
        </div>
        <div className="rounded-xl border border-border bg-card p-3 text-sm">
          <div className="text-xs text-muted-foreground">{t('trip.cycleAvailable')}</div>
          <div data-testid="trip-cycle-available" className="font-bold text-card-foreground">{availability.cycleRemainingHours == null ? '--' : fmtHM(availability.cycleRemainingHours)}</div>
          {availability.cycleUnverified && <div className="text-[10px] text-muted-foreground mt-1">{availability.cycleUnverifiedReason}</div>}
          {!availability.unavailable && !availability.cycleUnverified && availability.cycleRemainingHours === 0 && <div className="text-[10px] text-muted-foreground mt-1">{availability.driveBlockers.find(b => b.rule.includes('cycle'))?.message}</div>}
        </div>
      </div>
      {hos.split.status === 'active' && (
        <div className="rounded-xl border border-blue-200 bg-blue-50 p-2 mb-4 text-xs text-blue-800">
          {t('trip.splitSleeperActiveNote')}
        </div>
      )}

      <div className="rounded-xl border border-border bg-card p-4 mb-4 space-y-3">
        <div className="font-medium text-sm text-card-foreground">{t('trip.pickup')}</div>
        <LocationInput value={pickup} onChange={(patch) => { setPickupTouched(true); setPickup((current) => ({ ...current, ...patch })); }} />
        <Input type="datetime-local" value={pickupTime} onChange={(e) => setPickupTime(e.target.value)} />
        <div className="font-medium text-sm pt-2 text-card-foreground">{t('trip.delivery')}</div>
        <LocationInput value={delivery} onChange={(patch) => setDelivery((current) => ({ ...current, ...patch }))} />
        <Input type="datetime-local" value={deliveryTime} onChange={(e) => setDeliveryTime(e.target.value)} />
        <Button className="w-full" disabled={!pickup.city || !delivery.city || estimating} onClick={estimateRoute}>
          {estimating ? t('trip.estimating') : t('trip.estimateButton')}
        </Button>
      </div>

      {estimate && !estimate.error && (
        <div className="rounded-xl border border-border bg-card p-4 mb-4">
          <div className="font-medium text-sm text-card-foreground mb-1">{pickup.city}, {pickup.state} → {delivery.city}, {delivery.state}</div>
          <div className="grid grid-cols-2 gap-2 text-sm mb-2 text-card-foreground">
            <div><Map className="w-4 h-4 inline mr-1" /> {Math.round(estimate.miles)} mi</div>
            <div><Clock className="w-4 h-4 inline mr-1" /> {fmtHM(estimate.hours)}</div>
          </div>
          <p className="text-xs text-muted-foreground mb-1">{t('trip.planningProfile', { profile: speedProfileLabel(speedProfile) })}</p>
          {estimate.notes && <p className="text-xs text-muted-foreground mb-3">{cleanNotes(estimate.notes)}</p>}
          {feasibility && (
            <div className={`rounded-lg p-3 ${feasibility.achievable ? 'bg-success-surface border border-success/40' : 'bg-error-surface border border-error/40'}`}>
              <div className={`font-bold flex items-center gap-1 ${feasibility.achievable ? 'text-success-surface-foreground' : 'text-error-surface-foreground'}`}>
                {feasibility.achievable ? <><Check className="w-4 h-4" /> {t('trip.likelyAchievable')}</> : <><X className="w-4 h-4" /> {t('trip.notAchievable')}</>}
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                {t('trip.feasibilityNeedHave', { needed: fmtHM(feasibility.neededHours), driving: fmtHM(feasibility.drivingRemaining), window: fmtHM(feasibility.windowRemaining), cycle: fmtHM(feasibility.cycleRemaining) })}
              </div>
              {!feasibility.achievable && (
                <div className="text-xs text-error-surface-foreground mt-1">{t('trip.restRequiredNote')}</div>
              )}
            </div>
          )}
          <Button variant="outline" className="w-full mt-3" onClick={saveTrip}>{t('trip.savePlannedTrip')}</Button>
        </div>
      )}
      {estimate?.error && <div className="text-xs text-error mb-3">{t('trip.routeEstimateError')}</div>}

      {estimate && !estimate.error && feasibility && !feasibility.achievable && autoAssist && (
        <div className="rounded-xl border border-warning/50 bg-warning-surface p-4 mb-4">
          <div className="flex items-center gap-2 font-semibold text-sm text-warning-surface-foreground mb-2">
            <MapPin className="w-4 h-4" /> {t('trip.hosRestStopSuggestion')}
          </div>
          <div className="text-xs text-warning-surface-foreground mb-2">
            {t('trip.limitingClockNote', { limiter: limitingClock(hos).limiter.label, profile: speedProfileLabel(speedProfile), miles: Math.round(maxDriveMiles(hos, speedProfile)) })}
          </div>

          {stopLoading && <div className="text-xs text-muted-foreground flex items-center gap-2"><RefreshCw className="w-3.5 h-3.5 animate-spin" /> {t('trip.findingRestStop')}</div>}
          {stopError && <div className="text-xs text-error mb-1">{t('trip.stopResolveError', { error: stopError })} <button className="underline" onClick={fetchComplianceStop}>{t('common.retry')}</button></div>}

          {stopSugg && edits && (
            <div className="mt-2 space-y-2">
              <div className="rounded-lg border border-warning/40 bg-card p-3">
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{t('trip.suggestedStoppingArea')}</div>
                <div className="text-sm font-medium text-card-foreground">
                  {stopSugg.verified
                    ? `${stopSugg.stop_city}${stopSugg.stop_state ? ', ' + stopSugg.stop_state : ''}`
                    : t('trip.suggestedStoppingRange')}
                </div>
                <div className="text-[11px] text-muted-foreground mt-0.5">
                  {stopSugg.verified
                    ? t('trip.verifiedAreaNote')
                    : (stopSugg.note ? cleanNotes(stopSugg.note) : t('trip.unverifiedAreaNote'))}
                </div>
              </div>

              <div className="rounded-lg border border-border bg-card p-3 space-y-1.5 text-xs">
                <Row label={t('trip.milesIntoTrip')} value={`~${Math.round(stopSugg.miles_from_origin)} mi`} />
                <Row label={t('trip.leg1')} value={`${pickup.city}, ${pickup.state} → ${edits.stopEvent.city || t('trip.stopFallback')} · ~${Math.round(edits.leg1Miles)} mi · ${fmtHM(edits.leg1Hours)}`} />
                <Row label={t('trip.rest')} value={fmtHM(edits.restHours)} />
                <Row label={t('trip.leg2')} value={`${edits.stopEvent.city || t('trip.stopFallback')} → ${delivery.city}, ${delivery.state} · ~${Math.round(edits.leg2Miles)} mi · ${fmtHM(edits.leg2Hours)}`} />
                <Row label={t('trip.estimatedRemainingMileage')} value={`~${Math.round(stopSugg.miles_remaining)} mi`} />
              </div>

              <div className={`rounded-lg p-2 text-xs ${edits.overallOk ? 'bg-success-surface border border-success/40 text-success-surface-foreground' : 'bg-error-surface border border-error/40 text-error-surface-foreground'}`}>
                {edits.overallOk
                  ? <><Check className="w-3.5 h-3.5 inline mr-1" />{t('trip.planFitsNote')}</>
                  : <><AlertTriangle className="w-3.5 h-3.5 inline mr-1" />{t('trip.planNeedsMoreRestNote')}</>}
              </div>

              {edits.needsCycleFix && (
                <div className="rounded-lg border border-error/40 bg-error-surface p-3 text-xs text-error-surface-foreground">
                  <div className="font-medium flex items-center gap-1"><AlertTriangle className="w-3.5 h-3.5" /> {t('trip.reviewPreviousTrips')}</div>
                  <div className="mt-1">{t('trip.cycleBottleneckNote', { rest: fmtHM(edits.restHours) })}</div>
                  <Link to="/log-assistant" className="inline-block mt-2 underline font-medium">{t('trip.goToAssistant')}</Link>
                </div>
              )}

              {applied
                ? <div className="text-xs text-success font-medium flex items-center gap-1"><Check className="w-3.5 h-3.5" /> {t('trip.restStopAdded')}</div>
                : <Button size="sm" className="w-full" onClick={applyEdits}><Moon className="w-3.5 h-3.5 mr-1" />{t('trip.approveAddStop')}</Button>}
            </div>
          )}
        </div>
      )}

      {estimate && !estimate.error && feasibility && !feasibility.achievable && !autoAssist && !stopSugg && (
        <div className="rounded-xl border border-border bg-card p-3 mb-4">
          <Button size="sm" variant="outline" className="w-full" onClick={fetchComplianceStop} disabled={stopLoading}>
            <MapPin className="w-3.5 h-3.5 mr-1" /> {stopLoading ? t('trip.findingRestStopShort') : t('trip.suggestRestStop')}
          </Button>
        </div>
      )}

      {estimate && !estimate.error && routeStops.length > 0 && (
        <div className="rounded-xl border border-border bg-card p-4 mb-4">
          <div className="flex items-center gap-2 font-semibold text-sm text-card-foreground mb-1">
            <Clock className="w-4 h-4" /> {t('trip.suggestedStopsAlongRoute')}
          </div>
          <p className="text-[11px] text-muted-foreground mb-3">{t('trip.suggestedStopsIntro')}</p>
          {usingFreshHosFallback && (
            <div className="rounded-lg border border-warning/40 bg-warning-surface p-2 text-[11px] text-warning-surface-foreground mb-3">
              {t('trip.freshHosFallbackNote')}
            </div>
          )}
          {resolvingStops && (
            <div className="text-[11px] text-muted-foreground flex items-center gap-2 mb-2"><RefreshCw className="w-3 h-3 animate-spin" /> {t('trip.resolvingLocations')}</div>
          )}
          <div className="space-y-2">
            {displayStops.map((stop, i) => {
              const meta = STOP_META[stop.type];
              const Icon = meta.icon;
              const locationLabel = stop.verified && stop.city
                ? `${stop.city}${stop.state ? `, ${stop.state}` : ''}`
                : t('trip.approxMileOnly', { mile: Math.round(stop.mile) });
              // Truck-stop/parking discovery is a SEPARATE concern from the HOS
              // stop decision above: LogbookAI decided WHEN/roughly WHERE via
              // planTripStops(); this only hands the driver off to an external
              // provider (Trucker Path) to find an actual truck stop/parking
              // spot near that real, route-derived point. Only offered once
              // real coordinates exist for this stop — never a guess.
              const handoff = buildParkingHandoff(stop);
              return (
                <div key={i} className="rounded-lg border border-border bg-accent/30 p-2.5 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-start gap-2">
                      <Icon className="w-4 h-4 mt-0.5 shrink-0 text-muted-foreground" />
                      <div>
                        <div className="font-medium text-card-foreground">{meta.label} — {locationLabel}</div>
                        <div className="text-muted-foreground">{stop.reason}</div>
                      </div>
                    </div>
                    <Button size="sm" variant="outline" className="h-7 px-2 shrink-0" onClick={() => addRouteStopToPlan(stop)}>
                      <Plus className="w-3 h-3 mr-1" /> {t('common.add')}
                    </Button>
                  </div>
                  {(stop.type === 'break' || stop.type === 'rest' || stop.type === 'restart' || stop.type === 'fuel') && (
                    <div className="mt-2 pt-2 border-t border-border/60 flex items-center justify-between gap-2">
                      <div className="text-[10px] text-muted-foreground">
                        <div>{t('trip.truckStopOption')}</div>
                        <div>{t('trip.parkingAvailabilityCheck')}</div>
                      </div>
                      {handoff ? (
                        <a href={handoff.appUrl} className="inline-flex items-center gap-1 h-7 px-2 rounded-md border border-border text-[11px] font-medium text-card-foreground hover:bg-accent shrink-0">
                          <Truck className="w-3 h-3" /> {t('trip.openInTruckerPath')}
                        </a>
                      ) : (
                        <div className="text-[10px] text-muted-foreground italic shrink-0">{t('trip.parkingLocationPending')}</div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <p className="text-[10px] text-muted-foreground mt-2">{t('trip.truckerPathRequiresApp')}</p>
        </div>
      )}

      <div className="rounded-xl border border-border bg-card p-3 mb-4">
        <div className="flex items-center justify-between mb-2">
          <div className="font-medium text-sm text-card-foreground">{t('trip.plannedStops')}</div>
          <Button size="sm" variant="outline" onClick={() => { setStopsTouched(true); setStops([...stops, { type: 'fuel', city: '', note: '' }]); }}>
            <Plus className="w-3.5 h-3.5 mr-1" /> {t('common.add')}
          </Button>
        </div>
        {stops.map((s, i) => (
          <div key={i} className="flex gap-2 mb-2">
            <BottomSelect className="w-24 p-1 text-xs" value={s.type}
              onChange={(v) => { setStopsTouched(true); const n = [...stops]; n[i].type = v; setStops(n); }}
              options={[{ value: 'fuel', label: t('trip.fuel') }, { value: 'rest', label: t('trip.rest') }, { value: 'break', label: t('trip.break') }]} />
            <Input placeholder={t('trip.cityStatePlaceholder')} value={s.city} onChange={(e) => { setStopsTouched(true); const n = [...stops]; n[i].city = e.target.value; setStops(n); }} className="text-xs" />
            {s.note && <span className="text-[10px] text-muted-foreground self-center">{s.note}</span>}
          </div>
        ))}
        <p className="text-[11px] text-muted-foreground mt-1">{t('trip.plannedStopsNote')}</p>
      </div>

      <div className="space-y-2 mb-6">
        {trips.map((trip) => (
          <div key={trip.id} className="rounded-xl border border-border bg-card p-3 text-sm">
            <div className="font-medium text-card-foreground">{trip.pickup_city}, {trip.pickup_state} → {trip.delivery_city}, {trip.delivery_state}</div>
            <div className="text-xs text-muted-foreground">{trip.mileage ? `${Math.round(trip.mileage)} mi · ${fmtHM(trip.estimated_travel_hours)} · ` : ''}{trip.is_achievable ? t('trip.likelyAchievable') : t('trip.notAchievable')}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
