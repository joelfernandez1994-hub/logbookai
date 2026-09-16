import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { dutyStatusLabel } from '@/i18n';
import { dateKeyInTz } from '@/lib/hosEngine';
import { wallTimeToIso, isoToWallTime } from '@/lib/timezones';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AlertTriangle } from 'lucide-react';
import LocationInput from '@/components/LocationInput';
import TimezoneIndicator from '@/components/TimezoneIndicator';

const STATUSES = ['OFF_DUTY', 'SLEEPER_BERTH', 'DRIVING', 'ON_DUTY'];

// Shared single-event editor used by both the Logs page and Today's graph.
// `event` = existing event to edit (null when adding). `prefill` carries
// start/end timestamps (e.g. from a timeline-gap "Add record" action).
// Both Add and Edit funnel through onSave(data); the caller decides whether
// to call insertEvent or editEvent. Manual timestamps are always marked
// explicit so the route-timing fixer never moves them.
export default function EventEditor({ open, event, prefill, onClose, onSave, tz, carrier, isCertified, saving, saveError, dateStr }) {
  const { t } = useTranslation();
  const pfStart = prefill?.start_timestamp ? isoToWallTime(prefill.start_timestamp, tz) : '';
  const pfEnd = prefill?.end_timestamp ? isoToWallTime(prefill.end_timestamp, tz) : '';
  const [status, setStatus] = useState(event?.duty_status || 'DRIVING');
  const [start, setStart] = useState(event ? isoToWallTime(event.start_timestamp, tz) : (pfStart || `${dateStr}T08:00`));
  const [end, setEnd] = useState(event?.end_timestamp ? isoToWallTime(event.end_timestamp, tz) : pfEnd);
  const [city, setCity] = useState(event?.city || '');
  const [stateVal, setStateVal] = useState(event?.state || '');
  const [remark, setRemark] = useState(event?.remark || '');
  const [localError, setLocalError] = useState('');

  useEffect(() => {
    setStatus(event?.duty_status || 'DRIVING');
    setStart(event ? isoToWallTime(event.start_timestamp, tz) : (prefill?.start_timestamp ? isoToWallTime(prefill.start_timestamp, tz) : `${dateStr}T08:00`));
    setEnd(event?.end_timestamp ? isoToWallTime(event.end_timestamp, tz) : (prefill?.end_timestamp ? isoToWallTime(prefill.end_timestamp, tz) : ''));
    setCity(event?.city || ''); setStateVal(event?.state || ''); setRemark(event?.remark || '');
    setLocalError('');
  }, [event, open, prefill]);

  const save = () => {
    setLocalError('');
    if (!start) { setLocalError(t('logs.startTimeRequired')); return; }
    const startIso = wallTimeToIso(start, tz);
    const endIso = end ? wallTimeToIso(end, tz) : null;
    const startMs = startIso ? new Date(startIso).getTime() : NaN;
    const endMs = endIso ? new Date(endIso).getTime() : null;
    if (endMs != null && endMs <= startMs) { setLocalError(t('logs.endAfterStart')); return; }
    const data = {
      duty_status: status,
      start_timestamp: startIso,
      end_timestamp: endIso,
      city: city.trim(), state: stateVal.trim().toUpperCase(), remark,
      // Manual add/edit timestamps are explicit — never movable by Fix route timing.
      field_provenance: { start_time: 'explicit', end_time: 'explicit' },
    };
    if (event) onSave(data);
    else onSave({ ...data, log_date: dateKeyInTz(startIso, tz), is_ongoing: false, is_current_version: true, method_of_creation: 'Manual', carrier_name: carrier?.carrier_name });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !saving) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>{event ? t('logs.editEvent') : t('logs.addEvent')}</DialogTitle></DialogHeader>
        <TimezoneIndicator tz={tz} className="mb-1" />
        {isCertified && event && (
          <div className="rounded-md bg-warning-surface border border-warning/50 p-2 text-xs text-warning-surface-foreground">
            {t('logs.certifiedEditNote')}
          </div>
        )}
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            {STATUSES.map((s) => (
              <button key={s} onClick={() => setStatus(s)}
                className={`rounded-lg border p-2 text-xs font-medium text-card-foreground ${status === s ? 'border-primary bg-accent text-accent-foreground' : 'border-border'}`}>
                {dutyStatusLabel(s)}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div><Label className="text-xs">{t('logs.start')}</Label><Input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} /></div>
            <div><Label className="text-xs">{t('logs.end')}</Label><Input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} /></div>
          </div>
          <LocationInput
            value={{ city, state: stateVal }}
            onChange={(patch) => {
              if (patch.city !== undefined) setCity(patch.city);
              if (patch.state !== undefined) setStateVal(patch.state);
            }}
            showGps
          />
          <div><Label className="text-xs">{t('logs.remark')}</Label><Input value={remark} onChange={(e) => setRemark(e.target.value)} /></div>
        </div>
        {(localError || saveError) && (
          <div className="rounded-md bg-error-surface border border-error/50 p-2 text-xs text-error-surface-foreground flex gap-1">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> <div>{localError || saveError}</div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>{t('common.cancel')}</Button>
          <Button onClick={save} disabled={saving}>{saving ? t('common.saving') : t('common.save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}