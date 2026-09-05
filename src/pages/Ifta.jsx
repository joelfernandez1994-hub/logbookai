import { useState, useEffect, useMemo, useCallback } from 'react';
import { useDriverData } from '@/hooks/useDriverData';
import { saveDriverProfile } from '@/lib/driverData';
import {
  getQuarterlyReport, runIftaResolverForQuarter, confirmMileageRow,
  setDriverMileage, currentQuarter, recomputeDayForQuarter,
  findMileageRow, applyFuelEntryProposal,
} from '@/lib/iftaData';
import { parseIftaCommand } from '@/lib/iftaAssistant';
import { quarterOf } from '@/lib/iftaResolver';
import { generateIftaReportPdf } from '@/lib/iftaPdf';
import { generateIftaCsv } from '@/lib/iftaCsv';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { MapPin, Fuel, CheckCircle2, RefreshCw, ChevronDown, ChevronUp, Gauge, RotateCcw, FileDown, FileSpreadsheet, Sparkles, Send } from 'lucide-react';

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
  const { profile, carrier, reload } = useDriverData(9);
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
  const [recalcDate, setRecalcDate] = useState(null);
  const [recalcReplaceConfirmed, setRecalcReplaceConfirmed] = useState(false);
  const [recalcRunning, setRecalcRunning] = useState(false);
  const [recalcResult, setRecalcResult] = useState(null);

  const [report, setReport] = useState(null);

  // --- Phase 3: AI IFTA assistant state ---
  const [aiText, setAiText] = useState('');
  const [aiParsed, setAiParsed] = useState(null); // last parseIftaCommand() result
  const [aiExtra, setAiExtra] = useState(null); // fetched data for summary/unconfirmed_query/mileage-correction lookups
  const [aiBusy, setAiBusy] = useState(false);
  const [aiMessage, setAiMessage] = useState('');
  const [aiReplaceConfirmed, setAiReplaceConfirmed] = useState(false);

  const loadData = useCallback(async () => {
    if (!iftaEnabled) return;
    setLoading(true);
    setLoadErr('');
    try {
      const { records: recs, fuel: fuelSummary, report: rep } = await getQuarterlyReport(quarter);
      setRecords(recs);
      setFuel(fuelSummary);
      setReport(rep);
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

  // Read straight from the same report object the PDF/CSV exports use, so
  // the numbers on screen can never drift from what gets exported.
  const totalMiles = report?.totalMiles ?? 0;
  const totalConfirmed = report?.totalConfirmedMiles ?? 0;
  const totalGallons = report?.totalGallons ?? (fuel.totalGallons || 0);
  const mpg = report?.mpg ?? null;

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

  const [exportErr, setExportErr] = useState('');
  const downloadPdf = () => {
    if (!report) return;
    setExportErr('');
    try {
      const doc = generateIftaReportPdf(report, { driver: profile, carrier });
      doc.save(`LogbookAI_IFTA_${quarter}.pdf`);
    } catch (e) {
      setExportErr('Could not build the PDF right now.');
    }
  };
  const downloadCsv = () => {
    if (!report) return;
    setExportErr('');
    try {
      const csv = generateIftaCsv({ quarter, records, fuel, report });
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `LogbookAI_IFTA_${quarter}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      setExportErr('Could not build the CSV right now.');
    }
  };

  // --- Phase 3: AI IFTA assistant handlers ---
  // Interpretation is deterministic (parseIftaCommand) and never writes
  // anything by itself. A write only ever happens from handleAiApply, after
  // the driver has seen the exact proposal and tapped Apply.
  const handleAiAsk = async () => {
    const text = aiText.trim();
    if (!text) return;
    setAiBusy(true);
    setAiMessage('');
    setAiExtra(null);
    setAiReplaceConfirmed(false);
    try {
      const parsed = parseIftaCommand(text, { now: new Date(), quarter });
      setAiParsed(parsed);
      if (parsed.type === 'summary') {
        const data = await getQuarterlyReport(parsed.quarter);
        setAiExtra(data);
      } else if (parsed.type === 'unconfirmed_query') {
        const data = await getQuarterlyReport(parsed.quarter);
        const unconfirmed = data.records.filter((r) => r.mileage_source === 'route_estimated' || r.mileage_source === 'odometer_derived');
        setAiExtra({ ...data, unconfirmed });
      } else if (parsed.type === 'mileage_correction') {
        const { existingRow } = await findMileageRow(parsed.proposal);
        setAiExtra({ existingRow });
      }
    } catch (e) {
      setAiMessage(e?.message || 'Could not process that request right now. Your log is unaffected.');
    } finally {
      setAiBusy(false);
    }
  };

  const clearAi = () => { setAiText(''); setAiParsed(null); setAiExtra(null); setAiMessage(''); setAiReplaceConfirmed(false); };

  const handleAiApply = async () => {
    if (!aiParsed) return;
    setAiBusy(true);
    setAiMessage('');
    try {
      if (aiParsed.type === 'fuel_entry') {
        await applyFuelEntryProposal(aiParsed.proposal);
        setAiMessage(`Logged ${aiParsed.proposal.gallons} gal in ${aiParsed.proposal.city}, ${aiParsed.proposal.state}.`);
      } else if (aiParsed.type === 'mileage_correction') {
        const existingRow = aiExtra?.existingRow || null;
        const isConfirmed = existingRow && (existingRow.mileage_source === 'driver_entered' || existingRow.mileage_source === 'driver_confirmed');
        if (isConfirmed && !aiReplaceConfirmed) {
          setAiMessage('This would replace a previously confirmed value — check the box below to confirm you want to replace it.');
          setAiBusy(false);
          return;
        }
        await setDriverMileage({ existingRow, ...aiParsed.proposal });
        setAiMessage(`Set ${aiParsed.proposal.jurisdiction} mileage for ${aiParsed.proposal.log_date} to ${aiParsed.proposal.miles} mi.`);
      } else if (aiParsed.type === 'recalculate_day') {
        const summary = await recomputeDayForQuarter({ logDate: aiParsed.proposal.log_date, quarter: quarterOf(aiParsed.proposal.log_date), timezone, replaceConfirmed: aiReplaceConfirmed });
        setAiMessage(`Recalculated ${aiParsed.proposal.log_date}: ${summary.updated.length} updated, ${summary.preserved.length} preserved.`);
      }
      await loadData();
      setAiParsed(null);
      setAiExtra(null);
    } catch (e) {
      setAiMessage(e?.message || 'Could not apply that right now. Your log is unaffected.');
    } finally {
      setAiBusy(false);
    }
  };

  // Rows for the day open in the "Recalculate day" dialog, across ALL
  // jurisdictions — a day can touch more than one state, and recomputing it
  // should refresh every jurisdiction for that date together.
  const recalcDayRows = useMemo(() => records.filter((r) => r.log_date === recalcDate), [records, recalcDate]);
  const recalcConfirmedCount = recalcDayRows.filter((r) => r.mileage_source === 'driver_entered' || r.mileage_source === 'driver_confirmed').length;

  const openRecalc = (logDate) => { setRecalcDate(logDate); setRecalcReplaceConfirmed(false); setRecalcResult(null); };
  const runRecalc = async () => {
    setRecalcRunning(true);
    setRecalcResult(null);
    try {
      const summary = await recomputeDayForQuarter({ logDate: recalcDate, quarter, timezone, replaceConfirmed: recalcReplaceConfirmed });
      setRecalcResult(summary);
      await loadData();
    } catch (e) {
      setRecalcResult({ updated: [], preserved: [], errors: [{ reason: e?.message || 'Could not recalculate this day right now. Your log is unaffected.' }] });
    } finally {
      setRecalcRunning(false);
    }
  };

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

          <div className="flex items-center gap-2 mb-4">
            <Button size="sm" variant="outline" onClick={downloadPdf} disabled={!report}>
              <FileDown className="w-3.5 h-3.5 mr-1" /> Export PDF
            </Button>
            <Button size="sm" variant="outline" onClick={downloadCsv} disabled={!report}>
              <FileSpreadsheet className="w-3.5 h-3.5 mr-1" /> Export CSV
            </Button>
          </div>
          {exportErr && <div className="text-xs text-warning mb-3">{exportErr}</div>}

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
                            <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" title="Recalculate this day from your current log" onClick={() => openRecalc(r.log_date)}>
                              <RotateCcw className="w-3 h-3" />
                            </Button>
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

          <div className="rounded-xl border border-border bg-card p-4 mb-4">
            <div className="text-sm font-semibold text-card-foreground mb-2 flex items-center gap-1"><Sparkles className="w-4 h-4" /> Ask about IFTA</div>
            <div className="flex items-center gap-2">
              <Input value={aiText} onChange={(e) => setAiText(e.target.value)} placeholder='e.g. "Change Georgia mileage for September 4 to 215 miles"'
                onKeyDown={(e) => { if (e.key === 'Enter') handleAiAsk(); }} />
              <Button size="sm" onClick={handleAiAsk} disabled={aiBusy || !aiText.trim()}><Send className="w-3.5 h-3.5" /></Button>
            </div>
            <div className="text-[10px] text-muted-foreground mt-1">Try: "Review my IFTA for Q3" · "Which mileage still needs confirmation?" · "I fueled 126 gallons in Tifton, GA" · "Change Georgia mileage for September 4 to 215 miles" · "Recalculate September 4"</div>

            {aiParsed && (
              <div className="mt-3 text-xs space-y-2">
                {aiParsed.type === 'clarify' && (
                  <div className="text-card-foreground">{aiParsed.question}</div>
                )}
                {aiParsed.type === 'unrecognized' && (
                  <div className="text-muted-foreground">I didn't catch that as an IFTA command. Try one of the examples above.</div>
                )}
                {aiParsed.type === 'summary' && aiExtra?.report && (
                  <div className="space-y-1 text-card-foreground">
                    <div className="font-medium">{aiParsed.quarter}: {aiExtra.report.totalMiles} mi total across {aiExtra.report.jurisdictions.length} jurisdiction(s), {aiExtra.report.totalGallons} gal fuel{aiExtra.report.mpg ? `, ${aiExtra.report.mpg} MPG` : ''}.</div>
                    {aiExtra.report.fullyConfirmed
                      ? <div className="text-success">All mileage for this quarter is confirmed.</div>
                      : <div className="text-warning">{aiExtra.report.jurisdictions.filter((j) => !j.fullyConfirmed).map((j) => j.jurisdiction).join(', ')} still {aiExtra.report.jurisdictions.filter((j) => !j.fullyConfirmed).length > 1 ? 'have' : 'has'} estimated mileage.</div>}
                  </div>
                )}
                {aiParsed.type === 'unconfirmed_query' && aiExtra && (
                  aiExtra.unconfirmed.length === 0
                    ? <div className="text-success">Nothing needs confirmation for {aiParsed.quarter}.</div>
                    : (
                      <div className="space-y-1">
                        {aiExtra.unconfirmed.map((r) => (
                          <div key={r.id} className="flex items-center justify-between text-card-foreground bg-accent/40 rounded p-1.5">
                            <span>{r.jurisdiction} — {r.log_date} — {r.miles} mi ({sourceLabel(r.mileage_source)})</span>
                            <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" onClick={() => confirmRow(r)}>Confirm</Button>
                          </div>
                        ))}
                      </div>
                    )
                )}
                {(aiParsed.type === 'fuel_entry' || aiParsed.type === 'mileage_correction' || aiParsed.type === 'recalculate_day') && (
                  <div className="rounded-lg border border-primary/30 bg-accent/30 p-2.5 space-y-2">
                    <div className="font-medium text-card-foreground">
                      {aiParsed.type === 'fuel_entry' && `Log fuel: ${aiParsed.proposal.gallons} gal — ${aiParsed.proposal.city}, ${aiParsed.proposal.state} — ${aiParsed.proposal.receipt_date}`}
                      {aiParsed.type === 'mileage_correction' && `Set ${aiParsed.proposal.jurisdiction} mileage for ${aiParsed.proposal.log_date} to ${aiParsed.proposal.miles} mi`}
                      {aiParsed.type === 'recalculate_day' && `Recalculate mileage for ${aiParsed.proposal.log_date}`}
                    </div>
                    {aiParsed.type === 'mileage_correction' && aiExtra?.existingRow && (
                      <div className="text-[11px] text-warning">
                        This replaces the existing value of {aiExtra.existingRow.miles} mi ({sourceLabel(aiExtra.existingRow.mileage_source)}){(aiExtra.existingRow.mileage_source === 'driver_entered' || aiExtra.existingRow.mileage_source === 'driver_confirmed') ? ' — a previously CONFIRMED value.' : '.'}
                      </div>
                    )}
                    {((aiParsed.type === 'mileage_correction' && aiExtra?.existingRow && (aiExtra.existingRow.mileage_source === 'driver_entered' || aiExtra.existingRow.mileage_source === 'driver_confirmed')) || aiParsed.type === 'recalculate_day') && (
                      <label className="flex items-start gap-2 text-[11px] text-card-foreground">
                        <input type="checkbox" className="mt-0.5 w-4 h-4" checked={aiReplaceConfirmed} onChange={(e) => setAiReplaceConfirmed(e.target.checked)} />
                        <span>{aiParsed.type === 'recalculate_day' ? 'Also replace any driver-entered/confirmed mileage for this day.' : 'Yes, replace the confirmed value.'}</span>
                      </label>
                    )}
                    <div className="flex items-center gap-2">
                      <Button size="sm" onClick={handleAiApply} disabled={aiBusy}>{aiBusy ? 'Applying…' : 'Apply'}</Button>
                      <Button size="sm" variant="outline" onClick={clearAi}>Cancel</Button>
                    </div>
                  </div>
                )}
              </div>
            )}
            {aiMessage && <div className="mt-2 text-[11px] text-muted-foreground">{aiMessage}</div>}
            <div className="text-[10px] text-muted-foreground mt-2">The assistant only proposes changes here — nothing is saved until you tap Apply, and it never touches your duty-status log.</div>
          </div>
        </>
      )}

      <Dialog open={!!recalcDate} onOpenChange={(o) => !o && setRecalcDate(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>Recalculate {recalcDate}</DialogTitle></DialogHeader>
          <div className="space-y-3 text-sm">
            <p className="text-muted-foreground">Re-derives this day's mileage from your current trip and location data — useful if you edited a past log entry after mileage was already resolved. This never changes your duty-status log, HOS, or DVIR.</p>
            {recalcConfirmedCount > 0 && (
              <div className="rounded-lg border border-warning/40 bg-warning/10 p-2 text-xs text-warning">
                {recalcConfirmedCount} jurisdiction{recalcConfirmedCount > 1 ? 's' : ''} for this day {recalcConfirmedCount > 1 ? 'are' : 'is'} driver entered or confirmed. By default {recalcConfirmedCount > 1 ? 'those will' : 'that will'} NOT be changed — only route-estimated/odometer-derived mileage is refreshed.
              </div>
            )}
            <label className="flex items-start gap-2 text-xs text-card-foreground">
              <input type="checkbox" className="mt-0.5 w-4 h-4" checked={recalcReplaceConfirmed}
                onChange={(e) => setRecalcReplaceConfirmed(e.target.checked)} disabled={recalcConfirmedCount === 0} />
              <span>Also replace driver-entered/confirmed mileage for this day with the fresh estimate{recalcConfirmedCount === 0 ? ' (nothing confirmed for this day)' : ''}.</span>
            </label>
            {recalcResult && (
              <div className="text-[11px] space-y-1">
                {recalcResult.updated.length > 0 && (
                  <p className="text-card-foreground">Updated: {recalcResult.updated.map((u) => `${u.jurisdiction} ${u.miles.toFixed(1)} mi`).join(', ')}</p>
                )}
                {recalcResult.preserved.length > 0 && (
                  <p className="text-muted-foreground">Preserved (unchanged): {recalcResult.preserved.map((p) => `${p.jurisdiction} ${p.miles} mi`).join(', ')}</p>
                )}
                {recalcResult.errors.length > 0 && (
                  <p className="text-warning">{recalcResult.errors.length} issue(s) — your log is unaffected; try again later.</p>
                )}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRecalcDate(null)}>Close</Button>
            <Button onClick={runRecalc} disabled={recalcRunning}>{recalcRunning ? 'Recalculating…' : 'Recalculate day'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
