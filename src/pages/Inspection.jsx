import { useState, useMemo, useEffect } from 'react';
import { useDriverData } from '@/hooks/useDriverData';
import { getDailyGrid, computeCycle, computeHOS, fmtDur, dateKeyInTz } from '@/lib/hosEngine';
import LogGraph from '@/components/LogGraph';
import { getCertifications, getAllEvents } from '@/lib/driverData';
import { generateLogsPdf } from '@/lib/pdfGenerator';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { ChevronLeft, ChevronRight, FileDown, Share2, X, ShieldCheck } from 'lucide-react';

const STATUS_LABELS = { OFF_DUTY: 'Off Duty', SLEEPER_BERTH: 'Sleeper', DRIVING: 'Driving', ON_DUTY: 'On Duty' };

export default function Inspection() {
  const { profile, carrier } = useDriverData(9);
  const [events, setEvents] = useState([]);
  const [certifications, setCertifications] = useState([]);
  const [dayOffset, setDayOffset] = useState(0); // 0 = today, -7 = 7 days ago
  const [shareEmail, setShareEmail] = useState('');
  const [showShare, setShowShare] = useState(false);
  const [sharing, setSharing] = useState(false);

  const tz = carrier?.home_terminal_timezone || 'America/Chicago';
  const cycleType = carrier?.hos_cycle || '70_8';

  useEffect(() => {
    (async () => {
      const [ev, certs] = await Promise.all([getAllEvents(), getCertifications(9)]);
      setEvents(ev || []);
      setCertifications(certs || []);
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
  const hosForDay = useMemo(() => computeHOS(events, cycleType, tz, grid.dayEnd, { historyComplete: true }), [events, cycleType, tz, grid.dayEnd]);
  const cert = certifications.find(c => c.log_date === selectedKey && !c.is_superseded);

  const generatePdf = (range = false) => {
    const dates = range ? dayKeys : [selectedKey];
    const doc = generateLogsPdf(profile, carrier, events, dates, tz, certifications, cycleType);
    doc.save(`LogbookAI_${range ? 'inspection' : selectedKey}.pdf`);
  };

  const sharePdf = async () => {
    setSharing(true);
    const doc = generateLogsPdf(profile, carrier, events, dayKeys, tz, certifications, cycleType);
    const blob = doc.output('blob');
    const fileName = `LogbookAI_inspection_${dayKeys[0]}_to_${dayKeys[dayKeys.length - 1]}.pdf`;
    if (navigator.share && navigator.canShare && navigator.canShare({ files: [new File([blob], fileName, { type: 'application/pdf' })] })) {
      try {
        await navigator.share({ files: [new File([blob], fileName, { type: 'application/pdf' })], title: 'LogbookAI Inspection Records' });
      } catch (e) {}
    } else if (shareEmail) {
      // Email a summary; attach requires backend
      await base44.integrations.Core.SendEmail({
        to: shareEmail,
        subject: `LogbookAI Inspection Records ${dayKeys[0]} - ${dayKeys[dayKeys.length - 1]}`,
        body: `Inspection records for ${profile?.legal_name} (${carrier?.carrier_name}, USDOT ${carrier?.usdot_number}) covering ${dayKeys.length} days (${dayKeys[0]} to ${dayKeys[dayKeys.length - 1]}).`,
      });
    }
    setSharing(false);
    setShowShare(false);
  };

  return (
    <div className="px-4 pt-6 min-h-screen bg-slate-900 text-white">
      {/* Inspection banner */}
      <div className="flex items-center justify-between bg-slate-800 rounded-xl p-3 mb-4 border border-slate-700">
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
        <LogGraph events={events} dateStr={selectedKey} timezone={tz} interactive={false} />
      </div>

      {/* Recap */}
      <div className="bg-slate-800 rounded-xl p-3 mb-3 text-sm">
        <div className="font-semibold mb-1">{cycle.cycleLimit}-Hour / {cycle.cycleDays}-Day Recap</div>
        <div className="grid grid-cols-2 gap-1 text-xs text-slate-300">
          <div>Used: {cycle.cycleUsedHours.toFixed(2)}</div>
          <div>Available: {cycle.cycleRemainingHours.toFixed(2)}</div>
          <div>Today: {(cycle.dailyTotals[cycle.dailyTotals.length - 1]?.onDutyHours || 0).toFixed(2)}</div>
          <div>Back tomorrow: {cycle.returningTomorrowHours.toFixed(2)}</div>
        </div>
      </div>

      {/* HOS clocks (split-aware) as of end of selected day */}
      <div className="bg-slate-800 rounded-xl p-3 mb-3 text-sm">
        <div className="font-semibold mb-1">HOS Clocks (end of day)</div>
        <div className="grid grid-cols-2 gap-1 text-xs text-slate-300">
          <div>Driving remaining: {fmtDur(hosForDay.driving.drivingRemainingMs)}</div>
          <div>14-hr window remaining: {fmtDur(hosForDay.window14.remainingMs)}</div>
          <div className="col-span-2 text-slate-400 pt-1">
            {hosForDay.split.status === 'active'
              ? 'Split sleeper active — 11-hr & 14-hr clocks recalculated from the qualifying pairing.'
              : hosForDay.split.status === 'incomplete'
                ? 'Split sleeper incomplete — not applied.'
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
      <div className="grid grid-cols-2 gap-2 mb-4">
        <Button onClick={() => generatePdf(false)}><FileDown className="w-4 h-4 mr-1" /> PDF (this day)</Button>
        <Button onClick={() => generatePdf(true)}><FileDown className="w-4 h-4 mr-1" /> PDF (8 days)</Button>
      </div>
      <Button variant="outline" className="w-full mb-6 border-slate-600 text-white" onClick={() => setShowShare(true)}>
        <Share2 className="w-4 h-4 mr-2" /> Email / Share Inspection Records
      </Button>

      {showShare && (
        <div className="fixed inset-0 bg-black/60 flex items-end justify-center z-50" onClick={() => setShowShare(false)}>
          <div className="bg-white text-slate-900 rounded-t-2xl p-4 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="font-bold mb-1">Share {dayKeys.length} days of log records</div>
            <p className="text-xs text-slate-500 mb-3">You are about to share {dayKeys.length} days of log records ({dayKeys[0]} to {dayKeys[dayKeys.length - 1]}).</p>
            <input placeholder="Officer / agency email (optional)" value={shareEmail} onChange={(e) => setShareEmail(e.target.value)}
              className="w-full border rounded-lg p-2 mb-3" />
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => setShowShare(false)}>Cancel</Button>
              <Button className="flex-1" disabled={sharing} onClick={sharePdf}>{sharing ? 'Sharing...' : 'Confirm Share'}</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}