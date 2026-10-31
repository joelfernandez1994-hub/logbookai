import { base44 } from '@/api/base44Client';
import { cachedRead, invalidateReads } from '@/lib/readCache';

export async function getDvirs(daysBack = 9) {
  return cachedRead(`dvirs:${daysBack}`, async () => {
    const since = new Date(Date.now() - (daysBack + 1) * 24 * 3600000);
    const all = await base44.entities.DVIR.list('-log_date', 500);
    return (all || []).filter(d => new Date(d.log_date + 'T12:00:00') >= since);
  });
}

export async function getAllDvirs() {
  return cachedRead('dvirs:all', async () => (await base44.entities.DVIR.list('-log_date', 500)) || []);
}

export async function saveDvir(data) {
  const payload = {
    ...data,
    has_safety_defect: data.inspection_result === 'defects' && data.repair_status !== 'corrected' && data.repair_status !== 'not_required',
    driver_signed_at: data.driver_signed_at || new Date().toISOString(),
  };
  const saved = data.id
    ? await base44.entities.DVIR.update(data.id, payload)
    : await base44.entities.DVIR.create(payload);
  invalidateReads();
  return saved;
}

export async function deleteDvir(id) {
  const res = await base44.entities.DVIR.delete(id);
  invalidateReads();
  return res;
}