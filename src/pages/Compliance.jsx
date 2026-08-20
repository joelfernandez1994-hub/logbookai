import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDriverData } from '@/hooks/useDriverData';
import { computeHOS, runComplianceCheck, getDailyGrid, dateKeyInTz, hasSufficientCycleHistory } from '@/lib/hosEngine';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { AlertTriangle, CheckCircle2, Info, FileWarning, Lightbulb, RefreshCw } from 'lucide-react';
import Header from '@/components/Header';

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
      historyComplete: hasSufficientCycleHistory(events, cycleType, profile?.entered_prior_history, tz, now),
      dailyTotal: grid.totalHours,
      firstDrivingWithoutPretrip: false,
      equipmentMissing: false,
    });
    setIssues(result);
    setChecking(false);
  };

  useEffect(() => { runCheck(); }, [events]);

  if (loading) return <div className="flex justify-center h-screen items-center"><div className="w-8 h-8 border-4 border-muted border-t-foreground rounded-full animate-spin" /></div>;

  const renderSection = (title, items, icon, colorClass) => (
    items.length > 0 && (
      <div className="rounded-xl border border-border bg-card p-3 mb-3">
        <div className={`flex items-center gap-2 font-semibold text-sm mb-2 ${colorClass}`}>
          {icon} {title}
        </div>
        <div className="space-y-1.5">
          {items.map((it, i) => (
            <div key={i} className="text-xs text-muted-foreground border-l-2 border-border pl-2">
              {it.rule ? <span className="font-medium text-card-foreground">{it.rule}: </span> : null}{it.message}
            </div>
          ))}
        </div>
      </div>
    )
  );

  return (
    <div className="px-4 pt-6">
      <Header title="Compliance Check" />
      <div className="flex justify-end mb-3">
        <Button size="sm" variant="outline" onClick={runCheck} disabled={checking}>
          <RefreshCw className="w-3.5 h-3.5 mr-1" /> {checking ? 'Checking...' : 'Re-check'}
        </Button>
      </div>

      {issues ? (
        <>
          {renderSection('HOS Issues', issues.hos, <AlertTriangle className="w-4 h-4" />, 'text-error')}
          {renderSection('Missing Information', issues.missingInfo, <Info className="w-4 h-4" />, 'text-warning')}
          {renderSection('Supporting Document Conflicts', issues.docConflicts, <FileWarning className="w-4 h-4" />, 'text-warning')}
          {renderSection('Suggestions', issues.suggestions, <Lightbulb className="w-4 h-4" />, 'text-success')}
          {issues.hos.length === 0 && issues.missingInfo.length === 0 && issues.docConflicts.length === 0 && (
            <div className="rounded-xl border border-success/40 bg-success-surface p-4 text-success-surface-foreground text-sm flex items-center gap-2">
              <CheckCircle2 className="w-5 h-5" /> No issues detected by the current LogbookAI compliance checks.
            </div>
          )}
        </>
      ) : (
        <div className="text-sm text-muted-foreground text-center py-8">Running compliance check...</div>
      )}
    </div>
  );
}