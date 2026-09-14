import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { AlertTriangle, Check, Pencil, ShieldAlert } from 'lucide-react';
import { fmtDur, fmtHours } from '@/lib/hosEngine';
import { formatHour } from '@/lib/rodsEditor';
import { deriveHosDisplay } from '@/lib/proposalValidation';

const ROW_ORDER = ['OFF_DUTY', 'SLEEPER_BERTH', 'DRIVING', 'ON_DUTY'];
const STATUS_COLORS = {
  OFF_DUTY: '#64748b', SLEEPER_BERTH: '#7c3aed', DRIVING: '#2563eb', ON_DUTY: '#ea580c',
};

function MiniGraph({ segs, label }) {
  const W = 280, H = 96, pad = 4, rowH = 18;
  const x = (h) => pad + (h / 24) * (W - pad * 2);
  const grid = 'hsl(var(--graph-grid))';
  const rowLine = 'hsl(var(--graph-grid) / 0.5)';
  return (
    <div>
      <div className="text-[11px] font-medium text-muted-foreground mb-1">{label}</div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full rounded-md border border-border bg-graph">
        {[0, 6, 12, 18, 24].map((h) => (
          <line key={h} x1={x(h)} y1={pad} x2={x(h)} y2={H - pad} stroke={grid} strokeWidth={0.8} />
        ))}
        {ROW_ORDER.map((s, i) => (
          <g key={s}>
            <line x1={pad} y1={pad + i * rowH + rowH / 2} x2={W - pad} y2={pad + i * rowH + rowH / 2} stroke={rowLine} strokeWidth={rowH - 2} />
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

function HosCell({ cell, strong }) {
  if (!cell) return <span className="tabular-nums text-[#64748B]">—</span>;
  const unavail = cell.state === 'unavailable' || cell.state === 'unverified';
  const exhausted = cell.state === 'exhausted';
  return (
    <span className="block leading-tight">
      <span className={`tabular-nums ${unavail ? 'font-mono text-[#64748B]' : (exhausted ? 'text-error ' : (strong ? 'font-semibold ' : ''))}text-card-foreground`}>{unavail ? '—' : cell.value}</span>
      {unavail && <span className="block text-[10px] text-muted-foreground">{cell.state === 'unverified' ? 'Unverified' : 'Unavailable'}</span>}
    </span>
  );
}

export default function ProposedChangeDialog({ open, isCertified, beforeSegs, afterSegs, beforeHos, afterHos, historyComplete, warnings, violations, onApply, onEdit, onCancel }) {
  const blocking = (warnings || []).filter((w) => w.severity === 'blocking');
  // Canonical three-state HOS display (proposalValidation.deriveHosDisplay):
  // unavailable / unverified → '—' (never coerced to 0). This is the same
  // helper Today / Compliance / What-Can-I-Do use, so the Proposed Log Change
  // dialog can never again label an uncalculable placeholder zero as confirmed
  // exhaustion or "OK". HOS math (hosEngine) is untouched.
  const hosSummary = (hos) => {
    if (!hos) return [];
    const d = deriveHosDisplay(hos, historyComplete);
    const calc = !!d.calculable;
    const dash = { value: '—', state: 'unavailable', note: '' };
    const split = !calc ? dash : { value: hos.split?.status === 'active' ? 'Active' : (hos.split?.status === 'available' ? 'Available' : 'None'), state: 'real', note: '' };
    const restart = !calc ? dash : { value: hos.restart?.completed ? 'Completed' : (hos.restart?.inProgress ? 'In progress' : '—'), state: 'real', note: '' };
    return [
      { label: 'Driving remaining', cell: d.driving },
      { label: '14-hr window remaining', cell: d.window14 },
      { label: 'Cycle remaining', cell: d.cycle },
      { label: '30-min break', cell: d.break },
      { label: 'Split sleeper', cell: split },
      { label: '34h restart', cell: restart },
    ];
  };
  const beforeRows = hosSummary(beforeHos);
  const afterRows = hosSummary(afterHos);
  const hosUnavailable = beforeRows.some((r) => r.cell?.state === 'unavailable' || r.cell?.state === 'unverified')
    || afterRows.some((r) => r.cell?.state === 'unavailable' || r.cell?.state === 'unverified');

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="max-w-md max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="w-5 h-5 text-warning" /> Proposed Log Change
          </DialogTitle>
        </DialogHeader>

        {isCertified && (
          <div className="rounded-md bg-warning-surface border border-warning/50 p-2 text-xs text-warning-surface-foreground">
            This day is certified. Applying will preserve the previous event/version and certification in audit history, and mark the new log <b>Needs Re-Certification</b>.
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <MiniGraph segs={beforeSegs || []} label="Before" />
          <MiniGraph segs={afterSegs || []} label="After" />
        </div>

        <div className="rounded-lg border border-border p-2">
          <div className="grid grid-cols-3 gap-1 text-[11px] font-semibold text-muted-foreground mb-1">
            <div>HOS</div><div className="text-right">Before</div><div className="text-right">After</div>
          </div>
          {beforeRows.map((r, i) => (
            <div key={r.label} className="grid grid-cols-3 gap-1 text-xs py-0.5 items-center">
              <div className="text-muted-foreground">{r.label}</div>
              <div className="text-right"><HosCell cell={r.cell} /></div>
              <div className="text-right"><HosCell cell={(afterRows[i] || {}).cell} strong /></div>
            </div>
          ))}
        </div>

        {violations?.length > 0 && (
          <div className="rounded-lg border border-error/40 bg-error-surface p-2 text-xs text-error-surface-foreground space-y-1">
            <div className="font-semibold flex items-center gap-1"><AlertTriangle className="w-3.5 h-3.5" /> HOS Violations</div>
            {violations.map((v, i) => (
              <div key={i}>• {v.rule}: {v.message}</div>
            ))}
          </div>
        )}

        {blocking.length > 0 && (
          <div className="rounded-lg border border-warning/50 bg-warning-surface p-2 text-xs text-warning-surface-foreground space-y-1">
            <div className="font-semibold">Blocking checks:</div>
            {blocking.map((w, i) => (
              <div key={i}>• {w.title}: {w.message}</div>
            ))}
          </div>
        )}
        {warnings?.filter((w) => w.severity !== 'blocking').length > 0 && (
          <div className="rounded-lg border border-border bg-muted p-2 text-xs text-muted-foreground space-y-1">
            {warnings.filter((w) => w.severity !== 'blocking').map((w, i) => (
              <div key={i}>• {w.title}: {w.message}</div>
            ))}
          </div>
        )}

        {hosUnavailable && (
          <div className="rounded-md border border-error/50 bg-error-surface px-2.5 py-1.5 text-[11px] text-error-surface-foreground">
            HOS unavailable until the timeline is corrected — Apply remains enabled to allow this log correction.
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