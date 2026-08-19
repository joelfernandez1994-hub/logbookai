export default function ClockCard({ label, value, sublabel, status = 'normal', icon: Icon }) {
  const tone = {
    normal: 'border-slate-200 bg-white text-slate-900',
    warning: 'border-amber-300 bg-amber-50 text-amber-900',
    critical: 'border-red-400 bg-red-50 text-red-900',
    good: 'border-emerald-200 bg-emerald-50 text-emerald-900',
  }[status];
  return (
    <div className={`rounded-xl border p-3 ${tone}`}>
      <div className="flex items-center gap-1.5 text-xs font-medium opacity-80">
        {Icon && <Icon className="w-3.5 h-3.5" />}
        {label}
      </div>
      <div className="text-xl font-bold mt-0.5 tabular-nums">{value}</div>
      {sublabel && <div className="text-[11px] opacity-70 mt-0.5">{sublabel}</div>}
    </div>
  );
}