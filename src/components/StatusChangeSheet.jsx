import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { MapPin, Loader2 } from 'lucide-react';
import { base44 } from '@/api/base44Client';

const STATUSES = [
  { key: 'OFF_DUTY', label: 'Off Duty', color: 'bg-slate-500' },
  { key: 'SLEEPER_BERTH', label: 'Sleeper', color: 'bg-violet-600' },
  { key: 'DRIVING', label: 'Driving', color: 'bg-blue-600' },
  { key: 'ON_DUTY', label: 'On Duty', color: 'bg-orange-600' },
];

const COMMON_REMARKS = [
  'Pre-Trip Inspection', 'Fuel', 'Loading', 'Unloading', 'Post-Trip',
  'Roadside Inspection', 'Maintenance', 'Trailer Exchange', 'Drop & Hook', 'Scale', 'Other',
];

export default function StatusChangeSheet({ open, onOpenChange, onApply, defaultEquipment }) {
  const [status, setStatus] = useState('DRIVING');
  const [city, setCity] = useState('');
  const [stateVal, setStateVal] = useState('');
  const [remark, setRemark] = useState('');
  const [tractor, setTractor] = useState(defaultEquipment?.tractor || '');
  const [trailer, setTrailer] = useState(defaultEquipment?.trailer || '');
  const [locating, setLocating] = useState(false);
  const [locationConfirmed, setLocationConfirmed] = useState(false);

  const useMyLocation = () => {
    setLocating(true);
    if (!navigator.geolocation) { setLocating(false); return; }
    navigator.geolocation.getCurrentPosition(async (pos) => {
      try {
        const res = await base44.functions.invoke('reverseGeocode', { latitude: pos.coords.latitude, longitude: pos.coords.longitude });
        if (res.data?.city) setCity(res.data.city);
        if (res.data?.state) setStateVal(res.data.state);
        setLocationConfirmed(false);
      } catch (e) {}
      setLocating(false);
    }, () => setLocating(false), { enableHighAccuracy: true, timeout: 10000 });
  };

  const handleApply = () => {
    onApply({ duty_status: status, city, state: stateVal, remark, tractor_number: tractor, trailer_numbers: trailer });
    setCity(''); setStateVal(''); setRemark(''); setLocationConfirmed(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Change Duty Status</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-2">
          {STATUSES.map((s) => (
            <button key={s.key} onClick={() => setStatus(s.key)}
              className={`flex items-center gap-2 rounded-lg border p-3 text-sm font-medium transition text-card-foreground ${status === s.key ? 'border-primary bg-accent text-accent-foreground' : 'border-border'}`}>
              <span className={`w-3 h-3 rounded-full ${s.color}`} />{s.label}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3 mt-3">
          <div>
            <Label className="text-xs">City</Label>
            <Input value={city} onChange={(e) => { setCity(e.target.value); setLocationConfirmed(false); }} placeholder="City" />
          </div>
          <div>
            <Label className="text-xs">State</Label>
            <Input value={stateVal} onChange={(e) => { setStateVal(e.target.value.toUpperCase()); setLocationConfirmed(false); }} placeholder="ST" maxLength={2} />
          </div>
        </div>
        <Button variant="outline" size="sm" className="w-full mt-2" onClick={useMyLocation} disabled={locating}>
          {locating ? <><Loader2 className="w-4 h-4 mr-1 animate-spin" /> Locating...</> : <><MapPin className="w-4 h-4 mr-1" /> Use My Current Location</>}
        </Button>
        {city && !locationConfirmed && (
          <p className="text-xs text-warning">Location interpreted as {city}, {stateVal}. Please confirm or edit before applying.</p>
        )}
        <div className="mt-3">
          <Label className="text-xs">Remark (optional)</Label>
          <Input value={remark} onChange={(e) => setRemark(e.target.value)} placeholder="Remark" />
          <div className="flex flex-wrap gap-1.5 mt-2">
            {COMMON_REMARKS.map((r) => (
              <button key={r} onClick={() => setRemark(r)} className="text-[11px] px-2 py-1 rounded-full border border-border text-muted-foreground hover:bg-accent">{r}</button>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 mt-3">
          <div><Label className="text-xs">Tractor #</Label><Input value={tractor} onChange={(e) => setTractor(e.target.value)} /></div>
          <div><Label className="text-xs">Trailer #</Label><Input value={trailer} onChange={(e) => setTrailer(e.target.value)} /></div>
        </div>
        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleApply}>Set Status</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}