import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

// Mobile-friendly month calendar for jumping between Daily Logs dates.
// Pure selection UI: receives the selected date key and "today" in the
// logbook timezone, and reports picked days via onSelect(dateKey).
// Future dates (after `maxDateStr`) are disabled so completed activity can
// never be recorded ahead of time.
const pad2 = (n) => String(n).padStart(2, '0');
const keyOf = (y, m, d) => `${y}-${pad2(m + 1)}-${pad2(d)}`;

export default function LogCalendarPicker({ open, onOpenChange, selectedDateStr, maxDateStr, tz, onSelect }) {
  const { t, i18n } = useTranslation();
  const [view, setView] = useState(() => {
    const [y, m] = (selectedDateStr || '').split('-').map(Number);
    return { y: y || new Date().getFullYear(), m: (m || new Date().getMonth() + 1) - 1 };
  });

  // Re-center the view on the selected date each time the picker opens.
  useEffect(() => {
    if (!open) return;
    const [y, m] = (selectedDateStr || '').split('-').map(Number);
    setView({ y: y || new Date().getFullYear(), m: (m || new Date().getMonth() + 1) - 1 });
  }, [open, selectedDateStr]);

  const cells = useMemo(() => {
    const startDow = new Date(view.y, view.m, 1).getDay(); // 0 = Sunday (US)
    const daysInMonth = new Date(view.y, view.m + 1, 0).getDate();
    const arr = [];
    for (let i = 0; i < startDow; i++) arr.push(null);
    for (let d = 1; d <= daysInMonth; d++) arr.push(keyOf(view.y, view.m, d));
    return arr;
  }, [view]);

  const weekdayLabels = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(i18n.language || 'en', { weekday: 'short' });
    // Jan 1, 2023 was a Sunday — a stable anchor for Sun..Sat labels.
    return [0, 1, 2, 3, 4, 5, 6].map((i) => fmt.format(new Date(2023, 0, 1 + i)));
  }, [i18n.language]);

  const locale = i18n.language || 'en';
  const monthLabel = new Date(view.y, view.m, 1).toLocaleDateString(locale, { month: 'long', year: 'numeric' });

  const moveMonth = (delta) => {
    setView((v) => {
      const d = new Date(v.y, v.m + delta, 1);
      return { y: d.getFullYear(), m: d.getMonth() };
    });
  };

  const pick = (key) => {
    if (!key || key > maxDateStr) return;
    onSelect(key);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xs sm:max-w-sm p-4 rounded-2xl">
        <DialogHeader>
          <DialogTitle className="text-base font-semibold text-card-foreground">{t('logs.pickDate')}</DialogTitle>
        </DialogHeader>

        <div className="flex items-center justify-between mb-1">
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => moveMonth(-1)} aria-label={t('logs.prevMonth')}>
            <ChevronLeft className="w-4 h-4" />
          </Button>
          <div className="text-sm font-semibold text-foreground">{monthLabel}</div>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => moveMonth(1)} aria-label={t('logs.nextMonth')}>
            <ChevronRight className="w-4 h-4" />
          </Button>
        </div>

        <div className="grid grid-cols-7 gap-0.5 text-center text-[10px] text-muted-foreground mb-1">
          {weekdayLabels.map((w, i) => <div key={i} className="py-1">{w}</div>)}
        </div>
        <div className="grid grid-cols-7 gap-1">
          {cells.map((key, i) => {
            if (!key) return <div key={`e${i}`} />;
            const isFuture = key > maxDateStr;
            const isSelected = key === selectedDateStr;
            const isToday = key === maxDateStr;
            return (
              <button key={key}
                onClick={() => pick(key)}
                disabled={isFuture}
                className={`min-h-[36px] rounded-lg border text-xs font-medium transition-colors
                  ${isSelected
                    ? 'border-primary bg-accent text-accent-foreground'
                    : isToday
                      ? 'border-primary/50 text-primary font-semibold'
                      : 'border-border text-card-foreground hover:bg-accent/50'}
                  ${isFuture ? 'opacity-35' : ''}`}>
                {Number(key.slice(8))}
                {isToday && !isSelected && <span className="block mx-auto w-1 h-1 rounded-full bg-primary mt-0.5" />}
              </button>
            );
          })}
        </div>

        <Button variant="outline" className="w-full mt-2" onClick={() => pick(maxDateStr)}>
          {t('logs.today')}
        </Button>
        <div className="text-[10px] text-muted-foreground text-center">{t('logs.calendarTimezoneNote')}</div>
      </DialogContent>
    </Dialog>
  );
}