import { jsPDF } from 'jspdf';
import { getDailyGrid, computeCycle, computeHOS, fmtHours, fmtDur } from './hosEngine';

const STATUS_ROWS = ['OFF_DUTY', 'SLEEPER_BERTH', 'DRIVING', 'ON_DUTY'];
const STATUS_LABELS = {
  OFF_DUTY: 'OFF DUTY',
  SLEEPER_BERTH: 'SLEEPER BERTH',
  DRIVING: 'DRIVING',
  ON_DUTY: 'ON DUTY — NOT DRIVING',
};
const STATUS_COLORS = {
  OFF_DUTY: [120, 120, 120],
  SLEEPER_BERTH: [124, 58, 237],
  DRIVING: [37, 99, 235],
  ON_DUTY: [234, 88, 12],
};

const DVIR_CATS = [
  'Brakes', 'Steering', 'Tires', 'Wheels/Rims', 'Lights/Reflectors', 'Horn',
  'Windshield/Wipers', 'Mirrors', 'Coupling Devices / Fifth Wheel', 'Suspension',
  'Air System', 'Emergency Equipment', 'Trailer', 'Other',
];
const REPAIR_LABEL = {
  none: '',
  corrected: 'Corrected',
  not_required: 'Correction not required for safe operation',
  pending: 'Repair pending — vehicle should not be operated if unsafe',
};

// ---------------------------------------------------------------------------
// RODS — one daily page. Original LogbookAI layout styled after a traditional
// FMCSA paper driver's daily log. The 24-hour graph is the visual focus; HOS
// engine diagnostics live in a separate clean recap below the log.
// ---------------------------------------------------------------------------
function drawDay(doc, driver, carrier, events, dateStr, timezone, certification, cycleInfo, isFirst, cycleType) {
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 7; // margin
  const PW = W - 2 * M;
  if (!isFirst) doc.addPage();
  let y = M;

  const grid = getDailyGrid(events, dateStr, timezone);
  const hos = computeHOS(events, cycleType, timezone, grid.dayEnd, { historyComplete: true });

  // --- Title bar ---
  doc.setFontSize(15); doc.setFont(undefined, 'bold');
  doc.text("Driver's Record of Duty Status", M, y + 4.5);
  doc.setFontSize(7); doc.setFont(undefined, 'normal');
  doc.setTextColor(110);
  doc.text('LogbookAI · NOT an ELD · AI-assisted RODS · original layout', W - M, y + 4.5, { align: 'right' });
  doc.setTextColor(0);
  doc.setLineWidth(0.3); doc.line(M, y + 6, W - M, y + 6);
  y += 8;

  // --- Header grid: 4 columns x 3 rows of label/value, no license/plate ---
  const fields = [
    ['Driver', driver?.legal_name || ''],
    ['Date', dateStr],
    ['Carrier', carrier?.carrier_name || ''],
    ['USDOT', carrier?.usdot_number || ''],
    ['Home Terminal', carrier?.home_terminal_address || ''],
    ['Main Office', carrier?.main_office_address || ''],
    ['Tractor / Unit #', events.flatMap(e => e.tractor_number ? [e.tractor_number] : []).slice(-1)[0] || ''],
    ['Trailer #', [...new Set(events.map(e => e.trailer_numbers).filter(Boolean))].join(', ')],
    ['Total Miles', ''],
    ['Beg. Odometer', ''],
    ['End. Odometer', ''],
    ['Shipping / BOL', [...new Set(events.map(e => e.remark).filter(r => /bol|ship|commod/i.test(r || '')))].slice(0, 1)[0] || ''],
  ];
  const hdrH = 16, hdrCols = 4, colW = PW / hdrCols;
  doc.setLineWidth(0.2); doc.rect(M, y, PW, hdrH);
  for (let c = 1; c < hdrCols; c++) doc.line(M + c * colW, y, M + c * colW, y + hdrH);
  doc.line(M, y + hdrH / 2, M + PW, y + hdrH / 2); // mid line -> 4x... actually 2 rows of 4? we want 3 rows
  // redraw: clear and make 3 rows
  doc.setFillColor(255, 255, 255); doc.rect(M, y, PW, hdrH, 'F');
  doc.setLineWidth(0.2); doc.rect(M, y, PW, hdrH);
  const rowsN = 3, rhH = hdrH / rowsN;
  for (let c = 1; c < hdrCols; c++) doc.line(M + c * colW, y, M + c * colW, y + hdrH);
  for (let r = 1; r < rowsN; r++) doc.line(M, y + r * rhH, M + PW, y + r * rhH);
  doc.setFontSize(6.5);
  fields.forEach((f, i) => {
    const c = i % hdrCols, r = Math.floor(i / hdrCols);
    const x = M + c * colW + 1.5, yy = y + r * rhH;
    doc.setFont(undefined, 'bold'); doc.text(String(f[0]).toUpperCase(), x, yy + 2.6);
    doc.setFont(undefined, 'normal');
    const val = String(f[1] || '');
    doc.text(doc.splitTextToSize(val, colW - 3), x, yy + 5.0);
  });
  y += hdrH + 2.5;

  // --- 24-hour graph (main focus) ---
  // Fixed sufficient label column so "ON DUTY — NOT DRIVING" never overlaps the
  // plotted graph; the graph begins AFTER the label area.
  const labelW = 40, totalsW = 16;
  const graphLeft = M + labelW;
  const graphW = PW - labelW - totalsW;
  const axisH = 5.5;
  const rowH = 15;
  const graphTop = y + axisH;
  const graphH = 4 * rowH;

  // time axis labels + quarter ticks
  doc.setFontSize(6);
  for (let h = 0; h <= 24; h++) {
    const x = graphLeft + (h / 24) * graphW;
    const label = (h === 0 || h === 24) ? 'MID/12' : (h === 12 ? 'NOON/12' : String(h % 12 === 0 ? 12 : h % 12));
    doc.text(label, x, y + 3.2, { align: 'center' });
    doc.setLineWidth(0.2); doc.line(x, graphTop - 1.2, x, graphTop);
  }
  for (let q = 0; q <= 96; q++) {
    if (q % 4 === 0) continue; // hour ticks drawn above
    const x = graphLeft + (q / 96) * graphW;
    doc.setLineWidth(0.1); doc.line(x, graphTop - 0.8, x, graphTop);
  }

  // rows: label + light fill segments + totals
  STATUS_ROWS.forEach((s, i) => {
    const ry = graphTop + i * rowH;
    doc.setLineWidth(0.2);
    doc.rect(M, ry, labelW, rowH);           // label cell
    doc.rect(graphLeft, ry, graphW, rowH);    // graph cell (graph begins AFTER label area)
    doc.rect(M + labelW + graphW, ry, totalsW, rowH); // totals cell
    doc.setFontSize(7); doc.setFont(undefined, 'bold');
    doc.text(STATUS_LABELS[s], M + 2, ry + rowH / 2, { baseline: 'middle', maxWidth: labelW - 3 });
    doc.setFont(undefined, 'normal');
    doc.setFontSize(7);
    // light fill for segments (lightened color so the stepped line stays visible)
    const [r, g, b] = STATUS_COLORS[s];
    const lr = Math.round(r + (255 - r) * 0.82), lg = Math.round(g + (255 - g) * 0.82), lb = Math.round(b + (255 - b) * 0.82);
    doc.setFillColor(lr, lg, lb);
    for (const seg of grid.rows[s]) {
      const x1 = graphLeft + (seg.startHour / 24) * graphW;
      const x2 = graphLeft + (seg.endHour / 24) * graphW;
      doc.rect(x1, ry + 1, Math.max(0.4, x2 - x1), rowH - 2, 'F');
    }
    doc.setTextColor(0);
    const tv = Number.isFinite(grid.totals[s]) ? grid.totals[s] : 0;
    doc.text(`${tv.toFixed(2)}`, M + labelW + graphW + totalsW / 2, ry + rowH / 2, { align: 'center', baseline: 'middle' });
  });
  // graph outline
  doc.setLineWidth(0.3); doc.rect(graphLeft, graphTop, graphW, graphH);

  // stepped duty-status line
  const allSegs = [];
  STATUS_ROWS.forEach((status, i) => grid.rows[status].forEach(s => allSegs.push({ ...s, status, rowIdx: i })));
  allSegs.sort((a, b) => a.startHour - b.startHour);
  const xFor = (h) => graphLeft + (h / 24) * graphW;
  const cyFor = (i) => graphTop + i * rowH + rowH / 2;
  let prevX = null, prevY = null;
  doc.setLineWidth(1.0); doc.setDrawColor(20, 20, 20);
  allSegs.forEach((s) => {
    const x1 = xFor(s.startHour), x2 = xFor(s.endHour), yy = cyFor(s.rowIdx);
    if (prevX !== null) doc.line(prevX, prevY, x1, prevY);
    if (prevY !== null) doc.line(x1, prevY, x1, yy);
    doc.line(x1, yy, x2, yy);
    prevX = x2; prevY = yy;
  });
  y = graphTop + graphH + 3;

  // totals line (NaN-guarded; for a complete day the four totals sum to 24h)
  doc.setFontSize(7.5); doc.setFont(undefined, 'bold');
  doc.text(`Total Hours:`, M, y + 1);
  doc.setFont(undefined, 'normal');
  const safe = (v) => (Number.isFinite(v) ? v.toFixed(2) : '0.00');
  doc.text(`Off ${safe(grid.totals.OFF_DUTY)} · Sleeper ${safe(grid.totals.SLEEPER_BERTH)} · Driving ${safe(grid.totals.DRIVING)} · On Duty ${safe(grid.totals.ON_DUTY)} = ${safe(grid.totalHours)}`, M + 20, y + 1);
  y += 4.5;

  // --- Remarks / location timeline ---
  doc.setFontSize(8); doc.setFont(undefined, 'bold');
  doc.text('Remarks / Location', M, y + 1); doc.setFont(undefined, 'normal');
  doc.setLineWidth(0.2); doc.line(M, y + 2.2, W - M, y + 2.2);
  y += 4.5;
  doc.setFontSize(6.8);
  const remLimit = Math.min(grid.remarks.length, Math.floor((H - M - 34 - y) / 3.4));
  grid.remarks.slice(0, remLimit).forEach((r) => {
    const t = r.time.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: timezone });
    const line = `${t}  —  ${STATUS_LABELS[r.status]}${r.remark ? ' — ' + r.remark : ''}  —  ${[r.city, r.state].filter(Boolean).join(', ')}`;
    doc.text(doc.splitTextToSize(line, PW), M, y);
    y += 3.4;
  });

  // --- Certification (HOS Recap intentionally omitted from the daily PDF;
  // cycle/HOS calculations remain available in the app dashboard) ---
  let cy = Math.max(y + 4, H - 18);
  doc.setLineWidth(0.2); doc.line(M, cy, W - M, cy);
  doc.setFontSize(7.5);
  doc.setFont(undefined, 'bold'); doc.text('Driver Certification:', M, cy + 4); doc.setFont(undefined, 'normal');
  doc.text('I certify that the entries in this log are true and correct.', M + 30, cy + 4);
  if (certification) {
    doc.text(`Signed: ${certification.signature_name || ''}   ·   ${new Date(certification.certified_at).toLocaleString()}`, M, cy + 8);
    if (certification.signature_data && certification.signature_type === 'drawn') {
      try { doc.addImage(certification.signature_data, 'PNG', M + 60, cy - 1, 42, 9); } catch (e) {}
    }
  } else {
    doc.setTextColor(150); doc.text('Uncertified', M, cy + 8); doc.setTextColor(0);
  }
}

export function generateLogsPdf(driver, carrier, events, dateStrs, timezone, certifications, cycleType, options = {}) {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  dateStrs.forEach((dateStr, i) => {
    const cert = certifications.find(c => c.log_date === dateStr && !c.is_superseded);
    const cycle = computeCycle(events, cycleType, timezone, new Date(dateStr + 'T12:00:00'));
    drawDay(doc, driver, carrier, events, dateStr, timezone, cert, cycle, i === 0, cycleType);
  });

  if (options.includeDvir && options.dvirs && options.dvirs.length) {
    const inRange = options.dvirs.filter(d => dateStrs.includes(d.log_date));
    if (inRange.length) inRange.forEach(d => drawDvirPage(doc, driver, d));
  }
  if (options.includeDocs && options.documents && options.documents.length) {
    const inRange = options.documents.filter(d => dateStrs.includes(d.log_date));
    if (inRange.length) drawDocsAppendix(doc, inRange);
  }
  return doc;
}

// ---------------------------------------------------------------------------
// DVIR — clean printable inspection report, no overlapping text.
// ---------------------------------------------------------------------------
function drawDvirPage(doc, driver, d) {
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 9, PW = W - 2 * M;
  doc.addPage();
  let y = M;

  doc.setFontSize(15); doc.setFont(undefined, 'bold');
  doc.text('Driver Vehicle Inspection Report (DVIR)', M, y + 4.5);
  doc.setFontSize(7); doc.setFont(undefined, 'normal'); doc.setTextColor(110);
  doc.text('LogbookAI · NOT an ELD', W - M, y + 4.5, { align: 'right' });
  doc.setTextColor(0);
  doc.setLineWidth(0.3); doc.line(M, y + 6, W - M, y + 6);
  y += 10;

  // header grid: Driver / Date / Tractor / Trailer — each labelled, no overlap
  const hdrH = 20, cols = 2, colW = PW / cols;
  doc.setLineWidth(0.2); doc.rect(M, y, PW, hdrH);
  doc.line(M + colW, y, M + colW, y + hdrH); doc.line(M, y + hdrH / 2, M + PW, y + hdrH / 2);
  const cell = (label, value, x, yy) => {
    doc.setFontSize(6.5); doc.setFont(undefined, 'bold');
    doc.text(String(label).toUpperCase(), x + 2, yy + 3);
    doc.setFont(undefined, 'normal'); doc.setFontSize(9);
    doc.text(doc.splitTextToSize(String(value || ''), colW - 6), x + 2, yy + 8);
  };
  cell('Driver', driver?.legal_name || '', M, y);
  cell('Date', d.log_date || '', M + colW, y);
  cell('Tractor / Unit #', d.tractor_number || '', M, y + hdrH / 2);
  cell('Trailer #', d.trailer_numbers || '', M + colW, y + hdrH / 2);
  y += hdrH + 5;

  // inspection result with drawn checkboxes
  doc.setFontSize(9.5); doc.setFont(undefined, 'bold');
  doc.text('Inspection Result', M, y); doc.setFont(undefined, 'normal');
  y += 6;
  const drawCheck = (x, yy, checked) => {
    doc.setLineWidth(0.3); doc.rect(x, yy - 3.2, 3.5, 3.5);
    if (checked) { doc.setLineWidth(0.6); doc.line(x + 0.6, yy - 1.4, x + 1.6, yy - 2.6); doc.line(x + 1.6, yy - 2.6, x + 3, yy - 0.6); }
    doc.setLineWidth(0.2);
  };
  drawCheck(M, y, d.inspection_result === 'no_defects');
  doc.setFontSize(8.5); doc.text('No defects or deficiencies discovered/reported', M + 5, y);
  y += 6;
  drawCheck(M, y, d.inspection_result === 'defects');
  doc.text('Defects or deficiencies discovered/reported', M + 5, y);
  y += 8;

  if (d.inspection_result === 'defects') {
    doc.setFontSize(9.5); doc.setFont(undefined, 'bold');
    doc.text('Affected Items', M, y); doc.setFont(undefined, 'normal');
    y += 5;
    doc.setFontSize(7.5);
    const half = PW / 2;
    DVIR_CATS.forEach((c, i) => {
      const col = i % 2, row = Math.floor(i / 2);
      const x = M + col * half, yy = y + row * 5.2;
      drawCheck(x, yy, (d.defect_categories || []).includes(c));
      doc.text(c, x + 5, yy);
    });
    y += Math.ceil(DVIR_CATS.length / 2) * 5.2 + 3;

    doc.setFontSize(9.5); doc.setFont(undefined, 'bold');
    doc.text('Description', M, y); doc.setFont(undefined, 'normal');
    y += 5;
    doc.setLineWidth(0.2); doc.rect(M, y, PW, 16);
    doc.setFontSize(8); doc.text(doc.splitTextToSize(d.defect_description || '', PW - 4), M + 2, y + 5);
    y += 19;

    doc.setFontSize(9.5); doc.setFont(undefined, 'bold');
    doc.text('Repair Status', M, y); doc.setFont(undefined, 'normal');
    y += 6;
    doc.setFontSize(8.5);
    [['corrected', 'Corrected'], ['not_required', 'Correction not required for safe operation'], ['pending', 'Repair pending — vehicle should not be operated if unsafe']].forEach(([v, l]) => {
      drawCheck(M, y, d.repair_status === v);
      doc.text(l, M + 5, y);
      y += 5.5;
    });
    y += 2;
    if (d.repair_notes) {
      doc.setFontSize(8); doc.text(doc.splitTextToSize('Repair / Correction Notes: ' + d.repair_notes, PW), M, y);
      y += 8;
    }
  }

  // signatures — driver + optional mechanic, no overlap
  let sy = Math.max(y + 4, H - 30);
  doc.setLineWidth(0.2); doc.line(M, sy, W - M, sy);
  sy += 5;
  doc.setFontSize(8);
  const halfW = PW / 2;
  // driver
  doc.setFont(undefined, 'bold'); doc.text('Driver Signature', M, sy); doc.setFont(undefined, 'normal');
  doc.setLineWidth(0.2); doc.line(M, sy + 9, M + halfW - 10, sy + 9);
  if (d.driver_signature_data && String(d.driver_signature_data).startsWith('data:image')) {
    try { doc.addImage(d.driver_signature_data, 'PNG', M, sy - 1, 50, 9); } catch (e) {}
  } else {
    doc.text(d.driver_signature_name || '', M + 2, sy + 8);
  }
  doc.setFontSize(7); doc.text(`Date/time: ${new Date(d.driver_signed_at || Date.now()).toLocaleString()}`, M, sy + 13);
  // mechanic
  doc.setFontSize(8); doc.setFont(undefined, 'bold'); doc.text('Mechanic / Carrier Certification (optional)', M + halfW, sy); doc.setFont(undefined, 'normal');
  doc.setLineWidth(0.2); doc.line(M + halfW, sy + 9, W - M, sy + 9);
  if (d.mechanic_signature_data && String(d.mechanic_signature_data).startsWith('data:image')) {
    try { doc.addImage(d.mechanic_signature_data, 'PNG', M + halfW, sy - 1, 50, 9); } catch (e) {}
  } else {
    doc.text(d.mechanic_signature_name || '', M + halfW + 2, sy + 8);
  }
  doc.setFontSize(7); doc.text(`Date/time: ${d.mechanic_signed_at ? new Date(d.mechanic_signed_at).toLocaleString() : ''}`, M + halfW, sy + 13);
}

function drawDocsAppendix(doc, documents) {
  const W = doc.internal.pageSize.getWidth();
  const M = 9, PW = W - 2 * M;
  doc.addPage();
  let y = M;
  doc.setFontSize(13); doc.setFont(undefined, 'bold');
  doc.text('Supporting Documents', M, y + 4);
  doc.setFontSize(9); doc.setFont(undefined, 'normal');
  y += 10;
  doc.setFontSize(8);
  doc.text('Date', M, y); doc.text('Category', M + 32, y); doc.text('Description', M + 82, y);
  y += 4;
  doc.setLineWidth(0.2); doc.line(M, y, W - M, y); y += 4;
  documents.forEach((d) => {
    doc.text(String(d.log_date || ''), M, y, { maxWidth: 30 });
    doc.text(String(d.category || ''), M + 32, y, { maxWidth: 48 });
    doc.text(String(d.description || ''), M + 82, y, { maxWidth: PW - 82 });
    y += 5;
  });
}