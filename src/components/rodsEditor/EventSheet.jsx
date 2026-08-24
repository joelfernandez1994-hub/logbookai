import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Check } from 'lucide-react';
import LocationInput from '@/components/LocationInput';
import { formatHour, fmtDurationMs, formatH24 } from '@/lib/rodsEditor';

const ROW_ORDER = ['OFF_DUTY', 'SLEEPER_BERTH', 'DRIVING', 'ON_DUTY'];
const STATUS_LABELS = { OFF_DUTY: 'Off Duty', SLEEPER_BERTH: 'Sleeper', DRIVING: 'Driving', ON_DUTY: 'On Duty' };
const ACTIVITIES = ['Pre-Trip', 'Fuel', 'Loading', 'Unloading', 'Post-Trip', 'Trailer Exchange', 'Maintenance', 'Other'];

// `value`: { status, startMs, endMs, city, state, remark, activity, tractor_number, trailer_numbers }
// `onChange(patch)` updates the live draft (handles + inputs both call this).
// `onSubmit()` confirms -> opens the Proposed Change review.
export default function EventSheet({ open, value, isNew, dayStartMs, tz, carrier, equipment, onChange, onSubmit, onClose }) {
  const v = value || {};

  const startHour = v.startMs != null ? (v.startMs - dayStartMs) / 3600000 : 0;
  const endHour = v.endMs != null ? (v.endMs - dayStartMs) / 3600000 : 0;
  const dur = (v.endMs || 0) - (v.startMs || 0);

  const setTime = (which, hhmm) => {
    const [h, m] = hhmm.split(':').map(Number);
    const ms = dayStartMs + (h * 60 + m) * 60000;
    onChange(which === 'start' ? { startMs: ms } : { endMs: ms });
  };

  const setActivity = (a) => onChange({ activity: a, remark: a === 'Other' ? (v.remark || '') : a });

  const defaultTractor = equipment?.find((e) => e.is_default && e.type === 'tractor')?.unit_number || equipment?.find((e) => e.type === 'tractor')?.unit_number || '';

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isNew ? 'New Event' : 'Edit Event'} — {STATUS_LABELS[v.status]}</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          {/* status */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
            {ROW_ORDER.map((s) => (
              <button key={s} onClick={() => onChange({ status: s })}
                className={`rounded-lg border px-1 py-2 text-[11px] font-medium ${v.status === s ? 'border-primary bg-primary text-primary-foreground' : 'border-border text-card-foreground'}`}>
                {STATUS_LABELS[s]}
              </button>
            ))}
          </div>

          {/* live time readout */}
          <div className="rounded-lg bg-primary text-primary-foreground p-3 text-center">
            <div className="text-lg font-bold tabular-nums">{formatHour(startHour)} → {formatHour(endHour)}</div>
            <div className="text-xs text-primary-foreground/80 mt-0.5">{fmtDurationMs(dur)}</div>
          </div>

          {/* exact time inputs */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div>
              <Label className="text-xs">Start (24h)</Label>
              <Input type="time" value={formatH24(startHour)} onChange={(e) => setTime('start', e.target.value)} />
            </div>
            <div>
              <Label className="text-xs">End (24h)</Label>
              <Input type="time" value={formatH24(endHour)} onChange={(e) => setTime('end', e.target.value)} />
            </div>
          </div>

          {/* activity quick buttons */}
          <div>
            <Label className="text-xs">Activity</Label>
            <div className="flex flex-wrap gap-1.5 mt-1">
              {ACTIVITIES.map((a) => (
                <button key={a} onClick={() => setActivity(a)}
                  className={`rounded-full border px-2.5 py-1 text-xs ${v.activity === a ? 'border-primary bg-accent text-accent-foreground' : 'border-border text-card-foreground'}`}>
                  {a}
                </button>
              ))}
            </div>
          </div>

          {/* location */}
          <LocationInput value={{ city: v.city || '', state: v.state || '' }} onChange={onChange} showGps />

          {/* remark */}
          <div>
            <Label className="text-xs">Remark</Label>
            <Input value={v.remark || ''} onChange={(e) => onChange({ remark: e.target.value })} />
          </div>

          {/* equipment */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div>
              <Label className="text-xs">Tractor #</Label>
              <Input value={v.tractor_number ?? defaultTractor} onChange={(e) => onChange({ tractor_number: e.target.value })} />
            </div>
            <div>
              <Label className="text-xs">Trailer #</Label>
              <Input value={v.trailer_numbers || ''} onChange={(e) => onChange({ trailer_numbers: e.target.value })} />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={onSubmit}><Check className="w-4 h-4 mr-1" /> Review</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}