import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Truck } from 'lucide-react';

// Pre-trip clarification shown before a Driving period begins a new work
// period after a qualifying long rest. The driver confirms the actual start
// time, duration and location — nothing is auto-created, and no fixed
// duration is claimed to be federally required.
export default function PreTripDialog({ open, onOpenChange, drivingStart, onConfirm, onCancel, defaultCity, defaultState }) {
  const startDefault = drivingStart ? new Date(drivingStart) : new Date();
  const [duration, setDuration] = useState(15);
  const [customDur, setCustomDur] = useState('');
  const [start, setStart] = useState(toLocalInput(startDefault));
  const [city, setCity] = useState(defaultCity || '');
  const [state, setState] = useState(defaultState || '');

  const reset = () => { setDuration(15); setCustomDur(''); setStart(toLocalInput(startDefault)); setCity(defaultCity || ''); setState(defaultState || ''); };
  const close = () => { onOpenChange?.(false); reset(); };

  const mins = duration === 0 ? (parseInt(customDur, 10) || 0) : duration;
  const startMs = start ? new Date(start).getTime() : startDefault.getTime();
  const preStart = new Date(startMs - mins * 60000);

  const confirm = () => {
    onConfirm?.({
      start_timestamp: preStart.toISOString(),
      duration_min: mins,
      city, state,
    });
    reset();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) close(); else onOpenChange?.(o); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Truck className="w-4 h-4" /> Pre-Trip Check</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-slate-600">
          You are starting a Driving period. Did you perform your pre-trip vehicle inspection before driving?
        </p>
        <p className="text-[11px] text-slate-400">These are entry shortcuts — no fixed duration is federally required. Enter the actual time and location.</p>

        <div className="space-y-3 mt-1">
          <div>
            <Label className="text-xs">Pre-trip duration</Label>
            <div className="flex gap-2 mt-1">
              {[15, 30].map((m) => (
                <button key={m} onClick={() => setDuration(m)}
                  className={`flex-1 rounded-lg border px-3 py-2 text-sm ${duration === m ? 'border-slate-900 bg-slate-50 font-medium' : 'border-slate-200'}`}>{m} min</button>
              ))}
              <button onClick={() => setDuration(0)}
                className={`flex-1 rounded-lg border px-3 py-2 text-sm ${duration === 0 ? 'border-slate-900 bg-slate-50 font-medium' : 'border-slate-200'}`}>Custom</button>
            </div>
            {duration === 0 && (
              <div className="flex items-center gap-2 mt-2">
                <Input type="number" min={1} value={customDur} onChange={(e) => setCustomDur(e.target.value)} placeholder="Minutes" />
                <span className="text-xs text-slate-500">min</span>
              </div>
            )}
          </div>
          <div>
            <Label className="text-xs">Driving starts at</Label>
            <Input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div><Label className="text-xs">City</Label><Input value={city} onChange={(e) => setCity(e.target.value)} placeholder="City" /></div>
            <div><Label className="text-xs">State</Label><Input value={state} onChange={(e) => setState(e.target.value.toUpperCase())} placeholder="ST" maxLength={2} /></div>
          </div>
          {mins > 0 && (
            <p className="text-[11px] text-slate-500">Will log ON DUTY — Pre-Trip Inspection from {preStart.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} for {mins} min.</p>
          )}
        </div>

        <DialogFooter className="flex-col gap-2">
          <Button className="w-full" disabled={!mins || mins <= 0} onClick={confirm}>Yes — Add Pre-Trip</Button>
          <div className="flex gap-2 w-full">
            <Button variant="outline" className="flex-1" onClick={() => { onConfirm?.({ alreadySatisfied: true }); reset(); }}>Already recorded / satisfied</Button>
            <Button variant="ghost" className="flex-1" onClick={close}>Go Back</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function toLocalInput(d) {
  const p = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return p.toISOString().slice(0, 16);
}