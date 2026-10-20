import { AlertTriangle, PencilLine } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatUnresolvedRange } from '@/lib/restHistoryVerification';

// Exact, actionable notice for rest history that could NOT be verified.
// Shows the precise interval that prevents verification and a direct route
// to timeline correction (onEdit prefills the editor — nothing is ever
// written automatically and gaps are never filled). Renders nothing when
// verification succeeded, so verified histories stay visually quiet.
export default function RestHistoryNotice({ verification, tz, onEdit }) {
  if (!verification || verification.status !== 'unverified') return null;
  const range = verification.unresolvedRange;
  return (
    <div data-testid="rest-history-notice" className="rounded-xl border border-warning/50 bg-warning-surface p-3 mb-3 flex gap-2">
      <AlertTriangle className="w-4 h-4 text-warning mt-0.5 shrink-0" />
      <div className="flex-1">
        <div className="text-xs font-semibold text-warning-surface-foreground">HOS rest history unverified</div>
        <div className="text-xs text-warning-surface-foreground opacity-90 mt-0.5">
          {range ? (
            <>The 11-hour and 14-hour clocks cannot be verified — the timeline has an unlogged stretch from <span className="font-medium">{formatUnresolvedRange(range, tz)}</span>. No qualifying rest can be traced contiguously through it.</>
          ) : (
            <>The 11-hour and 14-hour clocks cannot be verified — no qualifying 10-hour reset or split-sleeper pair exists in the contiguous timeline before your driving.</>
          )}
        </div>
        <div className="text-[11px] text-warning-surface-foreground opacity-80 mt-0.5">LogbookAI never fills gaps or invents Off Duty time — enter what actually happened.</div>
        {onEdit && (
          <Button size="sm" variant="outline" className="mt-2 h-7 text-[11px] px-2 border-warning/50 text-warning-surface-foreground hover:bg-warning/10" onClick={onEdit}>
            <PencilLine className="w-3 h-3 mr-1" /> Add the missing record
          </Button>
        )}
      </div>
    </div>
  );
}