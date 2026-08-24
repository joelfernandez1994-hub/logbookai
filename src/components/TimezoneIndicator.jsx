import { indicatorText } from '@/lib/timezones';

// Subtle, persistent indicator of the log's timezone so drivers understand
// why displayed log times may differ from the local clock where they are.
// Display-only; no logic coupling. Renders e.g. "Log timezone: Eastern Time (ET)".
export default function TimezoneIndicator({ tz, className = '', prefix = 'Log timezone' }) {
  if (!tz) return null;
  return (
    <div className={`text-[11px] text-muted-foreground ${className}`}>
      {prefix}: {indicatorText(tz)}
    </div>
  );
}