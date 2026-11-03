import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Gauge } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { saveDriverProfile } from '@/lib/driverData';
import { MIN_AVERAGE_MPH, MAX_AVERAGE_MPH, isValidAverageMph, resolvePreferredMph } from '@/lib/mileageSpeed';

// Average Driving Speed (MPH) — the speed used when mileage has to be
// estimated from driving time. Defaults to 65 MPH; the driver may save any
// value from 25 to 90. Persisted on DriverProfile so it follows the driver
// across sessions and devices. Never alters saved mileage or historical logs.
export default function TripPreferencesCard({ profile, onSaved }) {
  const { t } = useTranslation();
  const [val, setVal] = useState(String(resolvePreferredMph(profile)));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { setVal(String(resolvePreferredMph(profile))); }, [profile?.average_driving_speed_mph]);

  const save = async () => {
    const n = Number(val);
    if (!isValidAverageMph(n)) {
      setError(t('settings.averageSpeedRange', { min: MIN_AVERAGE_MPH, max: MAX_AVERAGE_MPH }));
      return;
    }
    setError('');
    setSaving(true);
    try {
      await saveDriverProfile({ ...profile, average_driving_speed_mph: n }, profile);
      if (onSaved) await onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card p-4 mb-4">
      <div className="font-semibold text-sm mb-2 text-card-foreground flex items-center gap-2">
        <Gauge className="w-4 h-4" /> {t('settings.tripPreferences')}
      </div>
      <label htmlFor="avg-speed" className="text-xs text-muted-foreground">{t('settings.averageSpeedLabel')}</label>
      <div className="flex items-center gap-2 mt-1">
        <Input
          id="avg-speed"
          type="number"
          inputMode="numeric"
          min={MIN_AVERAGE_MPH}
          max={MAX_AVERAGE_MPH}
          value={val}
          onChange={(e) => { setVal(e.target.value); setError(''); }}
          className="w-24"
        />
        <Button size="sm" onClick={save} disabled={saving}>{saving ? t('common.saving') : t('common.save')}</Button>
      </div>
      {error && <div className="text-xs text-error mt-1">{error}</div>}
      <div className="text-[11px] text-muted-foreground mt-2">{t('settings.averageSpeedDescription')}</div>
    </div>
  );
}