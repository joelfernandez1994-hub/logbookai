import { useState, useEffect, useCallback } from 'react';
import {
  getDriverProfile, getCarrierProfile, getEquipment,
} from '@/lib/driverData';
import { getTimelineEvents } from '@/lib/timelineData';
import { setAppLanguage } from '@/i18n';

export function useDriverData(daysBack = 9) {
  const [profile, setProfile] = useState(null);
  const [carrier, setCarrier] = useState(null);
  const [equipment, setEquipment] = useState([]);
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const [p, c, eq, ev] = await Promise.all([
        getDriverProfile(), getCarrierProfile(), getEquipment(), getTimelineEvents(daysBack),
      ]);
      setProfile(p);
      // Central sync point: every page using this hook picks up the driver's
      // saved display-language preference without each page wiring it up
      // itself. Presentation only — never touches stored duty-status data.
      if (p?.language) setAppLanguage(p.language);
      setCarrier(c);
      setEquipment(eq || []);
      setEvents(ev || []);
      setError(null);
    } catch (e) {
      setError(e.message || 'Failed to load data');
    } finally {
      setLoading(false);
    }
  }, [daysBack]);

  useEffect(() => { load(); }, [load]);

  return { profile, carrier, equipment, events, loading, error, reload: load, setEvents };
}