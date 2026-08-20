import { base44 } from '@/api/base44Client';

export async function getDriverProfile() {
  const list = await base44.entities.DriverProfile.list('-created_date', 1);
  return list && list[0] ? list[0] : null;
}

export async function getCarrierProfile() {
  const list = await base44.entities.CarrierProfile.list('-created_date', 1);
  return list && list[0] ? list[0] : null;
}

export async function getEquipment() {
  return await base44.entities.Equipment.list('-created_date', 50);
}

export async function getEvents(daysBack = 9) {
  const since = new Date(Date.now() - (daysBack + 1) * 24 * 3600000);
  const all = await base44.entities.DutyStatusEvent.filter({}, '-start_timestamp', 3000);
  return (all || []).filter(e => new Date(e.start_timestamp) >= since);
}

export async function getAllEvents() {
  return await base44.entities.DutyStatusEvent.filter({}, '-start_timestamp', 5000);
}

export async function getCertifications(daysBack = 9) {
  const all = await base44.entities.Certification.list('-certified_at', 200);
  return all || [];
}

export async function getTrips() {
  return await base44.entities.Trip.list('-created_date', 100);
}

export async function getCurrentOngoingEvent(events) {
  return (events || []).find(e => e.is_ongoing && !e.end_timestamp);
}

export async function changeStatus(newStatus, details = {}) {
  const events = await base44.entities.DutyStatusEvent.filter({ is_ongoing: true }, '-start_timestamp', 50);
  const now = new Date().toISOString();
  const startTs = details.start_timestamp || now;
  const logDate = startTs.slice(0, 10);
  // End EVERY currently-ongoing event at the new status start (there should be
  // exactly one, but corrupted V2 data can leave several — close them all so
  // the timeline stays single-status).
  if (events && events.length) {
    await Promise.all(events.map((ongoing) =>
      base44.entities.DutyStatusEvent.update(ongoing.id, {
        end_timestamp: startTs,
        is_ongoing: false,
      })
    ));
  }
  // Guard against an exact duplicate (same start time + status) already existing.
  const startMs = new Date(startTs).getTime();
  const existing = await base44.entities.DutyStatusEvent.filter({}, '-start_timestamp', 500);
  const dup = (existing || []).some(e =>
    e && e.duty_status === newStatus && e.start_timestamp &&
    Math.abs(new Date(e.start_timestamp).getTime() - startMs) < 1000);
  if (dup) return existing.find(e => e.duty_status === newStatus && e.start_timestamp && Math.abs(new Date(e.start_timestamp).getTime() - startMs) < 1000);
  return await base44.entities.DutyStatusEvent.create({
    log_date: logDate,
    start_timestamp: startTs,
    duty_status: newStatus,
    city: details.city || '',
    state: details.state || '',
    remark: details.remark || '',
    tractor_number: details.tractor_number || '',
    trailer_numbers: details.trailer_numbers || '',
    carrier_name: details.carrier_name || '',
    method_of_creation: details.method_of_creation || 'Manual',
    is_ongoing: true,
    is_current_version: true,
  });
}

export async function createHistoricalEvent(data) {
  return await base44.entities.DutyStatusEvent.create({
    ...data,
    is_ongoing: false,
    is_current_version: true,
  });
}

export async function updateEvent(id, data) {
  return await base44.entities.DutyStatusEvent.update(id, data);
}

export async function deleteEvent(id) {
  return await base44.entities.DutyStatusEvent.delete(id);
}

export async function saveDriverProfile(data, existing) {
  if (existing && existing.id) {
    return await base44.entities.DriverProfile.update(existing.id, data);
  }
  return await base44.entities.DriverProfile.create(data);
}

export async function saveCarrierProfile(data, existing) {
  if (existing && existing.id) {
    return await base44.entities.CarrierProfile.update(existing.id, data);
  }
  return await base44.entities.CarrierProfile.create(data);
}

export async function saveEquipment(data) {
  return await base44.entities.Equipment.create(data);
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

export async function getDocuments(daysBack = 30) {
  const all = await base44.entities.Document.list('-created_date', 500);
  if (!all) return [];
  const since = new Date(Date.now() - (daysBack + 1) * 24 * 3600000);
  return all.filter(d => !d.log_date || new Date(d.log_date + 'T12:00:00') >= since);
}