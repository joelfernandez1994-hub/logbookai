import { useState, useMemo } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useDriverData } from '@/hooks/useDriverData';
import { computeCycle, dateKeyInTz, fmtHours } from '@/lib/hosEngine';
import { getDisplayGrid } from '@/lib/timelineDisplay';
import RodsGraphEditor from '@/components/rodsEditor/RodsGraphEditor';
import { getCertifications } from '@/lib/driverData';
import { base44 } from '@/api/base44Client';
import { insertEvent, editEvent, deleteEventById, clearDayEvents } from '@/lib/timelineWriter';
import { validateTimeline } from '@/lib/timelineEngine';
import LocationInput from '@/components/LocationInput';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ChevronLeft, ChevronRight, BadgeCheck, AlertTriangle, Pencil, Trash2, Plus, Bot, Eraser } from 'lucide-react';
import { validateProposal, hasBlocking } from '@/lib/proposalValidation';
import { useEffect } from 'react';
import DailyMilesCard from '@/components/DailyMilesCard';
import TimelineGapNotice from '@/components/TimelineGapNotice';
import PullToRefresh from '@/components/PullToRefresh';
import TimezoneIndicator from '@/components/TimezoneIndicator';
import { wallTimeToIso, isoToWallTime } from '@/lib/timezones';

const STATUS_LABELS = { OFF_DUTY: 'Off Duty', SLEEPER_BERTH: 'Sleeper', DRIVING: 'Driving', ON_DUTY: 'On Duty' };
const STATUSES = ['OFF_DUTY', 'SLEEPER_BERTH', 'DRIVING', 'ON_DUTY'];

export default function Logs() {
  const { profile, carrier, equipment, events, loading, reload } = useDriverData(9);
  const navigate = useNavigate();
  const location = useLocation();
  const [selectedDate, setSelectedDate] = useState(() => new Date());
  const [certifications, setCertifications] = useState([]);
  const [editing, setEditing] = useState(null);
  const [adding, setAdding] = useState(false);
  const [prefill, setPrefill] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);

  const tz = carrier?.home_terminal_timezone || 'America/Chicago';
  const cycleType = carrier?.hos_cycle || '70_8';
  const speedProfile = profile?.trip_planning_speed_profile || 'conservative';

  const loadCerts = async () => {
    setCertifications(await getCertifications(9));
  };
  useEffect(() => { loadCerts(); }, []);

  // "Add record" from a timeline gap notice: prefill the Add Event dialog.
  // "Add record" from a timeline gap notice: prefill the Add Event dialog.
  // Depend on location.search so tapping "Add record" while already on /logs
  // (where the gap notice also appears) re-opens the editor for the new gap.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const fs = params.get('fill_start');
    const fe = params.get('fill_end');
    const date = params.get('date');
    if (date) setSelectedDate(new Date(date + 'T12:00:00'));
    if (fs) { setPrefill({ start_timestamp: fs, end_timestamp: fe }); setAdding(true); }
  }, [location.search]);

  const dateStr = useMemo(() => dateKeyInTz(selectedDate, tz), [selectedDate, tz]);
  const grid = useMemo(() => getDisplayGrid(events, dateStr, tz), [events, dateStr, tz]);
  const cycle = useMemo(() => computeCycle(events, cycleType, tz, selectedDate), [events, cycleType, tz, selectedDate]);

  const cert = certifications.find(c => c.log_date === dateStr && !c.is_superseded);
  const isCertified = !!cert;

  const dayKeys = useMemo(() => {
    const days = [];
    for (let i = 0; i < 8; i++) {
      const d = new Date(Date.now() - i * 24 * 3600000);
      days.push(dateKeyInTz(d, tz));
    }
    return days;
  }, [tz]);

  const shiftDay = (delta) => {
    setSelectedDate(new Date(selectedDate.getTime() + delta * 24 * 3600000));
  };

  const certify = async () => {
    await base44.entities.Certification.create({
      log_date: dateStr,
      certified_at: new Date().toISOString(),
      signature_data: profile?.signature_data || '',
      signature_name: profile?.legal_name || '',
    });
    await loadCerts();
  };

  // Both Add and Edit funnel through this single handler. The canonical writer
  // computes ops (split/truncate/dedupe), applies them, preserves an audit
  // version snapshot if the day was certified, and invalidates the certification.
  const saveEvent = async (data) => {
    setSaving(true); setSaveError('');
    try {
      let res;
      if (editing) {
        res = await editEvent(events, editing.id, data, {
          editedBy: profile?.legal_name, reason: 'Manual edit', carrierName: carrier?.carrier_name,
        });
      } else {
        res = await insertEvent(events, {
          ...data,
          log_date: dateKeyInTz(data.start_timestamp, tz),
          is_ongoing: false,
          method_of_creation: 'Manual',
        }, { editedBy: profile?.legal_name, reason: 'Manual add', carrierName: carrier?.carrier_name });
      }
      if (res?.error) { setSaveError(res.error); return; }
      setEditing(null); setAdding(false); setPrefill(null);
      if (location.search) navigate('/logs', { replace: true });
      await reload(); await loadCerts();
    } catch (e) {
      setSaveError(e?.message || 'Failed to save event. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const removeEvent = async (id) => {
    try {
      await deleteEventById(events, id, { editedBy: profile?.legal_name, reason: 'Manual delete' });
      await reload(); await loadCerts();
    } catch (e) { /* error shown via reload state */ }
  };

  const doClearDay = async () => {
    setClearing(true);
    try {
      await clearDayEvents(events, dateStr, tz, { editedBy: profile?.legal_name, reason: 'Clear day log' });
      setConfirmClear(false);
      await reload(); await loadCerts();
    } catch (e) {
      setSaveError(e?.message || 'Failed to clear day. Please try again.');
    } finally {
      setClearing(false);
    }
  };

  return (
    <PullToRefresh onRefresh={reload} className="px-4 pt-6" data-client-version="logs-canonical-timeline-v3">
      <h1 data-client-version="logs-canonical-timeline-v3" className="text-xl font-bold mb-3 text-foreground">Daily Logs</h1>

      <div className="flex gap-2 overflow-x-auto no-scrollbar pb-2 mb-3">
        {dayKeys.map((dk) => {
          const d = new Date(dk + 'T12:00:00');
          const dc = certifications.find(c => c.log_date === dk && !c.is_superseded);
          return (
            <button key={dk} onClick={() => setSelectedDate(new Date(dk + 'T12:00:00'))}
              className={`shrink-0 rounded-lg border px-3 py-2 text-xs text-card-foreground ${dk === dateStr ? 'border-primary bg-accent text-accent-foreground' : 'border-border'}`}>
              <div className="font-medium">{d.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric' })}</div>
              <div className="flex items-center gap-1 mt-0.5">
                {dc ? <BadgeCheck className="w-3 h-3 text-success" /> : <AlertTriangle className="w-3 h-3 text-warning" />}
              </div>
            </button>
          );
        })}
      </div>

      <div className="flex items-center justify-between mb-3">
        <Button variant="ghost" size="sm" onClick={() => shiftDay(-1)}><ChevronLeft className="w-4 h-4" /></Button>
        <div className="text-center">
          <div className="font-semibold text-foreground">{selectedDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: tz })}</div>
          {isCertified
            ? <span className="text-xs text-success font-medium">✓ Certified</span>
            : <span className="text-xs text-warning font-medium">Needs Certification</span>}
        </div>
        <Button variant="ghost" size="sm" onClick={() => shiftDay(1)}><ChevronRight className="w-4 h-4" /></Button>
      </div>

      <TimelineGapNotice events={events} dateStr={dateStr} tz={tz} now={new Date()} />
      <DailyMilesCard events={events} dateStr={dateStr} tz={tz} speedProfile={speedProfile} />

      <div className="rounded-xl border border-border bg-card p-3 mb-3">
        <TimezoneIndicator tz={tz} className="mb-2" />
        <RodsGraphEditor events={events} dateStr={dateStr} timezone={tz} carrier={carrier} equipment={equipment} profile={profile} certifications={certifications} reload={reload} />
      </div>

      <div className="rounded-xl border border-border bg-card p-3 mb-3 text-sm">
        <div className="font-semibold mb-1 text-card-foreground">{cycle.cycleLimit}-Hour / {cycle.cycleDays}-Day Recap</div>
        <div className="grid grid-cols-2 gap-1 text-xs text-muted-foreground">
          <div>Today: {fmtHours(cycle.dailyTotals[cycle.dailyTotals.length - 1]?.onDutyHours || 0)}</div>
          <div>Last {cycle.cycleDays} days: {fmtHours(cycle.cycleUsedHours)}</div>
          <div>Available: {fmtHours(cycle.cycleRemainingHours)}</div>
          <div>Returning tomorrow: {fmtHours(cycle.returningTomorrowHours)}</div>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card p-3 mb-3">
        <div className="flex items-center justify-between mb-2">
          <div className="font-semibold text-sm text-card-foreground">Events</div>
          <div className="flex gap-1">
            <Button size="sm" variant="outline" onClick={() => navigate('/log-assistant', { state: { returnTo: '/logs' } })}><Bot className="w-3.5 h-3.5 mr-1" /> Assistant</Button>
            <Button size="sm" variant="outline" onClick={() => { setPrefill(null); setAdding(true); }}><Plus className="w-3.5 h-3.5 mr-1" /> Add Event</Button>
          </div>
        </div>
        <div className="space-y-1">
          {grid.remarks.map((r, i) => (
            <div key={i} className="flex items-center gap-2 rounded-lg border border-border p-2">
              <span className="font-mono text-xs text-muted-foreground w-14 shrink-0">
                {r.time.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: tz })}
              </span>
              <span className="font-semibold text-xs text-card-foreground">{STATUS_LABELS[r.status]}</span>
              <span className="text-xs text-muted-foreground flex-1 truncate">
                {[r.city, r.state].filter(Boolean).join(', ')}{r.remark ? ` — ${r.remark}` : ''}
              </span>
              <button onClick={() => setEditing(events.find(e => e.id === r.id))} className="inline-flex items-center justify-center min-h-[44px] min-w-[44px] text-muted-foreground hover:text-foreground"><Pencil className="w-3.5 h-3.5" /></button>
              <button onClick={() => removeEvent(r.id)} className="inline-flex items-center justify-center min-h-[44px] min-w-[44px] text-error hover:opacity-80"><Trash2 className="w-3.5 h-3.5" /></button>
            </div>
          ))}
          {grid.remarks.length === 0 && <div className="text-xs text-muted-foreground text-center py-4">No events recorded.</div>}
        </div>
      </div>

      <Button className="w-full mb-2" onClick={certify} disabled={isCertified}>
        {isCertified ? 'Certified ✓' : 'Certify Log'}
      </Button>
      <Button variant="outline" className="w-full mb-2 text-error border-error/40 hover:bg-error-surface" disabled={clearing} onClick={() => setConfirmClear(true)}>
        <Eraser className="w-4 h-4 mr-2" /> {clearing ? 'Clearing…' : 'Clear Day Log'}
      </Button>

      <EventEditor open={!!editing || adding} event={editing} prefill={prefill} saving={saving} saveError={saveError}
        onClose={() => { setEditing(null); setAdding(false); setPrefill(null); setSaveError(''); if (location.search) navigate('/logs', { replace: true }); }}
        onSave={saveEvent} tz={tz} carrier={carrier} equipment={equipment} isCertified={isCertified} dateStr={dateStr} />

      <Dialog open={confirmClear} onOpenChange={(o) => !clearing && setConfirmClear(o)}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle className="flex items-center gap-2"><AlertTriangle className="w-5 h-5 text-error" /> Clear {selectedDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: tz })} Log?</DialogTitle></DialogHeader>
          <div className="text-sm text-muted-foreground space-y-2">
            <p>This will permanently remove all log events for <b>{selectedDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: tz })}</b>.</p>
            <p>Events that cross midnight into an adjacent day are split — the adjacent day's records are preserved. Certification for this day is invalidated, and the graph, totals, mileage, HOS, and cycle recap recalculate automatically.</p>
            <p className="text-error font-medium">This cannot be undone.</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmClear(false)} disabled={clearing}>Cancel</Button>
            <Button variant="destructive" onClick={doClearDay} disabled={clearing}>{clearing ? 'Clearing…' : 'Clear Entire Day'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PullToRefresh>
  );
}

function EventEditor({ open, event, prefill, onClose, onSave, tz, carrier, equipment, isCertified, saving, saveError, dateStr }) {
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
    if (!start) { setLocalError('Start time is required.'); return; }
    const startIso = wallTimeToIso(start, tz);
    const endIso = end ? wallTimeToIso(end, tz) : null;
    const startMs = startIso ? new Date(startIso).getTime() : NaN;
    const endMs = endIso ? new Date(endIso).getTime() : null;
    if (endMs != null && endMs <= startMs) { setLocalError('End time must be after the start time.'); return; }
    const data = {
      duty_status: status,
      start_timestamp: startIso,
      end_timestamp: endIso,
      city: city.trim(), state: stateVal.trim().toUpperCase(), remark,
    };
    if (event) onSave(data);
    else onSave({ ...data, log_date: dateKeyInTz(startIso, tz), is_ongoing: false, is_current_version: true, method_of_creation: 'Manual', carrier_name: carrier?.carrier_name });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !saving) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>{event ? 'Edit Event' : 'Add Event'}</DialogTitle></DialogHeader>
        <TimezoneIndicator tz={tz} className="mb-1" />
        {isCertified && event && (
          <div className="rounded-md bg-warning-surface border border-warning/50 p-2 text-xs text-warning-surface-foreground">
            This log is certified. Editing will preserve the previous version in audit history and mark this day as needing re-certification.
          </div>
        )}
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            {STATUSES.map((s) => (
              <button key={s} onClick={() => setStatus(s)}
                className={`rounded-lg border p-2 text-xs font-medium text-card-foreground ${status === s ? 'border-primary bg-accent text-accent-foreground' : 'border-border'}`}>
                {STATUS_LABELS[s]}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div><Label className="text-xs">Start</Label><Input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} /></div>
            <div><Label className="text-xs">End</Label><Input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} /></div>
          </div>
          <LocationInput
            value={{ city, state: stateVal }}
            onChange={(patch) => {
              if (patch.city !== undefined) setCity(patch.city);
              if (patch.state !== undefined) setStateVal(patch.state);
            }}
            showGps
          />
          <div><Label className="text-xs">Remark</Label><Input value={remark} onChange={(e) => setRemark(e.target.value)} /></div>
        </div>
        {(localError || saveError) && (
          <div className="rounded-md bg-error-surface border border-error/50 p-2 text-xs text-error-surface-foreground flex gap-1">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> <div>{localError || saveError}</div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}