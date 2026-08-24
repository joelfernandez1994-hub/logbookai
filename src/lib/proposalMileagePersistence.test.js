import { describe, it, expect, vi, beforeEach } from 'vitest';

const records = [];
vi.mock('@/api/base44Client', () => ({
  base44: { entities: { DailySummary: {
    filter: vi.fn(async ({ log_date }) => records.filter(record => record.log_date === log_date)),
    create: vi.fn(async data => { const record = { id: `d${records.length + 1}`, ...data }; records.push(record); return record; }),
    update: vi.fn(async (id, data) => { const index = records.findIndex(record => record.id === id); records[index] = { ...records[index], ...data }; return records[index]; }),
  } } },
}));

import { saveProposalMiles } from './tripSync';

const DAY = '2026-08-20';
beforeEach(() => { records.length = 0; });

describe('proposal mileage persistence', () => {
  it('saves unedited proposal mileage as auto', async () => {
    await saveProposalMiles(DAY, 375, false);
    expect(records[0]).toMatchObject({ log_date: DAY, miles: 375, miles_source: 'auto' });
  });

  it('saves driver-edited proposal mileage as manual', async () => {
    await saveProposalMiles(DAY, 380, true);
    expect(records[0]).toMatchObject({ log_date: DAY, miles: 380, miles_source: 'manual' });
  });

  it('does not overwrite an existing manual value with an auto proposal', async () => {
    records.push({ id: 'manual', log_date: DAY, miles: 400, miles_source: 'manual' });
    const result = await saveProposalMiles(DAY, 375, false);
    expect(result.skippedManual).toBe(true);
    expect(records[0]).toMatchObject({ miles: 400, miles_source: 'manual' });
  });
});