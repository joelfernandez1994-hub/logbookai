import { jsPDF } from 'jspdf';
import { getDailyGrid, computeCycle, computeHOS, fmtHours, fmtDur } from './hosEngine';

const STATUS_ROWS = ['OFF_DUTY', 'SLEEPER_BERTH', 'DRIVING', 'ON_DUTY'];
const STATUS_LABELS = { OFF_DUTY: 'OFF DUTY', SLEEPER_BERTH: 'SLEEPER', DRIVING: 'DRIVING', ON_DUTY: 'ON DUTY' };

function drawDay(doc, driver, carrier, events, dateStr, timezone, certification, cycleInfo, isFirst, cycleType) {
  const W = doc.internal.pageSize.getWidth();
  const margin = 8;
  if (!isFirst) doc.addPage();
  let y = margin;
  const grid = getDailyGrid(events, dateStr, timezone);
  const hos = computeHOS(events, cycleType, timezone, grid.dayEnd, { historyComplete: true });

  doc.setFontSize(14); doc.setFont(undefined, 'bold');
  doc.text("Driver's Record of Duty Status", margin, y + 4);
  doc.setFontSize(8); doc.setFont(undefined, 'normal');
  doc.text('LogbookAI · NOT an ELD · AI-assisted RODS', W - margin, y + 4, { align: 'right' });
  y += 8;

  doc.setFontSize(8);
  const info = [
    `Driver: ${driver?.legal_name || ''}`, `Date: ${dateStr}`,
    `Carrier: ${carrier?.carrier_name || ''}`, `USDOT: ${carrier?.usdot_number || ''}`,
    `Home Terminal: ${carrier?.home_terminal_address || ''}`, `Office: ${carrier?.main_office_address || ''}`,
    `Tractor: ${events[0]?.tractor_number || ''}`, `Trailers: ${[...new Set(events.map(e => e.trailer_numbers).filter(Boolean))].join(', ')}`,
  ];
  doc.rect(margin, y, W - 2 * margin, 14);
  info.forEach((line, i) => {
    const x = margin + 2 + (i % 4) * (W - 2 * margin) / 4;
    const yy = y + 4 + Math.floor(i / 4) * 5;
    doc.text(line, x, yy);
  });
  y += 16;

  const graphLeft = margin + 22;
  const graphW = W - 2 * margin - 22;
  const graphTop = y;
  const rowH = 14;
  STATUS_ROWS.forEach((s, i) => {
    const ry = graphTop + i * rowH;
    doc.rect(margin, ry, 22, rowH); doc.rect(graphLeft, ry, graphW, rowH);
    doc.text(STATUS_LABELS[s], margin + 2, ry + rowH / 2 + 1, { baseline: 'middle' });
    doc.setFontSize(6);
    doc.text(`${grid.totals[s].toFixed(2)}h`, graphLeft + graphW - 6, ry + rowH / 2 + 1, { align: 'right', baseline: 'middle' });
    doc.setFontSize(8);
  });
  for (let h = 0; h <= 24; h += 2) {
    const x = graphLeft + (h / 24) * graphW;
    doc.line(x, graphTop, x, graphTop + 4 * rowH);
    if (h % 6 === 0) doc.text(h === 0 ? '12A' : h === 12 ? 'N' : h === 24 ? '12A' : `${h}`, x, graphTop - 1, { align: 'center' });
  }
  const allSegs = [];
  STATUS_ROWS.forEach((status, i) => grid.rows[status].forEach(s => allSegs.push({ ...s, status, rowIdx: i })));
  allSegs.sort((a, b) => a.startHour - b.startHour);
  const xFor = (h) => graphLeft + (h / 24) * graphW;
  const cyFor = (i) => graphTop + i * rowH + rowH / 2;
  let prevX = null, prevY = null;
  doc.setLineWidth(0.6);
  allSegs.forEach((s) => {
    const x1 = xFor(s.startHour), x2 = xFor(s.endHour), yy = cyFor(s.rowIdx);
    if (prevX !== null) doc.line(prevX, prevY, x1, prevY);
    if (prevY !== null) doc.line(x1, prevY, x1, yy);
    doc.line(x1, yy, x2, yy);
    prevX = x2; prevY = yy;
  });
  let yy = graphTop + 4 * rowH + 6;
  doc.setFontSize(8);
  doc.text(`Totals: Off ${grid.totals.OFF_DUTY.toFixed(2)} · Sleeper ${grid.totals.SLEEPER_BERTH.toFixed(2)} · Driving ${grid.totals.DRIVING.toFixed(2)} · On Duty ${grid.totals.ON_DUTY.toFixed(2)} = ${grid.totalHours.toFixed(2)}h`, margin, yy);
  yy += 5;
  if (cycleInfo) {
    doc.setFont(undefined, 'bold');
    doc.text(`${cycleInfo.cycleLimit}-Hour / ${cycleInfo.cycleDays}-Day Recap`, margin, yy);
    doc.setFont(undefined, 'normal');
    doc.text(`Today: ${(cycleInfo.dailyTotals[cycleInfo.dailyTotals.length - 1]?.onDutyHours || 0).toFixed(2)} · Used: ${cycleInfo.cycleUsedHours.toFixed(2)} · Available: ${cycleInfo.cycleRemainingHours.toFixed(2)} · Back tomorrow: ${cycleInfo.returningTomorrowHours.toFixed(2)}`, margin + 50, yy);
    yy += 5;
  }
  const splitLabel = hos.split.status === 'active' ? 'Split sleeper active (clocks recalculated)' : hos.split.status === 'incomplete' ? 'Split sleeper incomplete' : 'No split pairing';
  doc.text(`Driving rem: ${fmtDur(hos.driving.drivingRemainingMs)} · 14-hr window rem: ${fmtDur(hos.window14.remainingMs)} · ${splitLabel}`, margin, yy);
  yy += 5;
  doc.text('Remarks:', margin, yy); yy += 4;
  doc.setFontSize(7);
  grid.remarks.slice(0, 28).forEach((r) => {
    const t = r.time.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: timezone });
    doc.text(`${t} ${STATUS_LABELS[r.status]} ${r.city || ''}${r.state ? ',' : ''} ${r.state || ''}${r.remark ? ' — ' + r.remark : ''}`, margin + 2, yy, { maxWidth: W - 2 * margin });
    yy += 3.5;
  });
  yy = Math.max(yy + 2, doc.internal.pageSize.getHeight() - 16);
  doc.setFontSize(8);
  if (certification) {
    doc.text(`Certified: ${new Date(certification.certified_at).toLocaleString()} — ${certification.signature_name}`, margin, yy);
    if (certification.signature_data && certification.signature_type === 'drawn') {
      try { doc.addImage(certification.signature_data, 'PNG', margin + 100, yy - 8, 40, 10); } catch (e) {}
    }
  } else {
    doc.text('Uncertified', margin, yy);
  }
  doc.text('I certify that these entries are true and correct.', margin, yy + 5);
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
    if (inRange.length) drawDvirSection(doc, driver, inRange);
  }
  if (options.includeDocs && options.documents && options.documents.length) {
    const inRange = options.documents.filter(d => dateStrs.includes(d.log_date));
    if (inRange.length) drawDocsAppendix(doc, inRange);
  }
  return doc;
}

function drawDvirSection(doc, driver, dvirs) {
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const margin = 8;
  const CATS = ['Brakes', 'Steering', 'Tires', 'Wheels/Rims', 'Lights/Reflectors', 'Horn', 'Windshield/Wipers', 'Mirrors', 'Coupling Devices / Fifth Wheel', 'Suspension', 'Air System', 'Emergency Equipment', 'Trailer', 'Other'];
  const REPAIR = { none: '', corrected: 'Corrected', not_required: 'Correction not required', pending: 'Repair pending' };
  dvirs.forEach((d, idx) => {
    doc.addPage();
    let y = margin;
    doc.setFontSize(13); doc.setFont(undefined, 'bold');
    doc.text('Driver Vehicle Inspection Report (DVIR)', margin, y + 4);
    doc.setFontSize(8); doc.setFont(undefined, 'normal');
    doc.text('LogbookAI · NOT an ELD', W - margin, y + 4, { align: 'right' });
    y += 9;
    doc.setFontSize(9);
    doc.rect(margin, y, W - 2 * margin, 16);
    const info = [
      `Driver: ${driver?.legal_name || ''}`, `Date: ${d.log_date}`,
      `Tractor / Unit #: ${d.tractor_number || ''}`, `Trailer(s): ${d.trailer_numbers || ''}`,
    ];
    info.forEach((line, i) => { doc.text(line, margin + 3, y + 5 + (i % 2) * 6); });
    y += 20;

    doc.setFont(undefined, 'bold'); doc.text('Inspection Result', margin, y); doc.setFont(undefined, 'normal');
    y += 4;
    doc.text(d.inspection_result === 'no_defects' ? '[X] No defects or deficiencies discovered/reported' : '[X] Defects or deficiencies discovered/reported', margin, y);
    y += 6;

    if (d.inspection_result === 'defects') {
      doc.setFont(undefined, 'bold'); doc.text('Affected Items', margin, y); doc.setFont(undefined, 'normal'); y += 5;
      doc.setFontSize(8);
      CATS.forEach((c) => { doc.text(`${(d.defect_categories || []).includes(c) ? '[X]' : '[ ]'} ${c}`, margin + 2 + (CATS.indexOf(c) % 2) * (W - 2 * margin) / 2, y + Math.floor(CATS.indexOf(c) / 2) * 4); });
      y += Math.ceil(CATS.length / 2) * 4 + 2;
      doc.setFontSize(9);
      doc.setFont(undefined, 'bold'); doc.text('Describe Defect / Deficiency', margin, y); doc.setFont(undefined, 'normal'); y += 4;
      doc.text(d.defect_description || '', margin, y, { maxWidth: W - 2 * margin }); y += 8;
      doc.setFont(undefined, 'bold'); doc.text('Repair Status', margin, y); doc.setFont(undefined, 'normal'); y += 4;
      doc.text(REPAIR[d.repair_status] || '', margin, y); y += 6;
      if (d.repair_notes) { doc.setFont(undefined, 'bold'); doc.text('Repair / Correction Notes', margin, y); doc.setFont(undefined, 'normal'); y += 4; doc.text(d.repair_notes, margin, y, { maxWidth: W - 2 * margin }); y += 8; }
    }

    y = Math.min(y + 4, H - 22);
    doc.setFontSize(8);
    doc.setFont(undefined, 'bold'); doc.text('Driver Signature', margin, y); doc.setFont(undefined, 'normal');
    doc.text(d.driver_signature_name || '', margin, y + 4);
    doc.text(new Date(d.driver_signed_at || Date.now()).toLocaleString(), margin, y + 8);
    if (d.driver_signature_data && String(d.driver_signature_data).startsWith('data:image')) {
      try { doc.addImage(d.driver_signature_data, 'PNG', margin + 50, y - 2, 40, 12); } catch (e) {}
    }
    if (d.mechanic_signature_name) {
      doc.setFont(undefined, 'bold'); doc.text('Mechanic / Carrier Certification', W / 2, y); doc.setFont(undefined, 'normal');
      doc.text(d.mechanic_signature_name, W / 2, y + 4);
      doc.text(new Date(d.mechanic_signed_at || Date.now()).toLocaleString(), W / 2, y + 8);
    }
  });
}

function drawDocsAppendix(doc, documents) {
  const W = doc.internal.pageSize.getWidth();
  const margin = 8;
  doc.addPage();
  let y = margin;
  doc.setFontSize(13); doc.setFont(undefined, 'bold');
  doc.text('Supporting Documents', margin, y + 4);
  doc.setFontSize(9); doc.setFont(undefined, 'normal');
  y += 10;
  doc.text('Date', margin, y); doc.text('Category', margin + 30, y); doc.text('Description', margin + 80, y);
  y += 4;
  doc.setLineWidth(0.2); doc.line(margin, y, W - margin, y); y += 4;
  doc.setFontSize(8);
  documents.forEach((d) => {
    doc.text(String(d.log_date || ''), margin, y, { maxWidth: 28 });
    doc.text(String(d.category || ''), margin + 30, y, { maxWidth: 48 });
    doc.text(String(d.description || ''), margin + 80, y, { maxWidth: W - margin - 80 });
    y += 5;
  });
}