import { useMemo, useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import { SCENARIOS, runScenario, formatPairingLabel } from '@/lib/hosScenarios';
import { Button } from '@/components/ui/button';
import { CheckCircle2, XCircle, ShieldCheck, ArrowLeft, RefreshCw } from 'lucide-react';

const TOL = 0.05;
const near = (a, b) => Math.abs(a - b) <= TOL;

export default function EngineTests() {
  const navigate = useNavigate();
  const [isAdmin, setIsAdmin] = useState(null); // null = checking
  const [runTs, setRunTs] = useState(0);

  useEffect(() => {
    (async () => {
      try {
        const me = await base44.auth.me();
        setIsAdmin(me.role === 'admin');
      } catch {
        setIsAdmin(false);
      }
    })();
  }, []);

  const results = useMemo(() => {
    return SCENARIOS.map((s) => {
      const r = runScenario(s);
      const e = s.expected;
      const checks = {
        pairing: r.pairingLabel === e.pairing,
        driveAccum: near(r.driveAccumH, e.driveAccumH),
        driveRem: near(r.driveRemH, e.driveRemH),
        windowRem: near(r.windowRemH, e.windowRemH),
        cycleRem: near(r.cycleRemH, e.cycleRemH),
        splitStatus: r.splitStatus === e.splitStatus,
        violation: r.violation === e.violation,
      };
      if (e.unsplitWindowRemH != null) {
        checks.unsplitDiffers = r.unsplitWindowRemH != null && near(r.unsplitWindowRemH, e.unsplitWindowRemH) && Math.abs(r.windowRemH - r.unsplitWindowRemH) > TOL;
      }
      const passed = Object.values(checks).every(Boolean);
      return { scenario: s, r, e, checks, passed };
    });
  }, [runTs]);

  if (isAdmin === null) {
    return <div className="flex items-center justify-center h-screen"><div className="w-8 h-8 border-4 border-slate-200 border-t-slate-800 rounded-full animate-spin" /></div>;
  }
  if (!isAdmin) {
    return (
      <div className="px-4 pt-10 text-center">
        <ShieldCheck className="w-10 h-10 mx-auto text-slate-300 mb-3" />
        <p className="text-sm text-slate-500 mb-4">Engine Tests are available to administrators only.</p>
        <Button variant="outline" onClick={() => navigate('/more')}>Back to More</Button>
      </div>
    );
  }

  const allPassed = results.every((r) => r.passed);

  const rerun = () => setRunTs(Date.now());

  return (
    <div className="px-4 pt-6 pb-10">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => navigate('/more')}><ArrowLeft className="w-4 h-4" /></Button>
          <h1 className="text-xl font-bold">HOS Engine Tests</h1>
        </div>
        <Button size="sm" variant="outline" onClick={rerun}><RefreshCw className="w-3.5 h-3.5 mr-1" /> Re-run</Button>
      </div>

      <div className={`rounded-xl border p-3 mb-4 flex items-center gap-2 text-sm font-medium ${allPassed ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-red-200 bg-red-50 text-red-800'}`}>
        {allPassed ? <CheckCircle2 className="w-5 h-5" /> : <XCircle className="w-5 h-5" />}
        {allPassed ? `All ${results.length} scenarios passed` : `${results.filter(r => r.passed).length} / ${results.length} scenarios passed`}
        <span className="text-xs font-normal text-slate-500 ml-auto">Pure deterministic logic · no AI</span>
      </div>

      <div className="space-y-3">
        {results.map(({ scenario, r, e, checks, passed }) => (
          <div key={scenario.id} className={`rounded-xl border bg-white p-3 ${passed ? 'border-slate-200' : 'border-red-300'}`}>
            <div className="flex items-start gap-2">
              {passed ? <CheckCircle2 className="w-4 h-4 text-emerald-600 mt-0.5 shrink-0" /> : <XCircle className="w-4 h-4 text-red-600 mt-0.5 shrink-0" />}
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold">{scenario.id}. {scenario.name}</div>
                <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs mt-2">
                  <Row label="Pairing" value={r.pairingLabel} ok={checks.pairing} />
                  <Row label="Split status" value={r.splitStatus} ok={checks.splitStatus} />
                  <Row label="Drive accumulated" value={`${r.driveAccumH.toFixed(2)} h`} ok={checks.driveAccum} expected={`${e.driveAccumH} h`} />
                  <Row label="11-hr drive remaining" value={`${r.driveRemH.toFixed(2)} h`} ok={checks.driveRem} expected={`${e.driveRemH} h`} />
                  <Row label="14-hr window remaining" value={`${r.windowRemH.toFixed(2)} h`} ok={checks.windowRem} expected={`${e.windowRemH} h`} />
                  <Row label="Cycle remaining" value={`${r.cycleRemH.toFixed(2)} h`} ok={checks.cycleRem} expected={`${e.cycleRemH} h`} />
                  <Row label="HOS violation" value={r.violation ? 'Yes' : 'No'} ok={checks.violation} expected={e.violation ? 'Yes' : 'No'} />
                  {e.unsplitWindowRemH != null && (
                    <Row label="Unsplit 14-hr (compare)" value={`${(r.unsplitWindowRemH ?? 0).toFixed(2)} h`} ok={checks.unsplitDiffers} expected={`${e.unsplitWindowRemH} h`} />
                  )}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      <p className="text-[11px] text-slate-400 mt-4">
        Each scenario is evaluated live against the deterministic HOS engine. Expected values are derived from FMCSA split-sleeper methodology: both the 11-hour driving limit and 14-hour window are anchored at the end of the first qualifying rest period of the selected pairing, with the paired rest excluded from the 14-hour window. Cycle and 30-minute break are based on actuals and are not reduced by split treatment.
      </p>
    </div>
  );
}

function Row({ label, value, ok, expected }) {
  return (
    <div className="flex items-center justify-between gap-2 border-b border-slate-50 py-0.5">
      <span className="text-slate-500">{label}</span>
      <span className={`font-medium ${ok ? 'text-slate-800' : 'text-red-600'}`}>
        {value}{!ok && expected != null && <span className="text-red-400 font-normal"> (exp {expected})</span>}
      </span>
    </div>
  );
}