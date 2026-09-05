// ============================================================================
// LogbookAI — IFTA quarterly report PDF. Reads a `report` object produced by
// buildQuarterlyReport() in iftaResolver.js — same numbers as the on-screen
// review and the CSV export, never a separate calculation. Mirrors the manual
// jsPDF drawing style already used for the RODS export (pdfGenerator.js)
// rather than pulling in a table plugin, since this is a single simple table.
// ============================================================================
import { jsPDF } from 'jspdf';

export function generateIftaReportPdf(report, { driver, carrier, generatedAt = new Date() } = {}) {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const W = doc.internal.pageSize.getWidth();
  const M = 14;
  let y = M;

  doc.setFontSize(16); doc.setFont(undefined, 'bold');
  doc.text('IFTA Quarterly Mileage & Fuel Summary', M, y);
  y += 6;
  doc.setFontSize(10); doc.setFont(undefined, 'normal');
  doc.text(`Quarter: ${report.quarter}`, M, y);
  doc.text(`Generated: ${generatedAt.toLocaleDateString()}`, W - M, y, { align: 'right' });
  y += 6;
  doc.setFontSize(9); doc.setTextColor(90);
  doc.text(`${driver?.legal_name || ''}${carrier?.carrier_name ? ' — ' + carrier.carrier_name : ''}`, M, y);
  if (driver?.ifta_base_jurisdiction || driver?.ifta_account_number) {
    y += 4;
    doc.text(`Base jurisdiction: ${driver?.ifta_base_jurisdiction || '—'}   IFTA account #: ${driver?.ifta_account_number || '—'}`, M, y);
  }
  doc.setTextColor(0);
  y += 6;
  doc.setLineWidth(0.3); doc.line(M, y, W - M, y);
  y += 6;

  // --- Disclaimers (always shown, never omitted) ---
  doc.setFontSize(8); doc.setTextColor(120);
  const disclaimers = [
    'Route-estimated and odometer-derived mileage are estimates calculated from mapped roads, not exact GPS records. Driver-entered/confirmed values are authoritative.',
    'LogbookAI does not file IFTA reports with any jurisdiction. This report organizes mileage and fuel data for your own filing; it does not calculate tax due.',
  ];
  for (const d of disclaimers) {
    const lines = doc.splitTextToSize(d, W - 2 * M);
    doc.text(lines, M, y);
    y += lines.length * 3.6 + 1.5;
  }
  doc.setTextColor(0);
  y += 3;

  // --- Summary tiles ---
  doc.setFontSize(9);
  const tiles = [
    ['Total miles', `${report.totalMiles}`],
    ['Taxable miles*', `${report.taxableMiles}`],
    ['Confirmed miles', `${report.totalConfirmedMiles}`],
    ['Estimated miles', `${report.totalEstimatedMiles}`],
    ['Total fuel (gal)', `${report.totalGallons}`],
    ['Average MPG', report.mpg != null ? `${report.mpg}` : 'n/a'],
  ];
  const tileW = (W - 2 * M) / 3;
  tiles.forEach(([label, val], i) => {
    const col = i % 3, rowI = Math.floor(i / 3);
    const x = M + col * tileW;
    const ty = y + rowI * 14;
    doc.setFont(undefined, 'normal'); doc.setTextColor(110);
    doc.text(label, x, ty);
    doc.setFont(undefined, 'bold'); doc.setTextColor(0); doc.setFontSize(12);
    doc.text(val, x, ty + 5);
    doc.setFontSize(9);
  });
  y += Math.ceil(tiles.length / 3) * 14 + 2;
  doc.setFontSize(7); doc.setTextColor(120);
  doc.text('*Taxable miles equal total logged miles — LogbookAI does not currently distinguish non-taxable mileage (e.g. off-highway, personal conveyance).', M, y);
  doc.setTextColor(0);
  y += 6;

  // --- Jurisdiction table ---
  doc.setLineWidth(0.2);
  const cols = [
    { key: 'jurisdiction', label: 'Jurisdiction', w: 28 },
    { key: 'totalMiles', label: 'Total mi', w: 22 },
    { key: 'confirmedMiles', label: 'Confirmed mi', w: 28 },
    { key: 'estimatedMiles', label: 'Estimated mi', w: 28 },
    { key: 'fuelGallons', label: 'Fuel (gal)', w: 24 },
    { key: 'status', label: 'Status', w: 32 },
  ];
  const tableW = cols.reduce((s, c) => s + c.w, 0);
  let x0 = M;
  doc.setFont(undefined, 'bold'); doc.setFontSize(9);
  cols.forEach((c) => { doc.text(c.label, x0 + 1, y); x0 += c.w; });
  y += 1.5; doc.line(M, y, M + tableW, y); y += 4;
  doc.setFont(undefined, 'normal');

  const addPageIfNeeded = () => {
    if (y > doc.internal.pageSize.getHeight() - 20) { doc.addPage(); y = M; }
  };

  for (const j of report.jurisdictions) {
    addPageIfNeeded();
    x0 = M;
    const cells = {
      jurisdiction: j.jurisdiction,
      totalMiles: String(j.totalMiles),
      confirmedMiles: String(j.confirmedMiles),
      estimatedMiles: String(j.estimatedMiles),
      fuelGallons: String(j.fuelGallons),
      status: j.fullyConfirmed ? 'Fully confirmed' : 'Contains estimates',
    };
    cols.forEach((c) => {
      if (c.key === 'status' && !j.fullyConfirmed) { doc.setTextColor(180, 120, 0); }
      doc.text(cells[c.key], x0 + 1, y);
      doc.setTextColor(0);
      x0 += c.w;
    });
    y += 5;
  }
  if (!report.jurisdictions.length) {
    doc.setTextColor(120);
    doc.text('No jurisdiction mileage resolved yet for this quarter.', M, y);
    doc.setTextColor(0);
    y += 5;
  }
  y += 1.5; doc.line(M, y, M + tableW, y);

  return doc;
}
