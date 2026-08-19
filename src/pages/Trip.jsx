import { useState, useEffect } from 'react';
import { useDriverData } from '@/hooks/useDriverData';
import { computeHOS, fmtDur, dateKeyInTz } from '@/lib/hosEngine';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Map, Clock, Check, X, Plus } from 'lucide-react';

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

  const tz = carrier?.home_terminal_timezone || 'America/Chicago';
  const cycleType = carrier?.hos_cycle || '70_8';
  const now = new Date();
  const hos = computeHOS(events, cycleType, tz, now, { historyComplete: profile?.entered_prior_history });

  const loadTrips = async () => {
    const t = await base44.entities.Trip.list('-created_date', 20);
    setTrips(t || []);
  };
  useEffect(() => { loadTrips(); }, []);

  const estimateRoute = async () => {
    setEstimating(true);
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
    const neededHours = estimate.hours;
    const drivingRemaining = hos.driving.drivingRemainingMs / 3600000;
    const cycleRemaining = hos.cycle.cycleRemainingHours;
    const achievable = neededHours <= drivingRemaining && neededHours <= cycleRemaining;
    return { neededHours, drivingRemaining, cycleRemaining, achievable };
  };
  const feasibility = checkFeasibility();

  const saveTrip = async () => {
    await base44.entities.Trip.create({
      pickup_city: pickup.city, pickup_state: pickup.state,
      pickup_appointment: pickupTime ? new Date(pickupTime).toISOString() : null,
      delivery_city: delivery.city, delivery_state: delivery.state,
      delivery_appointment: deliveryTime ? new Date(deliveryTime).toISOString() : null,
      mileage: estimate?.miles, estimated_travel_hours: estimate?.hours,
      estimated_route: estimate?.notes || '',
      is_achievable: feasibility?.achievable,
      feasibility_note: feasibility ? (feasibility.achievable ? 'Likely achievable under current HOS.' : `Not achievable. Limiting clock: ${feasibility.neededHours > feasibility.drivingRemaining ? '11-hour driving' : 'cycle'}.`) : '',
      commodity: '',
    });
    loadTrips();
  };

  if (loading) return <div className="flex justify-center h-screen items-center"><div className="w-8 h-8 border-4 border-slate-200 border-t-slate-800 rounded-full animate-spin" /></div>;

  return (
    <div className="px-4 pt-6">
      <h1 className="text-xl font-bold mb-3">Trip Planner</h1>
      <p className="text-xs text-slate-500 mb-4">Planned activity. Stops here are NOT official RODS until you confirm them when they occur.</p>

      {/* Current HOS snapshot */}
      <div className="grid grid-cols-2 gap-2 mb-4">
        <div className="rounded-xl border border-slate-200 bg-white p-3 text-sm">
          <div className="text-xs text-slate-500">Driving available</div>
          <div className="font-bold">{fmtDur(hos.driving.drivingRemainingMs)}</div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-3 text-sm">
          <div className="text-xs text-slate-500">Cycle available</div>
          <div className="font-bold">{hos.cycle.cycleRemainingHours.toFixed(1)} hr</div>
        </div>
      </div>

      {/* Trip form */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 mb-4 space-y-3">
        <div className="font-medium text-sm">Pickup</div>
        <div className="grid grid-cols-2 gap-2">
          <Input placeholder="City" value={pickup.city} onChange={(e) => setPickup({ ...pickup, city: e.target.value })} />
          <Input placeholder="ST" maxLength={2} value={pickup.state} onChange={(e) => setPickup({ ...pickup, state: e.target.value.toUpperCase() })} />
        </div>
        <Input type="datetime-local" value={pickupTime} onChange={(e) => setPickupTime(e.target.value)} />
        <div className="font-medium text-sm pt-2">Delivery</div>
        <div className="grid grid-cols-2 gap-2">
          <Input placeholder="City" value={delivery.city} onChange={(e) => setDelivery({ ...delivery, city: e.target.value })} />
          <Input placeholder="ST" maxLength={2} value={delivery.state} onChange={(e) => setDelivery({ ...delivery, state: e.target.value.toUpperCase() })} />
        </div>
        <Input type="datetime-local" value={deliveryTime} onChange={(e) => setDeliveryTime(e.target.value)} />
        <Button className="w-full" disabled={!pickup.city || !delivery.city || estimating} onClick={estimateRoute}>
          {estimating ? 'Estimating route...' : 'Estimate Route & Check Feasibility'}
        </Button>
      </div>

      {/* Estimate / feasibility result */}
      {estimate && !estimate.error && (
        <div className="rounded-xl border border-slate-200 bg-white p-4 mb-4">
          <div className="grid grid-cols-2 gap-2 text-sm mb-2">
            <div><Map className="w-4 h-4 inline mr-1" /> {estimate.miles} mi</div>
            <div><Clock className="w-4 h-4 inline mr-1" /> {estimate.hours} hr</div>
          </div>
          <p className="text-xs text-slate-500 mb-3">{estimate.notes}</p>
          {feasibility && (
            <div className={`rounded-lg p-3 ${feasibility.achievable ? 'bg-emerald-50 border border-emerald-200' : 'bg-red-50 border border-red-300'}`}>
              <div className={`font-bold flex items-center gap-1 ${feasibility.achievable ? 'text-emerald-700' : 'text-red-700'}`}>
                {feasibility.achievable ? <><Check className="w-4 h-4" /> Likely achievable</> : <><X className="w-4 h-4" /> Not achievable under current hours</>}
              </div>
              <div className="text-xs text-slate-600 mt-1">
                Need {feasibility.neededHours} hr · Have {feasibility.drivingRemaining.toFixed(1)} driving / {feasibility.cycleRemaining.toFixed(1)} cycle.
                {!feasibility.achievable && ` Stop and rest before resuming. Do not exceed limits or speed.`}
              </div>
            </div>
          )}
          <Button variant="outline" className="w-full mt-3" onClick={saveTrip}>Save Planned Trip</Button>
        </div>
      )}
      {estimate?.error && <div className="text-xs text-red-600 mb-3">Route estimate unavailable: {estimate.error}</div>}

      {/* Planned stops */}
      <div className="rounded-xl border border-slate-200 bg-white p-3 mb-4">
        <div className="flex items-center justify-between mb-2">
          <div className="font-medium text-sm">Planned Stops</div>
          <Button size="sm" variant="outline" onClick={() => setStops([...stops, { type: 'fuel', city: '', note: '' }])}>
            <Plus className="w-3.5 h-3.5 mr-1" /> Add
          </Button>
        </div>
        {stops.map((s, i) => (
          <div key={i} className="flex gap-2 mb-2">
            <select value={s.type} onChange={(e) => { const n = [...stops]; n[i].type = e.target.value; setStops(n); }} className="border rounded p-1 text-xs">
              <option value="fuel">Fuel</option><option value="rest">Rest</option><option value="break">Break</option>
            </select>
            <Input placeholder="City, ST" value={s.city} onChange={(e) => { const n = [...stops]; n[i].city = e.target.value; setStops(n); }} className="text-xs" />
          </div>
        ))}
        <p className="text-[11px] text-slate-400 mt-1">Planned stops are not official RODS. Confirm with "Log This Event" when they happen.</p>
      </div>

      {/* Saved trips */}
      <div className="space-y-2 mb-6">
        {trips.map((t) => (
          <div key={t.id} className="rounded-xl border border-slate-200 bg-white p-3 text-sm">
            <div className="font-medium">{t.pickup_city}, {t.pickup_state} → {t.delivery_city}, {t.delivery_state}</div>
            <div className="text-xs text-slate-500">{t.mileage ? `${t.mileage} mi · ${t.estimated_travel_hours} hr · ` : ''}{t.is_achievable ? 'Achievable' : 'Not achievable'}</div>
          </div>
        ))}
      </div>
    </div>
  );
}