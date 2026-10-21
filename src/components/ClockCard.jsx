export default function ClockCard({ label, value, sublabel, status = 'normal', icon: Icon, note }) {
  const tone = {
    normal: 'border-border bg-card text-card-foreground',
    warning: 'border-warning/50 bg-warning-surface text-warning-surface-foreground',
    critical: 'border-error/50 bg-error-surface text-error-surface-foreground',
    good: 'border-success/40 bg-success-surface text-success-surface-foreground',
    disabled: 'border-border bg-muted text-muted-foreground',
  }[status];
  return (
    <div className={`rounded-xl border p-3 ${tone}`}>
      <div className="flex items-center gap-1.5 text-xs font-medium opacity-80">
        {Icon && <Icon className="w-3.5 h-3.5" />}
        {label}
      </div>
      <div className="text-xl font-bold mt-0.5 tabular-nums">{value}</div>
      {sublabel && <div className="text-[11px] opacity-70 mt-0.5">{sublabel}</div>}
      {note && <div className="text-[10px] opacity-60 mt-1 leading-snug">{note}</div>}
    </div>
  );
}