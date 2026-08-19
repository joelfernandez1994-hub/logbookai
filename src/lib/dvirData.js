import { base44 } from '@/api/base44Client';

export async function getDvirs(daysBack = 9) {
  const since = new Date(Date.now() - (daysBack + 1) * 24 * 3600000);
  const all = await base44.entities.DVIR.list('-log_date', 500);
  return (all || []).filter(d => new Date(d.log_date + 'T12:00:00') >= since);
}

export async function getAllDvirs() {
  return await base44.entities.DVIR.list('-log_date', 500);
}

export async function saveDvir(data) {
  const payload = {
    ...data,
    has_safety_defect: data.inspection_result === 'defects' && data.repair_status !== 'corrected' && data.repair_status !== 'not_required',
    driver_signed_at: data.driver_signed_at || new Date().toISOString(),
  };
  if (data.id) return await base44.entities.DVIR.update(data.id, payload);
  return await base44.entities.DVIR.create(payload);
}

export async function deleteDvir(id) {
  return await base44.entities.DVIR.delete(id);
}