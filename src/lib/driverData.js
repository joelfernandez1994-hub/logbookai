import { base44 } from '@/api/base44Client';
import { getTimelineEvents } from '@/lib/timelineData';
import { cachedRead, invalidateReads } from '@/lib/readCache';

// The three profile reads below are shared by every route mount — cached so
// tab navigation doesn't re-issue the same requests (see @/lib/readCache).
export async function getDriverProfile() {
  return cachedRead('driverProfile', async () => {
    const list = await base44.entities.DriverProfile.list('-created_date', 1);
    return list && list[0] ? list[0] : null;
  });
}

export async function getCarrierProfile() {
  return cachedRead('carrierProfile', async () => {
    const list = await base44.entities.CarrierProfile.list('-created_date', 1);
    return list && list[0] ? list[0] : null;
  });
}

export async function getEquipment() {
  return cachedRead('equipment', async () => await base44.entities.Equipment.list('-created_date', 50));
}

export async function getEvents(daysBack = 9) {
  return getTimelineEvents(daysBack);
}

export async function getAllEvents() {
  return await base44.entities.DutyStatusEvent.filter({}, '-start_timestamp', 5000);
}

export async function getCertifications(daysBack = 9) {
  return cachedRead('certifications', async () => {
    const all = await base44.entities.Certification.list('-certified_at', 200);
    return all || [];
  });
}

export async function getTrips() {
  return await base44.entities.Trip.list('-created_date', 100);
}

export async function getCurrentOngoingEvent(events) {
  return (events || []).find(e => e.is_ongoing && !e.end_timestamp);
}

export async function saveDriverProfile(data, existing) {
  const saved = existing && existing.id
    ? await base44.entities.DriverProfile.update(existing.id, data)
    : await base44.entities.DriverProfile.create(data);
  invalidateReads();
  return saved;
}

export async function saveCarrierProfile(data, existing) {
  const saved = existing && existing.id
    ? await base44.entities.CarrierProfile.update(existing.id, data)
    : await base44.entities.CarrierProfile.create(data);
  // Keep DriverProfile.home_terminal_timezone in sync with the authoritative
  // carrier zone so there's one consistent source. Display already reads the
  // carrier zone; this just keeps the stored driver field from going stale.
  // No event timestamps are rewritten.
  if (data.home_terminal_timezone) {
    try {
      const list = await base44.entities.DriverProfile.list('-created_date', 1);
      if (list && list[0] && list[0].home_terminal_timezone !== data.home_terminal_timezone) {
        await base44.entities.DriverProfile.update(list[0].id, { home_terminal_timezone: data.home_terminal_timezone });
      }
    } catch (e) { /* best-effort */ }
  }
  invalidateReads();
  return saved;
}

export async function saveEquipment(data) {
  const saved = await base44.entities.Equipment.create(data);
  invalidateReads();
  return saved;
}

export async function getAppSettings() {
  const list = await base44.entities.AppSettings.filter({ settings_key: 'global' }, '-created_date', 1);
  return list && list[0] ? list[0] : { ai_enabled_global: true, default_ai_allowance: 20, ruleset_version: 'US Interstate Property - Standard Federal Rules' };
}

export async function getAIUsage() {
  const month = new Date().toISOString().slice(0, 7);
  const list = await base44.entities.AIUsageLog.filter({ month }, '-created_date', 1);
  return list && list[0] ? list[0].count : 0;
}

export async function getAgriculturalClaims() {
  return cachedRead('agriculturalClaims', async () =>
    (await base44.entities.AgriculturalClaim.list('-created_date', 200)) || []);
}

export async function getDocuments(daysBack = 30) {
  return cachedRead(`documents:${daysBack}`, async () => {
    const all = await base44.entities.Document.list('-created_date', 500);
    if (!all) return [];
    const since = new Date(Date.now() - (daysBack + 1) * 24 * 3600000);
    return all.filter(d => !d.log_date || new Date(d.log_date + 'T12:00:00') >= since);
  });
}