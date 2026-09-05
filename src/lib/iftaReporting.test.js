// ============================================================================
// LogbookAI — IFTA Phase 2 reporting regression tests (vitest).
// Covers buildQuarterlyReport (pure aggregation), generateIftaCsv (pure string
// export reflecting exact underlying rows/provenance), and a PDF smoke test.
// ============================================================================
import { describe, it, expect } from 'vitest';
import { buildQuarterlyReport } from './iftaResolver';
import { generateIftaCsv } from './iftaCsv';
import { generateIftaReportPdf } from './iftaPdf';

const RECORDS = [
  { id: 'r1', log_date: '2026-07-01', jurisdiction: 'FL', miles: 42, mileage_source: 'route_estimated', confirmed: false },
  { id: 'r2', log_date: '2026-07-01', jurisdiction: 'GA', miles: 88, mileage_source: 'driver_confirmed', confirmed: true },
  { id: 'r3', log_date: '2026-07-05', jurisdiction: 'FL', miles: 60, mileage_source: 'driver_entered', confirmed: true },
];
const FUEL = { byState: [{ jurisdiction: 'GA', gallons: 118 }, { jurisdiction: 'FL', gallons: 20 }], totalGallons: 138 };

describe('buildQuarterlyReport', () => {
  it('aggregates totals per jurisdiction with confirmed/estimated split', () => {
    const report = buildQuarterlyReport({ quarter: '2026-Q3', records: RECORDS, fuel: FUEL });
    const fl = report.jurisdictions.find((j) => j.jurisdiction === 'FL');
    const ga = report.jurisdictions.find((j) => j.jurisdiction === 'GA');
    expect(fl.totalMiles).toBe(102);
    expect(fl.confirmedMiles).toBe(60);
    expect(fl.estimatedMiles).toBe(42);
    expect(fl.fullyConfirmed).toBe(false);
    expect(ga.totalMiles).toBe(88);
    expect(ga.fullyConfirmed).toBe(true);
  });

  it('computes grand totals, taxable miles (= total miles), fuel gallons, and MPG', () => {
    const report = buildQuarterlyReport({ quarter: '2026-Q3', records: RECORDS, fuel: FUEL });
    expect(report.totalMiles).toBe(190);
    expect(report.taxableMiles).toBe(report.totalMiles); // no non-taxable-mile distinction exists yet
    expect(report.totalGallons).toBe(138);
    expect(report.mpg).toBeCloseTo(190 / 138, 2);
    expect(report.fullyConfirmed).toBe(false); // FL still has an estimate
  });

  it('never fabricates a dollar tax-due figure — no such field exists on the report', () => {
    const report = buildQuarterlyReport({ quarter: '2026-Q3', records: RECORDS, fuel: FUEL });
    expect(report).not.toHaveProperty('taxDue');
    expect(report).not.toHaveProperty('tax_due');
  });

  it('reports fullyConfirmed:true only when every jurisdiction has zero estimated miles', () => {
    const allConfirmed = RECORDS.filter((r) => r.jurisdiction === 'GA');
    const report = buildQuarterlyReport({ quarter: '2026-Q3', records: allConfirmed, fuel: FUEL });
    expect(report.fullyConfirmed).toBe(true);
  });

  it('handles an empty quarter without throwing', () => {
    const report = buildQuarterlyReport({ quarter: '2026-Q1', records: [], fuel: { byState: [], totalGallons: 0 } });
    expect(report.totalMiles).toBe(0);
    expect(report.mpg).toBeNull();
    expect(report.jurisdictions).toEqual([]);
  });
});

describe('generateIftaCsv', () => {
  it('includes every underlying record with its provenance, and reflects the same totals as the report', () => {
    const report = buildQuarterlyReport({ quarter: '2026-Q3', records: RECORDS, fuel: FUEL });
    const csv = generateIftaCsv({ quarter: '2026-Q3', records: RECORDS, fuel: FUEL, report, generatedAt: new Date('2026-08-01T00:00:00Z') });
    expect(csv).toContain('2026-07-01,FL,42,route_estimated,no,');
    expect(csv).toContain('2026-07-01,GA,88,driver_confirmed,yes,');
    expect(csv).toContain('2026-07-05,FL,60,driver_entered,yes,');
    expect(csv).toContain('total_miles,190');
    expect(csv).toContain('taxable_miles,190');
    expect(csv).toContain('GA,118'); // fuel section
  });

  it('never claims LogbookAI files IFTA returns, and flags estimates as not exact', () => {
    const csv = generateIftaCsv({ quarter: '2026-Q3', records: [], fuel: { byState: [], totalGallons: 0 } });
    expect(csv).toMatch(/does not file IFTA reports/i);
    expect(csv).toMatch(/estimates/i);
  });

  it('escapes values containing commas or quotes safely', () => {
    const csv = generateIftaCsv({
      quarter: '2026-Q3',
      records: [{ log_date: '2026-07-01', jurisdiction: 'FL', miles: 10, mileage_source: 'driver_entered', confirmed: true, unit_number: 'Unit, "A"' }],
      fuel: { byState: [], totalGallons: 0 },
    });
    expect(csv).toContain('"Unit, ""A"""');
  });
});

describe('generateIftaReportPdf', () => {
  it('builds a PDF document without throwing, for a quarter with mixed provenance', () => {
    const report = buildQuarterlyReport({ quarter: '2026-Q3', records: RECORDS, fuel: FUEL });
    const doc = generateIftaReportPdf(report, { driver: { legal_name: 'Joel', ifta_base_jurisdiction: 'FL' }, carrier: { carrier_name: 'Test Carrier' } });
    const dataUri = doc.output('datauristring');
    expect(dataUri).toMatch(/^data:application\/pdf/);
  });

  it('builds a PDF for an empty quarter without throwing', () => {
    const report = buildQuarterlyReport({ quarter: '2026-Q1', records: [], fuel: { byState: [], totalGallons: 0 } });
    const doc = generateIftaReportPdf(report, {});
    expect(() => doc.output('datauristring')).not.toThrow();
  });
});
