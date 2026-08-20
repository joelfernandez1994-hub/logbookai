import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { AlertTriangle, Check, Pencil, ShieldAlert } from 'lucide-react';
import { fmtDur, fmtHours } from '@/lib/hosEngine';
import { formatHour } from '@/lib/rodsEditor';

const ROW_ORDER = ['OFF_DUTY', 'SLEEPER_BERTH', 'DRIVING', 'ON_DUTY'];
const STATUS_COLORS = {
  OFF_DUTY: '#64748b', SLEEPER_BERTH: '#7c3aed', DRIVING: '#2563eb', ON_DUTY: '#ea580c',
};

function MiniGraph({ segs, label }) {
  const W = 280, H = 96, pad = 4, rowH = 18;
  const x = (h) => pad + (h / 24) * (W - pad * 2);
  return (
    <div>
      <div className="text-[11px] font-medium text-slate-500 mb-1">{label}</div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full rounded-md border border-slate-200 bg-white">
        {[0, 6, 12, 18, 24].map((h) => (
          <line key={h} x1={x(h)} y1={pad} x2={x(h)} y2={H - pad} stroke="#e2e8f0" strokeWidth={0.8} />
        ))}
        {ROW_ORDER.map((s, i) => (
          <g key={s}>
            <line x1={pad} y1={pad + i * rowH + rowH / 2} x2={W - pad} y2={pad + i * rowH + rowH / 2} stroke="#f1f5f9" strokeWidth={rowH - 2} />
          </g>
        ))}
        {segs.map((sg, i) => {
          const ri = ROW_ORDER.indexOf(sg.status);
          if (ri < 0) return null;
          return (
            <rect key={i} x={x(sg.startHour)} y={pad + ri * rowH + 1}
              width={Math.max(1.5, x(sg.endHour) - x(sg.startHour))} height={rowH - 2}
              fill={STATUS_COLORS[sg.status]} opacity={0.55} rx={1.5} />
          );
        })}
      </svg>
    </div>
  );
}

function HosRow({ before, after }) {
  const cell = (v) => <span className="tabular-nums">{v == null ? '--' : v}</span>;
  return (
    <div className="grid grid-cols-3 gap-1 text-xs py-0.5">
      <div className="text-slate-500">{before.label}</div>
      <div className="text-slate-400 line-through text-right">{before.val}</div>
      <div className="font-semibold text-right">{after.val}</div>
    </div>
  );
}

export default function ProposedChangeDialog({ open, isCertified, beforeSegs, afterSegs, beforeHos, afterHos, warnings, violations, onApply, onEdit, onCancel }) {
  const blocking = (warnings || []).filter((w) => w.severity === 'blocking');
  const fmt = (ms) => fmtDur(ms);
  const beforeHosRow = (label, val) => ({ label, val });
  const hosSummary = (hos) => hos ? [
    { label: 'Driving remaining', val: fmt(hos.driving?.drivingRemainingMs) },
    { label: '14-hr window remaining', val: fmt(hos.window14?.remainingMs) },
    { label: 'Cycle remaining', val: `${fmtHours(hos.cycle?.cycleRemainingHours)}` },
    { label: '30-min break', val: hos.break30?.breakRequired ? 'Required' : 'OK' },
    { label: 'Split sleeper', val: hos.split?.status === 'active' ? 'Active' : (hos.split?.status === 'incomplete' ? 'Incomplete' : 'None') },
    { label: '34h restart', val: hos.restart?.completed ? 'Completed' : (hos.restart?.inProgress ? 'In progress' : '—') },
  ] : [];

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="max-w-md max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="w-5 h-5 text-amber-500" /> Proposed Log Change
          </DialogTitle>
        </DialogHeader>

        {isCertified && (
          <div className="rounded-md bg-amber-50 border border-amber-300 p-2 text-xs text-amber-900">
            This day is certified. Applying will preserve the previous event/version and certification in audit history, and mark the new log <b>Needs Re-Certification</b>.
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <MiniGraph segs={beforeSegs || []} label="Before" />
          <MiniGraph segs={afterSegs || []} label="After" />
        </div>

        <div className="rounded-lg border border-slate-200 p-2">
          <div className="grid grid-cols-3 gap-1 text-[11px] font-semibold text-slate-400 mb-1">
            <div>HOS</div><div className="text-right">Before</div><div className="text-right">After</div>
          </div>
          {hosSummary(beforeHos).map((r, i) => (
            <HosRow key={r.label} before={r} after={(hosSummary(afterHos)[i] || r)} />
          ))}
        </div>

        {violations?.length > 0 && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-2 text-xs text-red-800 space-y-1">
            <div className="font-semibold flex items-center gap-1"><AlertTriangle className="w-3.5 h-3.5" /> HOS Violations</div>
            {violations.map((v, i) => <div key={i}>• {v.rule}: {v.message}</div>)}
          </div>
        )}

        {blocking.length > 0 && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 space-y-1">
            <div className="font-semibold">Blocking checks:</div>
            {blocking.map((w, i) => <div key={i}>• {w.title}: {w.message}</div>)}
          </div>
        )}
        {warnings?.filter((w) => w.severity !== 'blocking').length > 0 && (
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-2 text-xs text-slate-600 space-y-1">
            {warnings.filter((w) => w.severity !== 'blocking').map((w, i) => <div key={i}>• {w.title}: {w.message}</div>)}
          </div>
        )}

        <DialogFooter className="flex-col sm:flex-row gap-2">
          <Button variant="outline" className="flex-1" onClick={onCancel}>Cancel</Button>
          <Button variant="secondary" className="flex-1" onClick={onEdit}><Pencil className="w-4 h-4 mr-1" /> Edit</Button>
          <Button className="flex-1" onClick={onApply}><Check className="w-4 h-4 mr-1" /> Apply</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}