import { useState, useEffect, useCallback } from 'react';
import {
  getDriverProfile, getCarrierProfile, getEquipment,
} from '@/lib/driverData';
import { getTimelineEvents } from '@/lib/timelineData';

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