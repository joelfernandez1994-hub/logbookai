import { useState, useEffect } from 'react';
import { Gauge, Pencil, Check, RotateCcw } from 'lucide-react';
import { computeDailyMiles, getDailyMiles, saveDailyMiles } from '@/lib/tripSync';
import { planningMph } from '@/lib/complianceStop';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

export default function DailyMilesCard({ events, dateStr, tz, speedProfile }) {
  const [override, setOverride] = useState(null);
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState('');
  const [saving, setSaving] = useState(false);

  const autoMiles = Math.round(computeDailyMiles(events, dateStr, tz, speedProfile));
  const isManual = override?.miles_source === 'manual';
  const miles = isManual ? Math.round(override.miles) : autoMiles;
  const mph = planningMph(speedProfile);

  useEffect(() => {
    let mounted = true;
    getDailyMiles(dateStr).then(r => { if (mounted) setOverride(r); });
    return () => { mounted = false; };
  }, [dateStr, events]);

  const save = async () => {
    const n = Number(val);
    if (isNaN(n) || n < 0) { setEditing(false); return; }
    setSaving(true);
    try { setOverride(await saveDailyMiles(dateStr, n, 'manual')); } catch (e) {}
    setEditing(false); setSaving(false);
  };

  const resetAuto = async () => {
    setSaving(true);
    try { setOverride(await saveDailyMiles(dateStr, autoMiles, 'auto')); } catch (e) {}
    setSaving(false);
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3 mb-3 flex items-center justify-between">
      <div className="flex items-center gap-2">
        <Gauge className="w-4 h-4 text-slate-500" />
        <div>
          <div className="text-xs text-slate-500">Daily miles</div>
          {editing ? (
            <div className="flex items-center gap-1 mt-0.5">
              <Input type="number" value={val} onChange={e => setVal(e.target.value)} className="w-24 h-7 text-sm" />
              <Button size="icon" className="h-7 w-7" onClick={save} disabled={saving}><Check className="w-3.5 h-3.5" /></Button>
            </div>
          ) : (
            <div className="font-bold text-sm flex items-center gap-2 mt-0.5">
              {miles} mi
              {isManual && <span className="text-[10px] text-slate-400 font-normal">(manual)</span>}
              <button onClick={() => { setVal(String(miles)); setEditing(true); }} className="text-slate-400 hover:text-slate-700"><Pencil className="w-3 h-3" /></button>
              {isManual && <button onClick={resetAuto} disabled={saving} className="text-[10px] text-blue-500 underline inline-flex items-center"><RotateCcw className="w-2.5 h-2.5 mr-0.5" />use auto</button>}
            </div>
          )}
        </div>
      </div>
      <div className="text-[11px] text-slate-400 text-right">
        Auto: {autoMiles} mi<br />from logged driving @ {mph} mph
      </div>
    </div>
  );
}