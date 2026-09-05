import { useState, useEffect, useMemo, useCallback } from 'react';
import { useDriverData } from '@/hooks/useDriverData';
import { saveDriverProfile } from '@/lib/driverData';
import {
  getIftaMileageRecords, runIftaResolverForQuarter, confirmMileageRow,
  setDriverMileage, getFuelByJurisdiction, currentQuarter,
} from '@/lib/iftaData';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { MapPin, Fuel, CheckCircle2, RefreshCw, ChevronDown, ChevronUp, Gauge } from 'lucide-react';

function prevQuarters(n = 4) {
  const now = new Date();
  const out = [];
  let y = now.getFullYear();
  let q = Math.floor(now.getMonth() / 3) + 1;
  for (let i = 0; i < n; i++) {
    out.push(`${y}-Q${q}`);
    q -= 1;
    if (q < 1) { q = 4; y -= 1; }
  }
  return out;
}

export default function Ifta() {
  const { profile, reload } = useDriverData(9);
  const iftaEnabled = !!profile?.ifta_tracking_enabled;
  const timezone = profile?.home_terminal_timezone || 'America/Chicago';

  const [quarter, setQuarter] = useState(currentQuarter());
  const [records, setRecords] = useState([]);
  const [fuel, setFuel] = useState({ byState: [], totalGallons: 0 });
  const [loading, setLoading] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [resolveSummary, setResolveSummary] = useState(null);
  const [loadErr, setLoadErr] = useState('');
  const [expanded, setExpanded] = useState(null);
  const [editRow, setEditRow] = useState(null);
  const [editMiles, setEditMiles] = useState('');

  const loadData = useCallback(async () => {
    if (!iftaEnabled) return;
    setLoading(true);
    setLoadErr('');
    try {
      const [recs, fuelSummary] = await Promise.all([
        getIftaMileageRecords(quarter),
        getFuelByJurisdiction(quarter),
      ]);
      setRecords(recs);
      setFuel(fuelSummary);
    } catch (e) {
      setLoadErr(e?.message || 'Could not load IFTA data right now.');
    } finally {
      setLoading(false);
    }
  }, [iftaEnabled, quarter]);

  useEffect(() => { loadData(); }, [loadData]);

  const toggleIfta = async (val) => {
    await saveDriverProfile({ ...profile, ifta_tracking_enabled: val }, profile);
    setResolveSummary(null);
    reload();
  };

  const handleResolve = async () => {
    setResolving(true);
    setResolveSummary(null);
    setLoadErr('');
    try {
      const summary = await runIftaResolverForQuarter(quarter, timezone);
      setResolveSummary(summary);
      await loadData();
    } catch (e) {
      setLoadErr(e?.message || 'Background mileage resolution could not run right now. Your log is unaffected — try again later.');
    } finally {
      setResolving(false);
    }
  };

  const byJurisdiction = useMemo(() => {
    const map = new Map();
    for (const r of records) {
      if (!map.has(r.jurisdiction)) map.set(r.jurisdiction, { jurisdiction: r.jurisdiction, totalMiles: 0, confirmedMiles: 0, estimatedMiles: 0, rows: [] });
      const g = map.get(r.jurisdiction);
      g.totalMiles += Number(r.miles) || 0;
      if (r.mileage_source === 'driver_entered' || r.mileage_source === 'driver_confirmed') g.confirmedMiles += Number(r.miles) || 0;
      else g.estimatedMiles += Number(r.miles) || 0;
      g.rows.push(r);
    }
    for (const g of map.values()) g.rows.sort((a, b) => (a.log_date < b.log_date ? 1 : -1));
    return Array.from(map.values()).sort((a, b) => b.totalMiles - a.totalMiles);
  }, [records]);

  const totalMiles = byJurisdiction.reduce((s, g) => s + g.totalMiles, 0);
  const totalConfirmed = byJurisdiction.reduce((s, g) => s + g.confirmedMiles, 0);
  const totalGallons = fuel.totalGallons || 0;
  const mpg = totalGallons > 0 ? totalMiles / totalGallons : null;

  const sourceLabel = (s) => ({
    driver_entered: 'Driver entered',
    driver_confirmed: 'Driver confirmed',
    route_estimated: 'Route estimated',
    odometer_derived: 'Odometer derived',
  }[s] || s);

  const openEdit = (row) => { setEditRow(row); setEditMiles(String(row.miles ?? '')); };
  const saveEdit = async () => {
    const miles = parseFloat(editMiles);
    if (!Number.isFinite(miles) || miles < 0) return;
    await setDriverMileage({ existingRow: editRow, log_date: editRow.log_date, quarter, jurisdiction: editRow.jurisdiction, miles });
    setEditRow(null);
    loadData();
  };
  const confirmRow = async (row) => { await confirmMileageRow(row); loadData(); };

  return (
    <div className="px-4 pt-6 pb-6">
      <h1 className="text-xl font-bold mb-1 text-foreground">IFTA Mileage</h1>
      <p className="text-xs text-muted-foreground mb-4">Optional background mileage tracking for your own quarterly IFTA filing. Fully separate from your duty-status log — enabling or disabling this never changes your HOS, DVIR, BOL, or logged hours.</p>

      <div className="rounded-xl border border-border bg-card p-4 mb-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="font-semibold text-sm text-card-foreground">Enable IFTA Tracking</div>
            <div className="text-xs text-muted-foreground mt-0.5">Off by default. When on, a background process estimates state-by-state mileage from your existing trip and location data for you to review below.</div>
          </div>
          <input type="checkbox" role="switch" aria-checked={iftaEnabled} checked={iftaEnabled}
            onChange={(e) => toggleIfta(e.target.checked)} className="w-4 h-4 shrink-0" />
        </div>
      </div>

      {!iftaEnabled && (
        <div className="text-xs text-muted-foreground text-center py-8">Turn on IFTA Tracking above to see jurisdiction mileage here. Nothing else in the app changes while this is off.</div>
      )}

      {iftaEnabled && (
        <>
          <div className="flex items-center gap-2 mb-4">
            <select value={quarter} onChange={(e) => setQuarter(e.target.value)}
              className="border border-border rounded-lg p-2 text-sm bg-card text-card-foreground">
              {prevQuarters(5).map((q) => <option key={q} value={q}>{q}</option>)}
            </select>
            <Button size="sm" variant="outline" onClick={handleResolve} disabled={resolving}>
              <RefreshCw className={`w-3.5 h-3.5 mr-1 ${resolving ? 'animate-spin' : ''}`} />
              {resolving ? 'Resolving…' : 'Resolve mileage'}
            </Button>
          </div>

          {loadErr && <div className="text-xs text-warning mb-3">{loadErr}</div>}
          {resolveSummary && (
            <div className="text-[11px] text-muted-foreground mb-3">
              Resolved {resolveSummary.resolvedDays} day(s), {resolveSummary.skippedDays} already up to date
              {resolveSummary.errors?.length ? `, ${resolveSummary.errors.length} day(s) could not be resolved yet (route/location data missing — your log is unaffected).` : '.'}
            </div>
          )}

          {/* Quarter summary */}
          <div className="grid grid-cols-2 gap-3 mb-4">
            <div className="rounded-xl border border-border bg-card p-3">
              <div className="text-[11px] text-muted-foreground flex items-center gap-1"><MapPin className="w-3 h-3" /> Total miles</div>
              <div className="text-lg font-bold text-card-foreground">{totalMiles.toFixed(1)}</div>
              <div className="text-[10px] text-muted-foreground">{totalConfirmed.toFixed(1)} mi confirmed</div>
            </div>
            <div className="rounded-xl border border-border bg-card p-3">
              <div className="text-[11px] text-muted-foreground flex items-center gap-1"><Fuel className="w-3 h-3" /> Fuel (gallons)</div>
              <div className="text-lg font-bold text-card-foreground">{totalGallons.toFixed(1)}</div>
              <div className="text-[10px] text-muted-foreground">{mpg ? `${mpg.toFixed(2)} avg MPG` : 'No fuel receipts this quarter'}</div>
            </div>
          </div>

          {loading && <div className="text-xs text-muted-foreground text-center py-4">Loading…</div>}

          {!loading && byJurisdiction.length === 0 && (
            <div className="text-xs text-muted-foreground text-center py-8">No jurisdiction mileage yet for {quarter}. Tap "Resolve mileage" after logging some driving with city/state locations.</div>
          )}

          <div className="rounded-xl border border-border bg-card divide-y divide-border mb-4">
            {byJurisdiction.map((g) => {
              const allConfirmed = g.estimatedMiles <= 0.05;
              return (
                <div key={g.jurisdiction} className="p-3">
                  <button type="button" className="flex items-center justify-between w-full text-left"
                    onClick={() => setExpanded(expanded === g.jurisdiction ? null : g.jurisdiction)}>
                    <div>
                      <div className="text-sm font-semibold text-card-foreground">{g.jurisdiction} — {g.totalMiles.toFixed(1)} mi</div>
                      <div className="text-[11px] text-muted-foreground flex items-center gap-1 mt-0.5">
                        {allConfirmed ? <CheckCircle2 className="w-3 h-3 text-success" /> : <Gauge className="w-3 h-3 text-warning" />}
                        {allConfirmed ? 'Fully confirmed' : `${g.estimatedMiles.toFixed(1)} mi still estimated`}
                      </div>
                    </div>
                    {expanded === g.jurisdiction ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
                  </button>
                  {expanded === g.jurisdiction && (
                    <div className="mt-2 space-y-1.5">
                      {g.rows.map((r) => (
                        <div key={r.id} className="flex items-center justify-between text-xs bg-accent/40 rounded-lg p-2">
                          <div>
                            <div className="text-card-foreground font-medium">{r.log_date}</div>
                            <div className="text-muted-foreground">{r.miles?.toFixed?.(1) ?? r.miles} mi — {sourceLabel(r.mileage_source)}</div>
                          </div>
                          <div className="flex items-center gap-2">
                            {(r.mileage_source === 'route_estimated' || r.mileage_source === 'odometer_derived') && (
                              <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={() => confirmRow(r)}>Confirm</Button>
                            )}
                            <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" onClick={() => openEdit(r)}>Edit</Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {fuel.byState?.length > 0 && (
            <div className="rounded-xl border border-border bg-card p-3 mb-4">
              <div className="text-xs font-semibold text-card-foreground mb-2 flex items-center gap-1"><Fuel className="w-3.5 h-3.5" /> Fuel by jurisdiction</div>
              <div className="space-y-1">
                {fuel.byState.map((f) => (
                  <div key={f.jurisdiction} className="flex items-center justify-between text-xs text-card-foreground">
                    <span>{f.jurisdiction}</span>
                    <span className="text-muted-foreground">{f.gallons.toFixed(1)} gal</span>
                  </div>
                ))}
              </div>
              <div className="text-[10px] text-muted-foreground mt-2">Pulled automatically from your logged fuel receipts — nothing to enter twice.</div>
            </div>
          )}

          <div className="text-[11px] text-muted-foreground space-y-1 mb-2">
            <p>Route-estimated mileage is calculated from mapped roads and may not match your actual driven path or odometer. Review and confirm before filing.</p>
            <p>LogbookAI does not file IFTA reports with any jurisdiction — this screen organizes your mileage and fuel data for your own filing.</p>
          </div>
        </>
      )}

      <Dialog open={!!editRow} onOpenChange={(o) => !o && setEditRow(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>{editRow?.jurisdiction} — {editRow?.log_date}</DialogTitle></DialogHeader>
          <div className="space-y-2">
            <Label>Miles</Label>
            <Input type="number" value={editMiles} onChange={(e) => setEditMiles(e.target.value)} />
            <p className="text-[11px] text-muted-foreground">Saving this replaces the estimate with your own figure for this day and jurisdiction. It never changes your duty-status log.</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditRow(null)}>Cancel</Button>
            <Button onClick={saveEdit}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
