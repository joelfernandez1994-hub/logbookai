// ============================================================================
// LogbookAI — IFTA CSV export. Pure string-building, no browser/DOM APIs, so
// it's independently testable; the caller (Ifta.jsx) turns the string into a
// download. Exports reflect the EXACT underlying IftaJurisdictionMileage rows
// (one row per log_date+jurisdiction) with their provenance, plus a fuel
// section and a totals section computed the same way as the on-screen report
// (buildQuarterlyReport in iftaResolver.js) — never a second, divergent
// calculation.
// ============================================================================

function esc(val) {
  const s = val == null ? '' : String(val);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function row(cells) {
  return cells.map(esc).join(',') + '\r\n';
}

export function generateIftaCsv({ quarter, records = [], fuel = { byState: [], totalGallons: 0 }, report, generatedAt = new Date() }) {
  let out = '';
  out += row(['LogbookAI IFTA Export']);
  out += row(['Quarter', quarter]);
  out += row(['Generated', generatedAt.toISOString()]);
  out += row(['Note', 'Route-estimated and odometer-derived mileage are estimates, not exact GPS records. Driver-entered/confirmed values are authoritative and take precedence.']);
  out += row(['Note', 'LogbookAI does not file IFTA reports with any jurisdiction. This export organizes your mileage and fuel data for your own filing.']);
  out += '\r\n';

  out += row(['Mileage by day and jurisdiction (underlying IFTA records)']);
  out += row(['log_date', 'jurisdiction', 'miles', 'mileage_source', 'confirmed', 'unit_number']);
  const sorted = [...records].sort((a, b) => (a.log_date < b.log_date ? -1 : a.log_date > b.log_date ? 1 : (a.jurisdiction < b.jurisdiction ? -1 : 1)));
  for (const r of sorted) {
    out += row([r.log_date, r.jurisdiction, r.miles, r.mileage_source, r.confirmed ? 'yes' : 'no', r.unit_number || '']);
  }
  out += '\r\n';

  out += row(['Fuel by jurisdiction (from logged fuel receipts — not duplicated entry)']);
  out += row(['jurisdiction', 'gallons']);
  for (const f of (fuel.byState || [])) {
    out += row([f.jurisdiction, f.gallons]);
  }
  out += '\r\n';

  if (report) {
    out += row(['Totals']);
    out += row(['total_miles', report.totalMiles]);
    out += row(['taxable_miles', report.taxableMiles]);
    out += row(['total_miles_confirmed', report.totalConfirmedMiles]);
    out += row(['total_miles_estimated', report.totalEstimatedMiles]);
    out += row(['total_gallons', report.totalGallons]);
    out += row(['average_mpg', report.mpg ?? '']);
    out += row(['fully_confirmed', report.fullyConfirmed ? 'yes' : 'no']);
  }

  return out;
}
