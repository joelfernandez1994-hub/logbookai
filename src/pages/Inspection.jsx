import { useState, useMemo, useEffect } from 'react';
import { useDriverData } from '@/hooks/useDriverData';
import { getDailyGrid, computeCycle, computeHOS, hasSufficientCycleHistory, dateKeyInTz } from '@/lib/hosEngine';
import { deriveHosDisplay } from '@/lib/proposalValidation';
import RodsGraphEditor from '@/components/rodsEditor/RodsGraphEditor';
import LogExportSheet from '@/components/LogExportSheet';
import { getCertifications, getAllEvents, getDocuments } from '@/lib/driverData';
import { getDvirs } from '@/lib/dvirData';
import { getAllDailySummaries } from '@/lib/tripSync';
import { generateLogsPdf } from '@/lib/pdfGenerator';
import { Button } from '@/components/ui/button';
import { ChevronLeft, ChevronRight, Share2, X, ShieldCheck } from 'lucide-react';
import TimezoneIndicator from '@/components/TimezoneIndicator';

const STATUS_LABELS = { OFF_DUTY: 'Off Duty', SLEEPER_BERTH: 'Sleeper', DRIVING: 'Driving', ON_DUTY: 'On Duty' };
// Format hours as X hr YY min; NaN/undefined -> 0 hr 00 min (never expose "NaN").
// Guards the cycle recap against computeCycle returning NaN for empty/new drivers.
const fmtHM = (h) => {
  const v = Number.isFinite(h) ? h : 0;
  const totalMin = Math.round(v * 60);
  return `${Math.floor(totalMin / 60)} hr ${String(totalMin % 60).padStart(2, '0')} min`;
};

export default function Inspection() {
  const { profile, carrier } = useDriverData(9);
  const [events, setEvents] = useState([]);
  const [certifications, setCertifications] = useState([]);
  const [dvirs, setDvirs] = useState([]);
  const [documents, setDocuments] = useState([]);
  const [dailySummaries, setDailySummaries] = useState([]);
  const [dayOffset, setDayOffset] = useState(0); // 0 = today, -7 = 7 days ago
  const [showExport, setShowExport] = useState(false);

  const tz = carrier?.home_terminal_timezone || 'America/Chicago';
  const cycleType = carrier?.hos_cycle || '70_8';
  const speedProfile = profile?.trip_planning_speed_profile || 'conservative';

  useEffect(() => {
    (async () => {
      const [ev, certs, dv, docs, sums] = await Promise.all([getAllEvents(), getCertifications(9), getDvirs(30), getDocuments(30), getAllDailySummaries()]);
      setEvents(ev || []);
      setCertifications(certs || []);
      setDvirs(dv || []);
      setDocuments(docs || []);
      setDailySummaries(sums || []);
    })();
  }, []);

  const dayKeys = useMemo(() => {
    const keys = [];
    for (let i = -7; i <= 0; i++) {
      const d = new Date(Date.now() + i * 24 * 3600000);
      keys.push(dateKeyInTz(d, tz));
    }
    return keys;
  }, [tz]);

  const selectedKey = dayKeys[Math.max(0, Math.min(7, dayOffset + 7))];
  const grid = useMemo(() => getDailyGrid(events, selectedKey, tz), [events, selectedKey, tz]);
  const cycle = useMemo(() => computeCycle(events, cycleType, tz, new Date(selectedKey + 'T12:00:00')), [events, cycleType, tz, selectedKey]);
  const historyComplete = useMemo(() => hasSufficientCycleHistory(events, cycleType, profile?.entered_prior_history, tz, grid.dayEnd), [events, cycleType, profile, tz, grid.dayEnd]);
  const hosForDay = useMemo(() => computeHOS(events, cycleType, tz, grid.dayEnd, { historyComplete }), [events, cycleType, tz, grid.dayEnd, historyComplete]);
  const hosDisplay = useMemo(() => deriveHosDisplay(hosForDay, historyComplete), [hosForDay, historyComplete]);
  const cert = certifications.find(c => c.log_date === selectedKey && !c.is_superseded);

  const allDates = useMemo(() => Array.from(new Set((events || []).map(e => e.log_date).filter(Boolean))).sort(), [events]);

  const buildDoc = (dates, options) => generateLogsPdf(profile, carrier, events, dates, tz, certifications, cycleType, { ...options, dvirs, documents, dailySummaries, speedProfile });

  return (
    <div className="px-4 min-h-screen bg-slate-900 text-white safe-top">
      {/* Inspection banner */}
      <div className="flex items-center justify-between bg-slate-800 rounded-xl p-3 mb-4 mt-6 border border-slate-700">
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-5 h-5 text-blue-400" />
          <div>
            <div className="font-bold">INSPECTION MODE</div>
            <div className="text-xs text-slate-400">Read-only · Current + Previous 7 Days</div>
          </div>
        </div>
        <Button variant="destructive" size="sm" onClick={() => window.history.back()}>
          <X className="w-4 h-4 mr-1" /> EXIT
        </Button>
      </div>

      {/* Driver / carrier identity */}
      <div className="bg-slate-800 rounded-xl p-3 mb-3 text-sm">
        <div className="font-semibold">{profile?.legal_name}</div>
        <div className="text-slate-300 text-xs">{carrier?.carrier_name} · USDOT {carrier?.usdot_number}</div>
        <div className="text-slate-400 text-xs">{carrier?.home_terminal_address}</div>
        <div className="mt-1"><TimezoneIndicator tz={tz} /></div>
      </div>

      {/* Day navigation */}
      <div className="flex items-center justify-between mb-3">
        <Button variant="ghost" size="sm" onClick={() => setDayOffset(Math.max(-7, dayOffset - 1))} disabled={dayOffset <= -7}>
          <ChevronLeft className="w-4 h-4" />
        </Button>
        <div className="text-center font-medium">{new Date(selectedKey + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: tz })}</div>
        <Button variant="ghost" size="sm" onClick={() => setDayOffset(Math.min(0, dayOffset + 1))} disabled={dayOffset >= 0}>
          <ChevronRight className="w-4 h-4" />
        </Button>
      </div>

      {/* Graph (read-only) */}
      <div className="bg-white rounded-xl p-3 mb-3 text-slate-900">
        <RodsGraphEditor events={events} dateStr={selectedKey} timezone={tz} readOnly carrier={carrier} />
      </div>

      {/* Recap */}
      <div className="bg-slate-800 rounded-xl p-3 mb-3 text-sm">
        <div className="font-semibold mb-1">{cycle?.cycleLimit || (cycleType === '60_7' ? 60 : 70)}-Hour / {cycle?.cycleDays || (cycleType === '60_7' ? 7 : 8)}-Day Recap</div>
        <div className="grid grid-cols-2 gap-1 text-xs text-slate-300">
          <div>Used: {fmtHM(cycle?.cycleUsedHours)}</div>
          <div>
            <div>Available: {hosDisplay.cycle.value}</div>
            {hosDisplay.cycle.note && <div className="text-slate-500 text-[11px]">{hosDisplay.cycle.note}</div>}
          </div>
          <div>Today: {fmtHM(cycle?.dailyTotals?.[cycle.dailyTotals.length - 1]?.onDutyHours)}</div>
          <div>Back tomorrow: {fmtHM(cycle?.returningTomorrowHours)}</div>
        </div>
      </div>

      {/* HOS clocks (split-aware) as of end of selected day */}
      <div className="bg-slate-800 rounded-xl p-3 mb-3 text-sm">
        <div className="font-semibold mb-1">HOS Clocks (end of day)</div>
        <div className="grid grid-cols-2 gap-1 text-xs text-slate-300">
          <div>
            Driving remaining: {hosDisplay.driving.value}
            {hosDisplay.driving.note && <div className="text-slate-500 text-[11px]">{hosDisplay.driving.note}</div>}
          </div>
          <div>
            14-hr window remaining: {hosDisplay.window14.value}
            {hosDisplay.window14.note && <div className="text-slate-500 text-[11px]">{hosDisplay.window14.note}</div>}
          </div>
          <div className="col-span-2 text-slate-400 pt-1">
            {hosForDay.split.status === 'active'
              ? 'Split sleeper active (optional) — 11-hr & 14-hr clocks recalculated from the qualifying pairing.'
              : hosForDay.split.status === 'available'
                ? 'Split sleeper available — one qualifying period on record; pairing not yet completed (optional).'
                : 'No split-sleeper pairing in effect.'}
          </div>
        </div>
      </div>

      {/* Certification */}
      <div className="bg-slate-800 rounded-xl p-3 mb-3 text-sm">
        {cert ? (
          <div className="text-emerald-400 font-medium">✓ Certified {new Date(cert.certified_at).toLocaleString()} — {cert.signature_name}</div>
        ) : (
          <div className="text-amber-400">Uncertified</div>
        )}
      </div>

      {/* Export actions */}
      <Button className="w-full mb-6" onClick={() => setShowExport(true)}>
        <Share2 className="w-4 h-4 mr-2" /> Export / Share Logs
      </Button>

      <LogExportSheet
        open={showExport}
        onClose={() => setShowExport(false)}
        tz={tz}
        allDates={allDates}
        buildDoc={buildDoc}
        profile={profile}
        carrier={carrier}
        hasDvirs={dvirs.length > 0}
        hasDocs={documents.length > 0}
      />
    </div>
  );
}