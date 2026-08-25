import { useState, useEffect } from 'react';
import { Gauge, Pencil, Check, RotateCcw, Route, Sparkles } from 'lucide-react';
import { computeDailyMiles, getDailyMiles, saveDailyMiles, saveOdometers, computeSuggestedMiles, getDrivingLegs } from '@/lib/tripSync';
import { planningMph } from '@/lib/complianceStop';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

export default function DailyMilesCard({ events, dateStr, tz, speedProfile }) {
  const [override, setOverride] = useState(null);
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState('');
  const [saving, setSaving] = useState(false);
  const [suggestion, setSuggestion] = useState(null);
  const [suggesting, setSuggesting] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [beginOdo, setBeginOdo] = useState('');
  const [endOdo, setEndOdo] = useState('');

  const autoMiles = Math.round(computeDailyMiles(events, dateStr, tz, speedProfile));
  const isManual = override?.miles_source === 'manual';
  const miles = isManual ? Math.round(override?.miles ?? 0) : autoMiles;
  const mph = planningMph(speedProfile);
  const hasSuggestion = !!suggestion?.available;

  useEffect(() => {
    let mounted = true;
    setAccepted(false);
    getDailyMiles(dateStr).then(r => {
      if (!mounted) return;
      setOverride(r);
      setBeginOdo(r?.begin_odometer != null ? String(r.begin_odometer) : '');
      setEndOdo(r?.end_odometer != null ? String(r.end_odometer) : '');
    });
    return () => { mounted = false; };
  }, [dateStr, events]);

  // Auto on first open: route the day's Driving legs for a real-mileage
  // suggestion. Cached per date+legs signature so reopening re-bills nothing.
  useEffect(() => {
    let mounted = true;
    const legs = getDrivingLegs(events, dateStr, tz);
    if (!legs.length) { setSuggestion(null); setSuggesting(false); return; }
    setSuggesting(true);
    computeSuggestedMiles(events, dateStr, tz)
      .then(s => { if (mounted) setSuggestion(s); })
      .catch(() => { if (mounted) setSuggestion(null); })
      .finally(() => { if (mounted) setSuggesting(false); });
    return () => { mounted = false; };
  }, [dateStr, events, tz]);

  const save = async () => {
    const n = Number(val);
    if (isNaN(n) || n < 0) { setEditing(false); return; }
    setSaving(true);
    try { setOverride(await saveDailyMiles(dateStr, n, 'manual')); } catch (e) {}
    setEditing(false); setSaving(false);
  };

  const acceptSuggestion = async () => {
    if (!suggestion?.available || isManual) return;
    setSaving(true);
    try { setOverride(await saveDailyMiles(dateStr, suggestion.miles, 'auto')); setAccepted(true); } catch (e) {}
    setSaving(false);
  };

  const resetAuto = async () => {
    setSaving(true);
    try { setOverride(await saveDailyMiles(dateStr, autoMiles, 'auto')); } catch (e) {}
    setSaving(false);
  };

  const saveOdo = async () => {
    const storedB = override?.begin_odometer != null ? String(override.begin_odometer) : '';
    const storedE = override?.end_odometer != null ? String(override.end_odometer) : '';
    if (!override && !beginOdo && !endOdo) return;
    if (override && storedB === beginOdo && storedE === endOdo) return;
    setSaving(true);
    try { const r = await saveOdometers(dateStr, beginOdo, endOdo); if (r) setOverride(r); } catch (e) {}
    setSaving(false);
  };

  const showAccept = hasSuggestion && !isManual && !accepted && (suggestion.miles !== miles);

  return (
    <div className="rounded-xl border border-border bg-card p-3 mb-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Gauge className="w-4 h-4 text-muted-foreground" />
          <div>
            <div className="text-xs text-muted-foreground">Total Miles <span className="text-error">*</span></div>
            {editing ? (
              <div className="flex items-center gap-1 mt-0.5">
                <Input type="number" value={val} onChange={e => setVal(e.target.value)} className="w-24 h-7 text-sm" />
                <Button size="icon" className="h-7 w-7" onClick={save} disabled={saving}><Check className="w-3.5 h-3.5" /></Button>
              </div>
            ) : (
              <div className="font-bold text-sm flex items-center gap-2 mt-0.5 text-card-foreground">
                {miles} mi
                {isManual && <span className="text-[10px] text-muted-foreground font-normal">(manual)</span>}
                <button onClick={() => { setVal(String(miles)); setEditing(true); }} className="text-muted-foreground hover:text-foreground"><Pencil className="w-3 h-3" /></button>
                {isManual && <button onClick={resetAuto} disabled={saving} className="text-[10px] text-primary underline inline-flex items-center"><RotateCcw className="w-2.5 h-2.5 mr-0.5" />use auto</button>}
              </div>
            )}
          </div>
        </div>
        <div className="text-[11px] text-muted-foreground text-right">Auto est: {autoMiles} mi @ {mph} mph</div>
      </div>

      {(suggesting || hasSuggestion) && (
        <div className="mt-2 pt-2 border-t border-border">
          <div className="flex items-center gap-1.5 text-xs">
            <Route className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            {suggesting ? (
              <span className="text-muted-foreground">Calculating routed miles…</span>
            ) : suggestion.incomplete ? (
              <span className="text-warning-surface-foreground">Suggested: ~{suggestion.miles} mi · incomplete — {suggestion.legsCount - suggestion.routedCount} leg(s) missing location</span>
            ) : (
              <span className="text-muted-foreground">Suggested: {suggestion.miles} mi · {suggestion.routedCount}/{suggestion.legsCount} legs routed</span>
            )}
            {showAccept && (
              <Button size="sm" variant="outline" className="h-6 px-2 ml-auto text-[11px]" onClick={acceptSuggestion} disabled={saving}>
                <Sparkles className="w-3 h-3 mr-1" /> Accept
              </Button>
            )}
          </div>
          {isManual && hasSuggestion && !accepted && (
            <div className="text-[10px] text-muted-foreground mt-1">Suggestion shown for reference — your manual entry is kept.</div>
          )}
        </div>
      )}

      <div className="mt-2 pt-2 border-t border-border">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-[11px] text-muted-foreground">Begin Odometer (Optional)</label>
            <Input type="number" inputMode="numeric" value={beginOdo} onChange={e => setBeginOdo(e.target.value)} onBlur={saveOdo} placeholder="—" className="h-7 text-sm" />
          </div>
          <div>
            <label className="text-[11px] text-muted-foreground">End Odometer (Optional)</label>
            <Input type="number" inputMode="numeric" value={endOdo} onChange={e => setEndOdo(e.target.value)} onBlur={saveOdo} placeholder="—" className="h-7 text-sm" />
          </div>
        </div>
        <div className="text-[10px] text-muted-foreground mt-1">Optional — not required RODS fields under 49 CFR §395.8.</div>
      </div>
    </div>
  );
}