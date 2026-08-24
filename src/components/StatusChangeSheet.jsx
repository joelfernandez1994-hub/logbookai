import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import LocationInput from '@/components/LocationInput';

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
  const [locationConfirmed, setLocationConfirmed] = useState(false);

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
        <div className="mt-3">
          <LocationInput
            value={{ city, state: stateVal }}
            onChange={(patch) => { if (patch.city !== undefined) setCity(patch.city); if (patch.state !== undefined) setStateVal(patch.state); setLocationConfirmed(false); }}
            showGps
          />
        </div>
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