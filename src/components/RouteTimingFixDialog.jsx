import { useState, useEffect } from 'react';
import { Wrench, AlertTriangle, Check, Clock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import LogGraph from '@/components/LogGraph';
import { buildRouteTimingFix } from '@/lib/routeTimingFix';
import { applyRouteTimingCorrection } from '@/lib/timelineWriter';

const STATUS_LABELS = { OFF_DUTY: 'Off Duty', SLEEPER_BERTH: 'Sleeper', DRIVING: 'Driving', ON_DUTY: 'On Duty' };

function fmtClock(iso, tz) {
  if (!iso) return 'ongoing';
  try {
    return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz });
  } catch {
    return '--';
  }
}

// Review-before-persist dialog for the canonical Logs "Fix route timing" flow.
// All reconstruction + validation runs in memory (buildRouteTimingFix). Nothing
// is written until the driver presses Apply, at which point the entire approved
// correction is persisted as ONE logical correction through the canonical
// timelineWriter (applyRouteTimingCorrection) — preserving the EventVersion
// audit trail and invalidating certification exactly like a normal correction.
export default function RouteTimingFixDialog({ open, onClose, onApplied, events, dateStr, tz, speedProfile, carrierName, editedBy }) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) { setResult(null); setError(''); return; }
    let mounted = true;
    setLoading(true);
    setError('');
    buildRouteTimingFix(events, { dateStr, tz, speedProfile, now: new Date() })
      .then((r) => { if (mounted) setResult(r); })
      .catch((e) => { if (mounted) setError(e?.message || 'Could not build the correction.'); })
      .finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, [open, events, dateStr, tz, speedProfile]);

  const manualReview = result?.gapConflicts?.length > 0;
  const canApply = result?.fixable && (result?.changes?.length || 0) > 0 && !manualReview && !applying;

  const apply = async () => {
    if (!canApply) return;
    setApplying(true);
    setError('');
    try {
      const res = await applyRouteTimingCorrection(events, dateStr, tz, result.corrected, {
        carrierName,
        editedBy,
        reason: 'Fix route timing',
      });
      if (res?.error) { setError(res.error); setApplying(false); return; }
      onApplied?.();
      onClose?.();
    } catch (e) {
      setError(e?.message || 'Failed to apply the correction.');
      setApplying(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!applying && !o) onClose?.(); }}>
      <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Wrench className="w-4 h-4" /> Fix route timing</DialogTitle>
        </DialogHeader>

        {loading && <div className="text-sm text-muted-foreground py-6 text-center">Calculating routed truck times…</div>}

        {error && (
          <div className="rounded-md bg-error-surface border border-error/50 p-2 text-xs text-error-surface-foreground flex gap-1">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> <div>{error}</div>
          </div>
        )}

        {!loading && result && (
          <div className="space-y-3">
            {manualReview ? (
              <div className="rounded-lg border border-warning/50 bg-warning-surface p-2 text-xs text-warning-surface-foreground flex gap-1.5">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <div>
                  <div className="font-semibold mb-0.5">Manual review needed</div>
                  <div>Reconstructing the inferred times would collide with an explicitly logged event. LogbookAI will not move an explicit time. Review the times or locations by hand instead.</div>
                  <ul className="mt-1 list-disc ml-4 space-y-0.5">
                    {result.gapConflicts.map((g, i) => <li key={i}>{g.message}</li>)}
                  </ul>
                </div>
              </div>
            ) : (
              <>
                <div className="text-xs text-muted-foreground">
                  Adjusts only AI-inferred driving times to match the routed truck-realistic duration. Explicit times you entered are never moved.
                </div>

                <div className="rounded-lg border border-border p-2">
                  <div className="text-xs text-muted-foreground mb-1">Before</div>
                  <LogGraph events={result.dayEvents} dateStr={dateStr} timezone={tz} interactive={false} />
                </div>
                <div className="rounded-lg border border-border p-2">
                  <div className="text-xs text-muted-foreground mb-1">After <span className="opacity-70">(preview — not yet saved)</span></div>
                  <LogGraph events={result.corrected} dateStr={dateStr} timezone={tz} interactive={false} />
                </div>

                <div className="rounded-lg border border-border p-2">
                  <div className="text-xs font-semibold text-card-foreground mb-1 flex items-center gap-1"><Clock className="w-3.5 h-3.5" /> Timestamp changes</div>
                  <div className="space-y-1">
                    {result.changes.map((c, i) => (
                      <div key={i} className="text-xs flex items-start gap-2">
                        <span className="font-mono text-muted-foreground shrink-0 w-16">{STATUS_LABELS[c.duty_status]}</span>
                        <span className="flex-1">
                          <span className="line-through text-muted-foreground">{fmtClock(c.beforeStart, tz)}–{fmtClock(c.beforeEnd, tz)}</span>
                          <span className="mx-1 text-muted-foreground">→</span>
                          <span className="text-card-foreground font-medium">{fmtClock(c.afterStart, tz)}–{fmtClock(c.afterEnd, tz)}</span>
                          <span className="text-[10px] text-muted-foreground ml-1">{[c.city, c.state].filter(Boolean).join(', ')}</span>
                        </span>
                      </div>
                    ))}
                    {result.changes.length === 0 && <div className="text-xs text-muted-foreground">No timestamp changes needed.</div>}
                  </div>
                </div>

                {result.remainingConflicts.length > 0 && (
                  <div className="rounded-lg border border-warning/50 bg-warning-surface p-2 text-xs text-warning-surface-foreground">
                    <div className="font-semibold mb-0.5">Remaining route/time warnings after the fix</div>
                    {result.remainingConflicts.map((c, i) => (
                      <div key={i}>{c.origin} → {c.destination}: {c.message}</div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={applying}>Cancel</Button>
          {canApply && (
            <Button onClick={apply} disabled={applying}>
              <Check className="w-4 h-4 mr-1" /> {applying ? 'Applying…' : 'Apply correction'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}