import { useState, useMemo, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useDriverData } from '@/hooks/useDriverData';
import { getDailyGrid, computeHOS, hasSufficientCycleHistory, dateKeyInTz } from '@/lib/hosEngine';
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

// Format a finite number of hours as "X hr YY min". Non-finite (NaN/undefined)
// renders as '--' — never a false "0 hr 00 min" — so placeholder/uncalculated
// values cannot masquerade as a real zero on the Recap card.
const fmtHM = (h) => {
  if (!Number.isFinite(h)) return '--';
  const totalMin = Math.round(h * 60);
  return `${Math.floor(totalMin / 60)} hr ${String(totalMin % 60).padStart(2, '0')} min`;
};

// ---------------------------------------------------------------------------
// recapDisplay — PRESENTATION HELPER ONLY.
// Performs no HOS or cycle calculation of its own. It only reads numbers that
// computeHOS() has already produced on hosForDay.cycle and formats/gates them
// using the SAME three-state contract as the canonical deriveHosDisplay:
//   state ∈ {'unavailable','unverified','real','exhausted'}
// Because computeHOS is gated by validateTimeline, an invalid timeline makes
// hosForDay.cycle carry the same unavailable state as hosDisplay.cycle, so
// Used and Available on the Recap can never disagree.
// ---------------------------------------------------------------------------
const UNAVAILABLE = { value: '--', note: 'Unavailable until timeline is valid', state: 'unavailable' };
const UNVERIFIED = { value: '--', note: 'Cycle unverified — prior history needed', state: 'unverified' };

function recapDisplay(hosForDay, historyComplete) {
  const cyc = hosForDay?.cycle || {};
  const cycleLimit = Number.isFinite(cyc.cycleLimit) ? cyc.cycleLimit : (cyc.cycleType === '60_7' ? 60 : 70);
  const cycleDays = Number.isFinite(cyc.cycleDays) ? cyc.cycleDays : (cyc.cycleType === '60_7' ? 7 : 8);

  const valid = !!(hosForDay?.calculable && hosForDay?.validity?.valid);
  if (!valid) {
    return { used: UNAVAILABLE, available: UNAVAILABLE, today: UNAVAILABLE, returningTomorrow: UNAVAILABLE, cycleLimit, cycleDays };
  }
  if (!historyComplete) {
    return { used: UNVERIFIED, available: UNVERIFIED, today: UNVERIFIED, returningTomorrow: UNVERIFIED, cycleLimit, cycleDays };
  }

  const usedH = Number.isFinite(cyc.cycleUsedHours) ? cyc.cycleUsedHours : 0;
  const remH = Number.isFinite(cyc.cycleRemainingHours) ? cyc.cycleRemainingHours : 0;
  const retH = Number.isFinite(cyc.returningTomorrowHours) ? cyc.returningTomorrowHours : NaN;
  const totals = Array.isArray(cyc.dailyTotals) ? cyc.dailyTotals : [];
  const todayH = totals.length ? totals[totals.length - 1]?.onDutyHours : NaN;
  const exhausted = remH <= 0;
  const usedNote = `${fmtHM(usedH)} used`;

  return {
    used: { value: fmtHM(usedH), note: '', state: 'real' },
    available: exhausted
      ? { value: '0 hr 00 min', note: usedNote, state: 'exhausted' }
      : { value: fmtHM(remH), note: usedNote, state: 'real' },
    today: { value: fmtHM(todayH), note: '', state: 'real' },
    returningTomorrow: { value: fmtHM(retH), note: '', state: 'real' },
    cycleLimit,
    cycleDays,
  };
}

export default function Inspection() {
  const { t } = useTranslation();
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
  const historyComplete = useMemo(() => hasSufficientCycleHistory(events, cycleType, profile?.entered_prior_history, tz, grid.dayEnd), [events, cycleType, profile, tz, grid.dayEnd]);
  const hosForDay = useMemo(() => computeHOS(events, cycleType, tz, grid.dayEnd, { historyComplete }), [events, cycleType, tz, grid.dayEnd, historyComplete]);
  const hosDisplay = useMemo(() => deriveHosDisplay(hosForDay, historyComplete), [hosForDay, historyComplete]);
  const recap = useMemo(() => recapDisplay(hosForDay, historyComplete), [hosForDay, historyComplete]);
  const cert = certifications.find(c => c.log_date === selectedKey && !c.is_superseded);

  const allDates = useMemo(() => Array.from(new Set((events || []).map(e => e.log_date).filter(Boolean))).sort(), [events]);

  const buildDoc = (dates, options) => generateLogsPdf(profile, carrier, events, dates, tz, certifications, cycleType, { ...options, dvirs, documents, dailySummaries, speedProfile });

  return (
    <div className="px-4 min-h-screen bg-background text-foreground safe-top">
      {/* Inspection banner */}
      <div className="flex items-center justify-between bg-card rounded-xl p-3 mb-4 mt-6 border border-border">
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-5 h-5 text-primary" />
          <div>
            <div className="font-bold text-card-foreground">{t('inspection.mode')}</div>
            <div className="text-xs text-muted-foreground">Read-only · Current + Previous 7 Days</div>
          </div>
        </div>
        <Button variant="destructive" size="sm" onClick={() => window.history.back()}>
          <X className="w-4 h-4 mr-1" /> EXIT
        </Button>
      </div>

      {/* Driver / carrier identity */}
      <div className="bg-card text-card-foreground rounded-xl p-3 mb-3 text-sm">
        <div className="font-semibold">{profile?.legal_name}</div>
        <div className="text-muted-foreground text-xs">{carrier?.carrier_name} · USDOT {carrier?.usdot_number}</div>
        <div className="text-muted-foreground text-xs">{carrier?.home_terminal_address}</div>
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

      {/* Graph (read-only) — theme tokens like every other card here, so this
          always matches the graph's own internals (which also read the same
          theme variables) in both light and dark, instead of one hardcoded
          fixed color that only happened to line up in one theme. */}
      <div className="bg-card text-card-foreground rounded-xl p-3 mb-3">
        <RodsGraphEditor events={events} dateStr={selectedKey} timezone={tz} readOnly carrier={carrier} />
      </div>

      {/* Recap — all values sourced from hosForDay.cycle via recapDisplay */}
      <div className="bg-card text-card-foreground rounded-xl p-3 mb-3 text-sm">
        <div className="font-semibold mb-1">{recap.cycleLimit}-Hour / {recap.cycleDays}-Day Recap</div>
        <div className="grid grid-cols-2 gap-1 text-xs text-muted-foreground">
          <div>
            <div>Used: {recap.used.value}</div>
            {recap.used.note && <div className="text-muted-foreground text-[11px]">{recap.used.note}</div>}
          </div>
          <div>
            <div>Available: {recap.available.value}</div>
            {recap.available.note && <div className="text-muted-foreground text-[11px]">{recap.available.note}</div>}
          </div>
          <div>
            <div>Today: {recap.today.value}</div>
            {recap.today.note && <div className="text-muted-foreground text-[11px]">{recap.today.note}</div>}
          </div>
          <div>
            <div>Back tomorrow: {recap.returningTomorrow.value}</div>
            {recap.returningTomorrow.note && <div className="text-muted-foreground text-[11px]">{recap.returningTomorrow.note}</div>}
          </div>
        </div>
      </div>

      {/* HOS clocks (split-aware) as of end of selected day */}
      <div className="bg-card text-card-foreground rounded-xl p-3 mb-3 text-sm">
        <div className="font-semibold mb-1">{t('inspection.hosClocksEndOfDay')}</div>
        <div className="grid grid-cols-2 gap-1 text-xs text-muted-foreground">
          <div>
            Driving remaining: {hosDisplay.driving.value}
            {hosDisplay.driving.note && <div className="text-muted-foreground text-[11px]">{hosDisplay.driving.note}</div>}
          </div>
          <div>
            14-hr window remaining: {hosDisplay.window14.value}
            {hosDisplay.window14.note && <div className="text-muted-foreground text-[11px]">{hosDisplay.window14.note}</div>}
          </div>
          <div className="col-span-2 text-muted-foreground pt-1">
            {hosForDay.split.status === 'active'
              ? 'Split sleeper active (optional) — 11-hr & 14-hr clocks recalculated from the qualifying pairing.'
              : hosForDay.split.status === 'available'
                ? 'Split sleeper available — one qualifying period on record; pairing not yet completed (optional).'
                : 'No split-sleeper pairing in effect.'}
          </div>
        </div>
      </div>

      {/* Certification */}
      <div className="bg-card text-card-foreground rounded-xl p-3 mb-3 text-sm">
        {cert ? (
          <div className="text-success font-medium">✓ Certified {new Date(cert.certified_at).toLocaleString()} — {cert.signature_name}</div>
        ) : (
          <div className="text-warning">{t('inspection.uncertified')}</div>
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