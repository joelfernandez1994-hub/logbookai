import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDriverData } from '@/hooks/useDriverData';
import { computeHOS, runComplianceCheck, getDailyGrid, dateKeyInTz } from '@/lib/hosEngine';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { AlertTriangle, CheckCircle2, Info, FileWarning, Lightbulb, RefreshCw } from 'lucide-react';

const STATUS_LABELS = { OFF_DUTY: 'Off Duty', SLEEPER_BERTH: 'Sleeper', DRIVING: 'Driving', ON_DUTY: 'On Duty' };

export default function Compliance() {
  const { profile, carrier, events, loading, reload } = useDriverData(9);
  const [checking, setChecking] = useState(false);
  const [issues, setIssues] = useState(null);

  const tz = carrier?.home_terminal_timezone || 'America/Chicago';
  const cycleType = carrier?.hos_cycle || '70_8';
  const now = new Date();

  const runCheck = () => {
    setChecking(true);
    const todayKey = dateKeyInTz(now, tz);
    const grid = getDailyGrid(events, todayKey, tz);
    const result = runComplianceCheck(events, cycleType, tz, now, {
      historyComplete: profile?.entered_prior_history,
      dailyTotal: grid.totalHours,
      firstDrivingWithoutPretrip: false,
      equipmentMissing: false,
    });
    setIssues(result);
    setChecking(false);
  };

  useEffect(() => { runCheck(); }, [events]);

  if (loading) return <div className="flex justify-center h-screen items-center"><div className="w-8 h-8 border-4 border-slate-200 border-t-slate-800 rounded-full animate-spin" /></div>;

  const renderSection = (title, items, icon, color) => (
    items.length > 0 && (
      <div className="rounded-xl border border-slate-200 bg-white p-3 mb-3">
        <div className={`flex items-center gap-2 font-semibold text-sm mb-2 ${color}`}>
          {icon} {title}
        </div>
        <div className="space-y-1.5">
          {items.map((it, i) => (
            <div key={i} className="text-xs text-slate-700 border-l-2 border-slate-200 pl-2">
              {it.rule ? <span className="font-medium">{it.rule}: </span> : null}{it.message}
            </div>
          ))}
        </div>
      </div>
    )
  );

  return (
    <div className="px-4 pt-6">
      <div className="flex items-center justify-between mb-3">
        <h1 className="text-xl font-bold">Compliance Check</h1>
        <Button size="sm" variant="outline" onClick={runCheck} disabled={checking}>
          <RefreshCw className="w-3.5 h-3.5 mr-1" /> {checking ? 'Checking...' : 'Re-check'}
        </Button>
      </div>

      {issues ? (
        <>
          {renderSection('HOS Issues', issues.hos, <AlertTriangle className="w-4 h-4" />, 'text-red-600')}
          {renderSection('Missing Information', issues.missingInfo, <Info className="w-4 h-4" />, 'text-amber-600')}
          {renderSection('Supporting Document Conflicts', issues.docConflicts, <FileWarning className="w-4 h-4" />, 'text-orange-600')}
          {renderSection('Suggestions', issues.suggestions, <Lightbulb className="w-4 h-4" />, 'text-emerald-600')}
          {issues.hos.length === 0 && issues.missingInfo.length === 0 && issues.docConflicts.length === 0 && (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-emerald-800 text-sm flex items-center gap-2">
              <CheckCircle2 className="w-5 h-5" /> No issues detected by the current LogbookAI compliance checks.
            </div>
          )}
        </>
      ) : (
        <div className="text-sm text-slate-500 text-center py-8">Running compliance check...</div>
      )}
    </div>
  );
}