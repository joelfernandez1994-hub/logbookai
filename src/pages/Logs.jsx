import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDriverData } from '@/hooks/useDriverData';
import { getDailyGrid, computeCycle, dateKeyInTz, fmtHours, startOfDayInTz } from '@/lib/hosEngine';
import RodsGraphEditor from '@/components/rodsEditor/RodsGraphEditor';
import { getCertifications, updateEvent, deleteEvent, createHistoricalEvent } from '@/lib/driverData';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ChevronLeft, ChevronRight, BadgeCheck, AlertTriangle, Pencil, Trash2, Plus, Bot } from 'lucide-react';
import { validateProposal, hasBlocking } from '@/lib/proposalValidation';
import { useEffect } from 'react';
import DailyMilesCard from '@/components/DailyMilesCard';
import TimelineGapNotice from '@/components/TimelineGapNotice';

const STATUS_LABELS = { OFF_DUTY: 'Off Duty', SLEEPER_BERTH: 'Sleeper', DRIVING: 'Driving', ON_DUTY: 'On Duty' };
const STATUSES = ['OFF_DUTY', 'SLEEPER_BERTH', 'DRIVING', 'ON_DUTY'];

export default function Logs() {
  const { profile, carrier, equipment, events, loading, reload } = useDriverData(9);
  const navigate = useNavigate();
  const [selectedDate, setSelectedDate] = useState(() => new Date());
  const [certifications, setCertifications] = useState([]);
  const [editing, setEditing] = useState(null);
  const [adding, setAdding] = useState(false);
  const [prefill, setPrefill] = useState(null);

  const tz = carrier?.home_terminal_timezone || 'America/Chicago';
  const cycleType = carrier?.hos_cycle || '70_8';
  const speedProfile = profile?.trip_planning_speed_profile || 'conservative';

  const loadCerts = async () => {
    setCertifications(await getCertifications(9));
  };
  useEffect(() => { loadCerts(); }, []);

  // "Add record" from a timeline gap notice: prefill the Add Event dialog.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const fs = params.get('fill_start');
    const fe = params.get('fill_end');
    const date = params.get('date');
    if (date) setSelectedDate(new Date(date + 'T12:00:00'));
    if (fs) { setPrefill({ start_timestamp: fs, end_timestamp: fe }); setAdding(true); }
  }, []);

  const dateStr = useMemo(() => dateKeyInTz(selectedDate, tz), [selectedDate, tz]);
  const grid = useMemo(() => getDailyGrid(events, dateStr, tz), [events, dateStr, tz]);
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

  const saveEdit = async (data) => {
    if (isCertified && editing) {
      // preserve previous version
      await base44.entities.EventVersion.create({
        original_event_id: editing.id,
        version_number: 1,
        snapshot: { ...editing },
        edited_by: profile?.legal_name,
        action: 'edited',
      });
      // supersede existing certification
      if (cert) await base44.entities.Certification.update(cert.id, { is_superseded: true });
    }
    await updateEvent(editing.id, data);
    setEditing(null);
    reload();
    loadCerts();
  };

  const removeEvent = async (id) => {
    await deleteEvent(id);
    reload();
  };

  return (
    <div className="px-4 pt-6">
      <h1 className="text-xl font-bold mb-3">Daily Logs</h1>

      {/* Last 8 days */}
      <div className="flex gap-2 overflow-x-auto pb-2 mb-3">
        {dayKeys.map((dk) => {
          const d = new Date(dk + 'T12:00:00');
          const dc = certifications.find(c => c.log_date === dk && !c.is_superseded);
          return (
            <button key={dk} onClick={() => setSelectedDate(new Date(dk + 'T12:00:00'))}
              className={`shrink-0 rounded-lg border px-3 py-2 text-xs ${dk === dateStr ? 'border-slate-900 bg-slate-50' : 'border-slate-200'}`}>
              <div className="font-medium">{d.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric' })}</div>
              <div className="flex items-center gap-1 mt-0.5">
                {dc ? <BadgeCheck className="w-3 h-3 text-emerald-600" /> : <AlertTriangle className="w-3 h-3 text-amber-500" />}
              </div>
            </button>
          );
        })}
      </div>

      {/* Day navigation */}
      <div className="flex items-center justify-between mb-3">
        <Button variant="ghost" size="sm" onClick={() => shiftDay(-1)}><ChevronLeft className="w-4 h-4" /></Button>
        <div className="text-center">
          <div className="font-semibold">{selectedDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: tz })}</div>
          {isCertified
            ? <span className="text-xs text-emerald-600 font-medium">✓ Certified</span>
            : <span className="text-xs text-amber-600 font-medium">Needs Certification</span>}
        </div>
        <Button variant="ghost" size="sm" onClick={() => shiftDay(1)}><ChevronRight className="w-4 h-4" /></Button>
      </div>

      <TimelineGapNotice events={events} dateStr={dateStr} tz={tz} now={new Date()} />
      <DailyMilesCard events={events} dateStr={dateStr} tz={tz} speedProfile={speedProfile} />

      {/* Graph */}
      <div className="rounded-xl border border-slate-200 bg-white p-3 mb-3">
        <RodsGraphEditor events={events} dateStr={dateStr} timezone={tz} carrier={carrier} equipment={equipment} profile={profile} certifications={certifications} reload={reload} />
      </div>

      {/* Recap */}
      <div className="rounded-xl border border-slate-200 bg-white p-3 mb-3 text-sm">
        <div className="font-semibold mb-1">{cycle.cycleLimit}-Hour / {cycle.cycleDays}-Day Recap</div>
        <div className="grid grid-cols-2 gap-1 text-xs text-slate-600">
          <div>Today: {fmtHours(cycle.dailyTotals[cycle.dailyTotals.length - 1]?.onDutyHours || 0)}</div>
          <div>Last {cycle.cycleDays} days: {fmtHours(cycle.cycleUsedHours)}</div>
          <div>Available: {fmtHours(cycle.cycleRemainingHours)}</div>
          <div>Returning tomorrow: {fmtHours(cycle.returningTomorrowHours)}</div>
        </div>
      </div>

      {/* Events list */}
      <div className="rounded-xl border border-slate-200 bg-white p-3 mb-3">
        <div className="flex items-center justify-between mb-2">
          <div className="font-semibold text-sm">Events</div>
          <div className="flex gap-1">
            <Button size="sm" variant="outline" onClick={() => navigate('/log-assistant')}><Bot className="w-3.5 h-3.5 mr-1" /> Assistant</Button>
            <Button size="sm" variant="outline" onClick={() => { setPrefill(null); setAdding(true); }}><Plus className="w-3.5 h-3.5 mr-1" /> Add Event</Button>
          </div>
        </div>
        <div className="space-y-1">
          {grid.remarks.map((r, i) => (
            <div key={i} className="flex items-center gap-2 rounded-lg border border-slate-100 p-2">
              <span className="font-mono text-xs text-slate-400 w-14 shrink-0">
                {r.time.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: tz })}
              </span>
              <span className="font-semibold text-xs">{STATUS_LABELS[r.status]}</span>
              <span className="text-xs text-slate-600 flex-1 truncate">
                {[r.city, r.state].filter(Boolean).join(', ')}{r.remark ? ` — ${r.remark}` : ''}
              </span>
              <button onClick={() => setEditing(events.find(e => e.id === r.id))}><Pencil className="w-3.5 h-3.5 text-slate-400" /></button>
              <button onClick={() => removeEvent(r.id)}><Trash2 className="w-3.5 h-3.5 text-red-400" /></button>
            </div>
          ))}
          {grid.remarks.length === 0 && <div className="text-xs text-slate-400 text-center py-4">No events recorded.</div>}
        </div>
      </div>

      {/* Certify */}
      <Button className="w-full mb-6" onClick={certify} disabled={isCertified}>
        {isCertified ? 'Certified ✓' : 'Certify Log'}
      </Button>

      <EventEditor open={!!editing || adding} event={editing} prefill={prefill} onClose={() => { setEditing(null); setAdding(false); setPrefill(null); }}
        onSave={saveEdit} tz={tz} carrier={carrier} equipment={equipment} isCertified={isCertified} />
    </div>
  );
}

function EventEditor({ open, event, prefill, onClose, onSave, tz, carrier, equipment, isCertified }) {
  const pfStart = prefill?.start_timestamp ? new Date(prefill.start_timestamp).toISOString().slice(0, 16) : '';
  const pfEnd = prefill?.end_timestamp ? new Date(prefill.end_timestamp).toISOString().slice(0, 16) : '';
  const [status, setStatus] = useState(event?.duty_status || 'DRIVING');
  const [start, setStart] = useState(event ? new Date(event.start_timestamp).toISOString().slice(0, 16) : pfStart);
  const [end, setEnd] = useState(event?.end_timestamp ? new Date(event.end_timestamp).toISOString().slice(0, 16) : pfEnd);
  const [city, setCity] = useState(event?.city || '');
  const [stateVal, setStateVal] = useState(event?.state || '');
  const [remark, setRemark] = useState(event?.remark || '');

  useEffect(() => {
    setStatus(event?.duty_status || 'DRIVING');
    setStart(event ? new Date(event.start_timestamp).toISOString().slice(0, 16) : (prefill?.start_timestamp ? new Date(prefill.start_timestamp).toISOString().slice(0, 16) : ''));
    setEnd(event?.end_timestamp ? new Date(event.end_timestamp).toISOString().slice(0, 16) : (prefill?.end_timestamp ? new Date(prefill.end_timestamp).toISOString().slice(0, 16) : ''));
    setCity(event?.city || ''); setStateVal(event?.state || ''); setRemark(event?.remark || '');
  }, [event, open, prefill]);

  const save = () => {
    const data = {
      duty_status: status,
      start_timestamp: new Date(start).toISOString(),
      end_timestamp: end ? new Date(end).toISOString() : null,
      city, state: stateVal, remark,
    };
    if (event) onSave(data);
    else onSave({ ...data, log_date: new Date(start).toISOString().slice(0, 10), is_ongoing: false, is_current_version: true, method_of_creation: 'Manual', carrier_name: carrier?.carrier_name });
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>{event ? 'Edit Event' : 'Add Event'}</DialogTitle></DialogHeader>
        {isCertified && event && (
          <div className="rounded-md bg-amber-50 border border-amber-300 p-2 text-xs text-amber-900">
            This log is certified. Editing will preserve the previous version and require re-certification.
          </div>
        )}
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            {STATUSES.map((s) => (
              <button key={s} onClick={() => setStatus(s)}
                className={`rounded-lg border p-2 text-xs font-medium ${status === s ? 'border-slate-900 bg-slate-50' : 'border-slate-200'}`}>
                {STATUS_LABELS[s]}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div><Label className="text-xs">Start</Label><Input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} /></div>
            <div><Label className="text-xs">End</Label><Input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} /></div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div><Label className="text-xs">City</Label><Input value={city} onChange={(e) => setCity(e.target.value)} /></div>
            <div><Label className="text-xs">State</Label><Input value={stateVal} onChange={(e) => setStateVal(e.target.value.toUpperCase())} maxLength={2} /></div>
          </div>
          <div><Label className="text-xs">Remark</Label><Input value={remark} onChange={(e) => setRemark(e.target.value)} /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={save}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}