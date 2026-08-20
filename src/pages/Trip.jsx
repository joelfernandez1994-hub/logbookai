import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useDriverData } from '@/hooks/useDriverData';
import { computeHOS, fmtDur, dateKeyInTz } from '@/lib/hosEngine';
import { truckEtaHours, speedProfileLabel } from '@/lib/proposalValidation';
import { limitingClock, maxDriveMiles, buildComplianceEdits } from '@/lib/complianceStop';
import { firstEventOfDay, loggedFuelStops, getFuelReceipts } from '@/lib/tripSync';
import DailyMilesCard from '@/components/DailyMilesCard';
import TimelineGapNotice from '@/components/TimelineGapNotice';
import BottomSelect from '@/components/BottomSelect';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Map, Clock, Check, X, Plus, MapPin, AlertTriangle, Sparkles, Moon, RefreshCw } from 'lucide-react';

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
  const hos = computeHOS(events, cycleType, tz, now, { historyComplete: profile?.entered_prior_history });

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
      note: s.source === 'receipt' ? 'From fuel receipt' : 'From logged fuel event',
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
    const t = await base44.entities.Trip.list('-created_date', 20);
    setTrips(t || []);
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
    if (!estimate) return null;
    const neededHours = truckEtaHours(estimate, speedProfile) ?? estimate.hours;
    const drivingRemaining = hos.driving.drivingRemainingMs / 3600000;
    const windowRemaining = hos.window14.remainingMs / 3600000;
    const cycleRemaining = hos.cycle.cycleRemainingHours;
    const achievable = neededHours <= drivingRemaining && neededHours <= windowRemaining && neededHours <= cycleRemaining;
    return { neededHours, drivingRemaining, windowRemaining, cycleRemaining, achievable };
  };
  const feasibility = checkFeasibility();

  const fetchComplianceStop = async () => {
    if (!estimate || !pickup.city || !delivery.city) return;
    setStopLoading(true); setStopError(null);
    try {
      const maxMiles = maxDriveMiles(hos, speedProfile);
      const res = await base44.functions.invoke('complianceStop', {
        origin: `${pickup.city}, ${pickup.state}`,
        destination: `${delivery.city}, ${delivery.state}`,
        max_drive_miles: maxMiles,
      });
      const s = res?.data || res;
      if (!s || s.error) { setStopError(s?.error || 'No stop found'); setStopSugg(null); setEdits(null); }
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
    if (autoAssist && estimate && feasibility && !feasibility.achievable && !stopSugg && !stopLoading && !stopError) {
      fetchComplianceStop();
    }
    if (feasibility?.achievable) { setStopSugg(null); setEdits(null); setApplied(false); setStopError(null); }
  }, [estimate, feasibility?.achievable, autoAssist]);

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
      <h1 className="text-xl font-bold mb-3 text-foreground">Trip Planner</h1>
      <p className="text-xs text-muted-foreground mb-4">Planned activity. Stops here are NOT official RODS until you confirm them when they occur. Pickup and fuel stops auto-fill from your log; edit them to override.</p>

      <TimelineGapNotice events={events} dateStr={todayKey} tz={tz} now={now} />
      <DailyMilesCard events={events} dateStr={todayKey} tz={tz} speedProfile={speedProfile} />

      <div className="rounded-xl border border-border bg-card p-3 mb-4 flex items-center justify-between">
        <div className="flex items-start gap-2">
          <Sparkles className="w-4 h-4 text-success mt-0.5" />
          <div>
            <div className="text-sm font-medium text-card-foreground">Auto HOS Assist</div>
            <div className="text-[11px] text-muted-foreground">When a trip isn't achievable under current HOS, automatically suggest a rest stop and trip edits. Nothing is applied without your approval.</div>
          </div>
        </div>
        <Switch checked={autoAssist} onCheckedChange={setAutoAssist} />
      </div>

      <div className="grid grid-cols-2 gap-2 mb-4">
        <div className="rounded-xl border border-border bg-card p-3 text-sm">
          <div className="text-xs text-muted-foreground">Driving available</div>
          <div className="font-bold text-card-foreground">{fmtDur(hos.driving.drivingRemainingMs)}</div>
        </div>
        <div className="rounded-xl border border-border bg-card p-3 text-sm">
          <div className="text-xs text-muted-foreground">14-hr window available</div>
          <div className="font-bold text-card-foreground">{fmtDur(hos.window14.remainingMs)}</div>
        </div>
        <div className="rounded-xl border border-border bg-card p-3 text-sm">
          <div className="text-xs text-muted-foreground">Cycle available</div>
          <div className="font-bold text-card-foreground">{fmtHM(hos.cycle.cycleRemainingHours)}</div>
        </div>
      </div>
      {hos.split.status === 'active' && (
        <div className="rounded-xl border border-blue-200 bg-blue-50 p-2 mb-4 text-xs text-blue-800">
          Split sleeper active — driving & 14-hr window recalculated from the qualifying pairing.
        </div>
      )}

      <div className="rounded-xl border border-border bg-card p-4 mb-4 space-y-3">
        <div className="font-medium text-sm text-card-foreground">Pickup</div>
        <div className="grid grid-cols-2 gap-2">
          <Input placeholder="City" value={pickup.city} onChange={(e) => { setPickupTouched(true); setPickup({ ...pickup, city: e.target.value }); }} />
          <Input placeholder="ST" maxLength={2} value={pickup.state} onChange={(e) => { setPickupTouched(true); setPickup({ ...pickup, state: e.target.value.toUpperCase() }); }} />
        </div>
        <Input type="datetime-local" value={pickupTime} onChange={(e) => setPickupTime(e.target.value)} />
        <div className="font-medium text-sm pt-2 text-card-foreground">Delivery</div>
        <div className="grid grid-cols-2 gap-2">
          <Input placeholder="City" value={delivery.city} onChange={(e) => setDelivery({ ...delivery, city: e.target.value })} />
          <Input placeholder="ST" maxLength={2} value={delivery.state} onChange={(e) => setDelivery({ ...delivery, state: e.target.value.toUpperCase() })} />
        </div>
        <Input type="datetime-local" value={deliveryTime} onChange={(e) => setDeliveryTime(e.target.value)} />
        <Button className="w-full" disabled={!pickup.city || !delivery.city || estimating} onClick={estimateRoute}>
          {estimating ? 'Estimating route...' : 'Estimate Route & Check Feasibility'}
        </Button>
      </div>

      {estimate && !estimate.error && (
        <div className="rounded-xl border border-border bg-card p-4 mb-4">
          <div className="font-medium text-sm text-card-foreground mb-1">{pickup.city}, {pickup.state} → {delivery.city}, {delivery.state}</div>
          <div className="grid grid-cols-2 gap-2 text-sm mb-2 text-card-foreground">
            <div><Map className="w-4 h-4 inline mr-1" /> {Math.round(estimate.miles)} mi</div>
            <div><Clock className="w-4 h-4 inline mr-1" /> {fmtHM(estimate.hours)}</div>
          </div>
          <p className="text-xs text-muted-foreground mb-1">Planning profile: {speedProfileLabel(speedProfile)}</p>
          {estimate.notes && <p className="text-xs text-muted-foreground mb-3">{cleanNotes(estimate.notes)}</p>}
          {feasibility && (
            <div className={`rounded-lg p-3 ${feasibility.achievable ? 'bg-success-surface border border-success/40' : 'bg-error-surface border border-error/40'}`}>
              <div className={`font-bold flex items-center gap-1 ${feasibility.achievable ? 'text-success-surface-foreground' : 'text-error-surface-foreground'}`}>
                {feasibility.achievable ? <><Check className="w-4 h-4" /> Likely achievable</> : <><X className="w-4 h-4" /> Not achievable under current hours</>}
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                Need {fmtHM(feasibility.neededHours)} · Have {fmtHM(feasibility.drivingRemaining)} driving / {fmtHM(feasibility.windowRemaining)} 14-hr window / {fmtHM(feasibility.cycleRemaining)} cycle.
              </div>
              {!feasibility.achievable && (
                <div className="text-xs text-error-surface-foreground mt-1">Additional qualifying rest will be required before arrival. Do not exceed limits or speed.</div>
              )}
            </div>
          )}
          <Button variant="outline" className="w-full mt-3" onClick={saveTrip}>Save Planned Trip</Button>
        </div>
      )}
      {estimate?.error && <div className="text-xs text-error mb-3">Route estimate could not be retrieved. Please try again.</div>}

      {estimate && !estimate.error && feasibility && !feasibility.achievable && autoAssist && (
        <div className="rounded-xl border border-warning/50 bg-warning-surface p-4 mb-4">
          <div className="flex items-center gap-2 font-semibold text-sm text-warning-surface-foreground mb-2">
            <MapPin className="w-4 h-4" /> HOS Rest Stop Suggestion
          </div>
          <div className="text-xs text-warning-surface-foreground mb-2">
            Limiting clock: <span className="font-medium">{limitingClock(hos).limiter.label}</span> · planning profile {speedProfileLabel(speedProfile)} · max drivable ~{Math.round(maxDriveMiles(hos, speedProfile))} mi.
          </div>

          {stopLoading && <div className="text-xs text-muted-foreground flex items-center gap-2"><RefreshCw className="w-3.5 h-3.5 animate-spin" /> Finding a rest stop along your route...</div>}
          {stopError && <div className="text-xs text-error mb-1">Couldn't resolve a stop: {stopError}. <button className="underline" onClick={fetchComplianceStop}>Retry</button></div>}

          {stopSugg && edits && (
            <div className="mt-2 space-y-2">
              <div className="rounded-lg border border-warning/40 bg-card p-3">
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Suggested stopping area</div>
                <div className="text-sm font-medium text-card-foreground">
                  {stopSugg.verified
                    ? `${stopSugg.stop_city}${stopSugg.stop_state ? ', ' + stopSugg.stop_state : ''}`
                    : 'Suggested stopping range'}
                </div>
                <div className="text-[11px] text-muted-foreground mt-0.5">
                  {stopSugg.verified
                    ? 'Approximate area from road routing — confirm a truck-accessible stop before arriving. Named truck-stop verification is a future integration.'
                    : (stopSugg.note ? cleanNotes(stopSugg.note) : 'No named stop verified — plan to stop within this mileage range.')}
                </div>
              </div>

              <div className="rounded-lg border border-border bg-card p-3 space-y-1.5 text-xs">
                <Row label="Miles into trip" value={`~${Math.round(stopSugg.miles_from_origin)} mi`} />
                <Row label="Leg 1" value={`${pickup.city}, ${pickup.state} → ${edits.stopEvent.city || 'stop'} · ~${Math.round(edits.leg1Miles)} mi · ${fmtHM(edits.leg1Hours)}`} />
                <Row label="Rest" value={fmtHM(edits.restHours)} />
                <Row label="Leg 2" value={`${edits.stopEvent.city || 'stop'} → ${delivery.city}, ${delivery.state} · ~${Math.round(edits.leg2Miles)} mi · ${fmtHM(edits.leg2Hours)}`} />
                <Row label="Estimated remaining mileage" value={`~${Math.round(stopSugg.miles_remaining)} mi`} />
              </div>

              <div className={`rounded-lg p-2 text-xs ${edits.overallOk ? 'bg-success-surface border border-success/40 text-success-surface-foreground' : 'bg-error-surface border border-error/40 text-error-surface-foreground'}`}>
                {edits.overallOk
                  ? <><Check className="w-3.5 h-3.5 inline mr-1" />This rest plan fits within your currently calculated HOS availability based on the information presently recorded.</>
                  : <><AlertTriangle className="w-3.5 h-3.5 inline mr-1" />Additional rest will still be needed after this stop to complete the route.</>}
              </div>

              {edits.needsCycleFix && (
                <div className="rounded-lg border border-error/40 bg-error-surface p-3 text-xs text-error-surface-foreground">
                  <div className="font-medium flex items-center gap-1"><AlertTriangle className="w-3.5 h-3.5" /> Review previous trips</div>
                  <div className="mt-1">Your cycle is the bottleneck and a {fmtHM(edits.restHours)} rest won't recover it. Check that prior days' driving entries are accurate; if a previous driving entry was over-stated, correct it to recover cycle hours. Corrections require your approval before they're applied.</div>
                  <Link to="/log-assistant" className="inline-block mt-2 underline font-medium">Go to Manual Log Assistant →</Link>
                </div>
              )}

              {applied
                ? <div className="text-xs text-success font-medium flex items-center gap-1"><Check className="w-3.5 h-3.5" /> Rest stop added to your plan below.</div>
                : <Button size="sm" className="w-full" onClick={applyEdits}><Moon className="w-3.5 h-3.5 mr-1" />Approve & Add Stop to Plan</Button>}
            </div>
          )}
        </div>
      )}

      {estimate && !estimate.error && feasibility && !feasibility.achievable && !autoAssist && !stopSugg && (
        <div className="rounded-xl border border-border bg-card p-3 mb-4">
          <Button size="sm" variant="outline" className="w-full" onClick={fetchComplianceStop} disabled={stopLoading}>
            <MapPin className="w-3.5 h-3.5 mr-1" /> {stopLoading ? 'Finding a rest stop...' : 'Suggest a Rest Stop'}
          </Button>
        </div>
      )}

      <div className="rounded-xl border border-border bg-card p-3 mb-4">
        <div className="flex items-center justify-between mb-2">
          <div className="font-medium text-sm text-card-foreground">Planned Stops</div>
          <Button size="sm" variant="outline" onClick={() => { setStopsTouched(true); setStops([...stops, { type: 'fuel', city: '', note: '' }]); }}>
            <Plus className="w-3.5 h-3.5 mr-1" /> Add
          </Button>
        </div>
        {stops.map((s, i) => (
          <div key={i} className="flex gap-2 mb-2">
            <BottomSelect className="w-24 p-1 text-xs" value={s.type}
              onChange={(v) => { setStopsTouched(true); const n = [...stops]; n[i].type = v; setStops(n); }}
              options={[{ value: 'fuel', label: 'Fuel' }, { value: 'rest', label: 'Rest' }, { value: 'break', label: 'Break' }]} />
            <Input placeholder="City, ST" value={s.city} onChange={(e) => { setStopsTouched(true); const n = [...stops]; n[i].city = e.target.value; setStops(n); }} className="text-xs" />
            {s.note && <span className="text-[10px] text-muted-foreground self-center">{s.note}</span>}
          </div>
        ))}
        <p className="text-[11px] text-muted-foreground mt-1">Planned stops are not official RODS. Confirm with "Log This Event" when they happen.</p>
      </div>

      <div className="space-y-2 mb-6">
        {trips.map((t) => (
          <div key={t.id} className="rounded-xl border border-border bg-card p-3 text-sm">
            <div className="font-medium text-card-foreground">{t.pickup_city}, {t.pickup_state} → {t.delivery_city}, {t.delivery_state}</div>
            <div className="text-xs text-muted-foreground">{t.mileage ? `${Math.round(t.mileage)} mi · ${fmtHM(t.estimated_travel_hours)} · ` : ''}{t.is_achievable ? 'Likely achievable' : 'Not achievable under current hours'}</div>
          </div>
        ))}
      </div>
    </div>
  );
}