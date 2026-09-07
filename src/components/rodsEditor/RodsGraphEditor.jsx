import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { getDailyGrid, computeHOS } from '@/lib/hosEngine';
import {
  daySegments, planDayInsertion, planEdit, applyOps, buildAfterEvents,
  validateTimeline, snapHour, hourToX,
} from '@/lib/rodsEditor';
import { applyTimelineOps } from '@/lib/timelineWriter';
import { computeGraphLayout, getLabelIntervalHours, LEFT_W } from '@/lib/rodsGraphLayout';
import EventSheet from './EventSheet';
import ProposedChangeDialog from './ProposedChangeDialog';
import TimeBubble from './TimeBubble';
import { Button } from '@/components/ui/button';
import { Pencil, Eye, ShieldCheck, GripVertical } from 'lucide-react';

const ROW_ORDER = ['OFF_DUTY', 'SLEEPER_BERTH', 'DRIVING', 'ON_DUTY'];
const STATUS_COLORS = {
  OFF_DUTY: '#64748b', SLEEPER_BERTH: '#7c3aed', DRIVING: '#2563eb', ON_DUTY: '#ea580c',
};
const STATUS_LABELS = { OFF_DUTY: 'Off', SLEEPER_BERTH: 'Sleeper', DRIVING: 'Drive', ON_DUTY: 'On' };
// TOP_PAD/ROW_H are presentation-only pixel dimensions (not timeline/event
// math) — ROW_H raised from 52 so the four duty-status rows have more
// visual breathing room on a phone-width graph, closer to a real paper
// logbook grid than a compressed mini-chart.
const TOP_PAD = 24, ROW_H = 64;

const C = {
  gridStrong: 'hsl(var(--graph-grid))',
  gridMid: 'hsl(var(--graph-grid) / 0.7)',
  gridFaint: 'hsl(var(--graph-grid) / 0.35)',
  labels: 'hsl(var(--graph-labels))',
  bg: 'hsl(var(--graph-background))',
  bgAlt: 'hsl(var(--graph-grid) / 0.12)',
  rowBorder: 'hsl(var(--graph-grid))',
  fg: 'hsl(var(--foreground))',
  gripBg: 'hsl(var(--primary))',
  gripFg: 'hsl(var(--primary-foreground))',
};

export default function RodsGraphEditor({
  events = [], dateStr, timezone = 'America/Chicago', readOnly = false,
  carrier, equipment, profile, certifications = [], reload,
}) {
  const { t } = useTranslation();
  const tz = timezone;
  const cycleType = carrier?.hos_cycle || '70_8';

  const grid = useMemo(() => getDailyGrid(events, dateStr, tz), [events, dateStr, tz]);
  const dayStartMs = grid.dayStart.getTime();
  const dayEndMs = grid.dayEnd.getTime();

  const dayEvents = useMemo(() => events.filter((e) => {
    if (!e.start_timestamp) return false;
    const es = new Date(e.start_timestamp).getTime();
    const ee = e.end_timestamp ? new Date(e.end_timestamp).getTime() : dayEndMs;
    return ee > dayStartMs && es < dayEndMs;
  }).map((e) => e.end_timestamp ? e : { ...e, end_timestamp: new Date(dayEndMs).toISOString() }),
  [events, dayStartMs, dayEndMs]);

  const daySegs = useMemo(() => ROW_ORDER.flatMap((status) =>
    grid.rows[status].map((s) => ({
      id: s.id, status, startMs: s.start.getTime(), endMs: s.end.getTime(),
      startHour: s.startHour, endHour: s.endHour,
    }))
  ).sort((a, b) => a.startMs - b.startMs), [grid]);
  const totals = grid.totals;

  const [mode, setMode] = useState('view');
  const [containerW, setContainerW] = useState(360);
  const [draft, setDraft] = useState(null);
  const [bubble, setBubble] = useState(null);
  const [sheetValue, setSheetValue] = useState(null);
  const [proposed, setProposed] = useState(null);

  const scrollRef = useRef(null);
  const contentRef = useRef(null);
  const rowsRef = useRef(null);
  const gesture = useRef(null);
  const lastClientX = useRef(null);
  const rafRef = useRef(0);

  useEffect(() => {
    const el = scrollRef.current; if (!el) return;
    const ro = new ResizeObserver(() => setContainerW(el.clientWidth));
    ro.observe(el); setContainerW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const editMode = mode === 'edit' && !readOnly;
  // Always fits the full 24h day into the available width, in both view and
  // edit mode — see rodsGraphLayout.js for why edit mode intentionally no
  // longer zooms/scrolls.
  const { visibleHours, pxPerHour, graphW, contentW } = useMemo(
    () => computeGraphLayout(containerW),
    [containerW]
  );
  // Presentation only: how many hours apart a TEXT label is drawn on the
  // hour ruler. The grid itself (hour tick lines + quarter ticks) is always
  // full density regardless of this — only which ticks additionally get a
  // "12A"/"3A"/... label shrinks on a narrow phone so labels never overlap.
  const labelIntervalHours = useMemo(() => getLabelIntervalHours(containerW), [containerW]);
  const rowTop = (i) => TOP_PAD + i * ROW_H;
  const x = (h) => LEFT_W + hourToX(h, pxPerHour);

  const evalNow = useMemo(() => dayEndMs <= Date.now() ? new Date(dayEndMs) : new Date(),
    [dayEndMs]);
  const beforeHos = useMemo(() => computeHOS(events, cycleType, tz, evalNow, { historyComplete: true }),
    [events, cycleType, tz, evalNow]);

  const hourFromClientX = useCallback((clientX) => {
    if (!rowsRef.current) return 0;
    const rect = rowsRef.current.getBoundingClientRect();
    return Math.max(0, Math.min(24, (clientX - rect.left) / pxPerHour));
  }, [pxPerHour]);

  // ---- auto-scroll while dragging near edges ----
  const startAutoScroll = useCallback(() => {
    const tick = () => {
      if (!gesture.current) { rafRef.current = 0; return; }
      const sc = scrollRef.current;
      const cx = lastClientX.current;
      if (sc && cx != null) {
        const vr = sc.getBoundingClientRect();
        const edge = 48;
        const rightDist = vr.right - cx;
        const leftDist = cx - vr.left;
        let dx = 0;
        if (rightDist < edge) dx = (edge - rightDist) * 0.4;
        else if (leftDist < edge) dx = -(edge - leftDist) * 0.4;
        if (dx) sc.scrollLeft += dx;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    if (!rafRef.current) rafRef.current = requestAnimationFrame(tick);
  }, []);
  const stopAutoScroll = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
  }, []);

  useEffect(() => () => stopAutoScroll(), [stopAutoScroll]);

  // ---- pointer handlers (shared by rows + handles) ----
  const onPointerMove = useCallback((e) => {
    const g = gesture.current; if (!g) return;
    lastClientX.current = e.clientX;
    const dx = Math.abs(e.clientX - g.startClientX);
    const dy = Math.abs(e.clientY - g.startClientY);
    if (dx > 4 || dy > 8) g.moved = true;
    const hour = hourFromClientX(e.clientX);
    if (g.type === 'draw') {
      g.endHour = hour;
      setDraft({ status: g.status, startHour: g.startHour, endHour: hour });
      setBubble({ x: e.clientX, y: e.clientY, startHour: g.startHour, endHour: hour, status: g.status, color: STATUS_COLORS[g.status] });
    } else if (g.type === 'handle') {
      let s = g.which === 'start' ? hour : g.otherHour;
      let e2 = g.which === 'end' ? hour : g.otherHour;
      if (e2 <= s) return;
      s = snapHour(s, 1); e2 = snapHour(e2, 1);
      setSheetValue((sv) => sv ? { ...sv, startMs: dayStartMs + s * 3600000, endMs: dayStartMs + e2 * 3600000 } : sv);
      setBubble({ x: e.clientX, y: e.clientY, startHour: s, endHour: e2, status: g.status, color: STATUS_COLORS[g.status] });
    }
  }, [hourFromClientX, dayStartMs]);

  const onPointerUp = useCallback((e) => {
    const g = gesture.current; gesture.current = null;
    stopAutoScroll(); setBubble(null);
    if (!g) return;
    if (g.type === 'handle') return;
    setDraft(null);
    if (!g.moved) {
      // tap -> edit existing segment at this hour
      const seg = daySegs.find((s) => g.startHour >= s.startHour - 0.01 && g.startHour < s.endHour);
      if (seg) openEdit(seg);
      return;
    }
    let lo = Math.min(g.startHour, g.endHour), hi = Math.max(g.startHour, g.endHour);
    lo = snapHour(lo, 1); hi = snapHour(hi, 1);
    if (hi - lo < 1 / 60) return;
    openNew(g.status, lo, hi);
  }, [daySegs, stopAutoScroll]);

  const onPointerDownRow = (e, status) => {
    if (readOnly || mode !== 'edit') return;
    e.preventDefault();
    const hour = hourFromClientX(e.clientX);
    gesture.current = { type: 'draw', status, startHour: hour, endHour: hour, startClientX: e.clientX, startClientY: e.clientY, moved: false, pointerId: e.pointerId };
    setDraft({ status, startHour: hour, endHour: hour });
    setBubble({ x: e.clientX, y: e.clientY, endHour: hour, status, color: STATUS_COLORS[status] });
    lastClientX.current = e.clientX;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) {}
    startAutoScroll();
  };

  const onHandleDown = (e, which) => {
    if (readOnly || mode !== 'edit') return;
    e.stopPropagation(); e.preventDefault();
    if (!sheetValue) return;
    const startHour = (sheetValue.startMs - dayStartMs) / 3600000;
    const endHour = (sheetValue.endMs - dayStartMs) / 3600000;
    gesture.current = { type: 'handle', which, status: sheetValue.status, otherHour: which === 'start' ? endHour : startHour, startClientX: e.clientX, startClientY: e.clientY, moved: true, pointerId: e.pointerId };
    lastClientX.current = e.clientX;
    setBubble({ x: e.clientX, y: e.clientY, startHour, endHour, status: sheetValue.status, color: STATUS_COLORS[sheetValue.status] });
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) {}
    startAutoScroll();
  };

  // ---- open sheets ----
  const openNew = (status, lo, hi) => {
    setSheetValue({
      status, startMs: dayStartMs + lo * 3600000, endMs: dayStartMs + hi * 3600000,
      city: '', state: '', remark: '', activity: '', tractor_number: '', trailer_numbers: '',
      eventId: null, isNew: true,
    });
  };
  const openEdit = (seg) => {
    const ev = dayEvents.find((e) => e.id === seg.id);
    setSheetValue({
      status: seg.status, startMs: seg.startMs, endMs: seg.endMs,
      city: ev?.city || '', state: ev?.state || '', remark: ev?.remark || '',
      activity: ev?.remark && ['Pre-Trip', 'Fuel', 'Loading', 'Unloading', 'Post-Trip', 'Trailer Exchange', 'Maintenance'].includes(ev.remark) ? ev.remark : '',
      tractor_number: ev?.tractor_number || '', trailer_numbers: ev?.trailer_numbers || '',
      eventId: seg.id, isNew: false,
    });
  };

  const patchSheet = (patch) => setSheetValue((sv) => sv ? { ...sv, ...patch } : sv);

  // ---- review -> proposed change ----
  const review = () => {
    const sv = sheetValue; if (!sv) return;
    const newEvent = {
      log_date: dateStr,
      start_timestamp: new Date(sv.startMs).toISOString(),
      end_timestamp: new Date(sv.endMs).toISOString(),
      duty_status: sv.status,
      city: sv.city || '', state: sv.state || '',
      remark: sv.activity && sv.activity !== 'Other' ? sv.activity : (sv.remark || ''),
      tractor_number: sv.tractor_number || '', trailer_numbers: sv.trailer_numbers || '',
    };
    const ops = sv.eventId ? planEdit(dayEvents, sv.eventId, newEvent) : planDayInsertion(dayEvents, newEvent);
    const afterEvents = buildAfterEvents(events, dayEvents, ops);
    const afterHos = computeHOS(afterEvents, cycleType, tz, evalNow, { historyComplete: true });
    const val = validateTimeline(afterEvents, { cycleType, tz, now: evalNow });
    setProposed({
      ops,
      beforeSegs: daySegments(dayEvents, dayStartMs, dayEndMs),
      afterSegs: daySegments(applyOps(dayEvents, ops), dayStartMs, dayEndMs),
      beforeHos, afterHos,
      warnings: val.warnings, violations: val.violations,
      isCertified: !!certifications.find((c) => c.log_date === dateStr && !c.is_superseded),
    });
  };

  const applyProposed = async () => {
    const p = proposed; if (!p) return;
    const editedBy = profile?.legal_name || '';
    // Route through the canonical writer: applies deletes/updates/creates in
    // order, preserves EventVersion audit snapshots for certified-day edits,
    // and invalidates the active Certification for every affected log_date.
    await applyTimelineOps(p.ops, events, {
      editedBy,
      reason: 'Graph edit',
      carrierName: carrier?.carrier_name || '',
      createVersions: true,
    });
    setProposed(null); setSheetValue(null); setDraft(null);
    reload && reload();
  };

  const sheetStartHour = sheetValue ? (sheetValue.startMs - dayStartMs) / 3600000 : 0;
  const sheetEndHour = sheetValue ? (sheetValue.endMs - dayStartMs) / 3600000 : 0;

  const hourLabels = []; for (let h = 0; h <= 24; h++) hourLabels.push(h);

  return (
    <div className="select-none">
      {/* mode bar */}
      <div className="flex items-center justify-between mb-2">
        {readOnly ? (
          <div className="flex items-center gap-2 text-xs font-semibold text-primary bg-accent border border-border rounded-lg px-3 py-1.5">
            <ShieldCheck className="w-4 h-4" /> READ ONLY — INSPECTION MODE
          </div>
        ) : (
          <div className="flex gap-1.5">
            <Button size="sm" variant={editMode ? 'secondary' : 'outline'} onClick={() => setMode('view')}><Eye className="w-3.5 h-3.5 mr-1" />{t('rodsEditor.view')}</Button>
            <Button size="sm" variant={editMode ? 'default' : 'outline'} onClick={() => setMode('edit')}><Pencil className="w-3.5 h-3.5 mr-1" />{t('rodsEditor.editLogGraph')}</Button>
          </div>
        )}
        <div className="text-[11px] text-muted-foreground">{visibleHours >= 24 ? 'Full 24h' : `~${visibleHours}h view · swipe ↔`}</div>
      </div>

      {editMode && (
        <div className="text-[11px] text-warning-surface-foreground bg-warning-surface border border-warning/50 rounded-md px-2.5 py-1.5 mb-2">
          <b>{t('rodsEditor.editMode')}</b> — Press a row and drag to draw. Tap a segment to edit.
        </div>
      )}

      {editMode && (
        <div className="h-28 mb-2" data-testid="graph-drag-readout-slot">
          {bubble && <TimeBubble startHour={bubble.startHour} endHour={bubble.endHour} status={bubble.status} color={bubble.color} />}
        </div>
      )}

      {/* graph — overflow-hidden, not auto: the graph always fits exactly
          (computeGraphLayout), so there is never a legitimate reason to
          scroll; leaving overflow-x as "auto" only invited a stray 1px-
          rounding scrollbar to reappear. */}
      <div ref={scrollRef} className="overflow-hidden rounded-lg border border-border bg-graph">
        <div ref={contentRef} style={{ width: contentW, position: 'relative', height: TOP_PAD + ROW_H * 4 + 6 }}>
          {/* hour ruler (scrolls) */}
          <div style={{ position: 'absolute', left: LEFT_W, top: 0, width: graphW, height: TOP_PAD }}>
            {hourLabels.map((h) => (
              <div key={h}>
                <div style={{ position: 'absolute', left: hourToX(h, pxPerHour) - 0.5, top: 0, width: 1, height: TOP_PAD, background: h % 6 === 0 ? C.gridStrong : (h % 2 === 0 ? C.gridMid : C.gridFaint) }} />
                {h < 24 && h % labelIntervalHours === 0 && (
                  <span style={{ position: 'absolute', left: hourToX(h, pxPerHour) + 3, top: 4, fontSize: 10, color: C.labels }}>
                    {h === 0 ? '12A' : h === 12 ? 'Noon' : h < 12 ? `${h}A` : `${h - 12}P`}
                  </span>
                )}
              </div>
            ))}
            {/* quarter ticks */}
            {Array.from({ length: 96 }).map((_, i) => (
              <div key={`q${i}`} style={{ position: 'absolute', left: hourToX(i / 4, pxPerHour), top: TOP_PAD - 4, width: 1, height: 4, background: i % 4 === 0 ? C.gridMid : C.gridFaint }} />
            ))}
          </div>

          {/* rows background + vertical grid + segments */}
          <div ref={rowsRef} style={{ position: 'absolute', left: LEFT_W, top: TOP_PAD, width: graphW, height: ROW_H * 4, touchAction: editMode ? 'none' : 'pan-x' }}>
            {ROW_ORDER.map((s, i) => (
              <div key={s} style={{ position: 'absolute', left: 0, top: i * ROW_H, width: graphW, height: ROW_H, background: i % 2 === 0 ? C.bg : C.bgAlt, borderBottom: `1px solid ${C.rowBorder}` }}>
                {hourLabels.map((h) => (
                  <div key={h} style={{ position: 'absolute', left: hourToX(h, pxPerHour), top: 0, width: 1, height: ROW_H, background: h % 6 === 0 ? C.gridStrong : (h % 2 === 0 ? C.gridFaint : 'transparent') }} />
                ))}
              </div>
            ))}
            {/* existing segments */}
            {daySegs.map((seg, i) => {
              const ri = ROW_ORDER.indexOf(seg.status); if (ri < 0) return null;
              return (
                <div key={`seg${i}`} style={{
                  position: 'absolute', left: hourToX(seg.startHour, pxPerHour), top: ri * ROW_H + 4,
                  width: Math.max(2, hourToX(seg.endHour, pxPerHour) - hourToX(seg.startHour, pxPerHour)),
                  height: ROW_H - 8, background: STATUS_COLORS[seg.status], opacity: 0.2, borderRadius: 3,
                }} />
              );
            })}
            {/* live draft */}
            {draft && !sheetValue && (() => {
              const ri = ROW_ORDER.indexOf(draft.status); if (ri < 0) return null;
              const lo = Math.min(draft.startHour, draft.endHour), hi = Math.max(draft.startHour, draft.endHour);
              return <div style={{ position: 'absolute', left: hourToX(lo, pxPerHour), top: ri * ROW_H + 4, width: Math.max(2, hourToX(hi, pxPerHour) - hourToX(lo, pxPerHour)), height: ROW_H - 8, background: STATUS_COLORS[draft.status], opacity: 0.5, borderRadius: 3, border: `2px solid ${C.fg}` }} />;
            })()}
            {/* pending (sheet open) highlight + handles */}
            {sheetValue && editMode && (() => {
              const ri = ROW_ORDER.indexOf(sheetValue.status); if (ri < 0) return null;
              const lo = Math.min(sheetStartHour, sheetEndHour), hi = Math.max(sheetStartHour, sheetEndHour);
              return (<>
                <div style={{ position: 'absolute', left: hourToX(lo, pxPerHour), top: ri * ROW_H + 4, width: Math.max(2, hourToX(hi, pxPerHour) - hourToX(lo, pxPerHour)), height: ROW_H - 8, background: STATUS_COLORS[sheetValue.status], opacity: 0.45, borderRadius: 3, border: `2px dashed ${C.fg}` }} />
                {['start', 'end'].map((which) => {
                  const hh = which === 'start' ? lo : hi;
                  return (
                    <div key={which} onPointerDown={(e) => onHandleDown(e, which)} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
                      style={{ position: 'absolute', left: hourToX(hh, pxPerHour) - 18, top: ri * ROW_H + ROW_H / 2 - 18, width: 36, height: 36, cursor: 'ew-resize', touchAction: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <GripVertical style={{ width: 16, height: 16, color: C.gripFg, background: C.gripBg, borderRadius: 9, boxShadow: '0 1px 3px rgba(0,0,0,0.3)' }} />
                    </div>
                  );
                })}
              </>);
            })()}
            {/* row pointer capture layer (edit mode only) */}
            {editMode && ROW_ORDER.map((s, i) => (
              <div key={`cap${s}`} onPointerDown={(e) => onPointerDownRow(e, s)} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
                style={{ position: 'absolute', left: 0, top: i * ROW_H, width: graphW, height: ROW_H, touchAction: 'none', cursor: 'crosshair' }} />
            ))}
          </div>

          {/* frozen status labels */}
          <div style={{ position: 'sticky', left: 0, top: 0, width: LEFT_W, height: TOP_PAD + ROW_H * 4, background: C.bg, borderRight: `1px solid ${C.rowBorder}`, zIndex: 5 }}>
            {ROW_ORDER.map((s, i) => (
              <div key={s} style={{ position: 'absolute', top: TOP_PAD + i * ROW_H, width: LEFT_W, height: ROW_H, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', paddingRight: 6 }}>
                <span style={{ fontSize: 10, fontWeight: 700, color: STATUS_COLORS[s] }}>{STATUS_LABELS[s]}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* totals */}
      <div className="grid grid-cols-4 gap-2 mt-3 text-center text-xs">
        {ROW_ORDER.map((s) => (
          <div key={s} className="rounded-md border border-border py-1.5">
            <div className="font-semibold text-card-foreground">{STATUS_LABELS[s]}</div>
            <div className="text-muted-foreground">{(totals[s] || 0).toFixed(2)}h</div>
          </div>
        ))}
      </div>

      <EventSheet open={!!sheetValue && !proposed} value={sheetValue} isNew={sheetValue?.isNew}
        dayStartMs={dayStartMs} tz={tz} carrier={carrier} equipment={equipment}
        onChange={patchSheet} onSubmit={review} onClose={() => setSheetValue(null)} />

      <ProposedChangeDialog open={!!proposed} isCertified={proposed?.isCertified}
        beforeSegs={proposed?.beforeSegs} afterSegs={proposed?.afterSegs}
        beforeHos={proposed?.beforeHos} afterHos={proposed?.afterHos}
        warnings={proposed?.warnings} violations={proposed?.violations}
        onApply={applyProposed} onEdit={() => setProposed(null)} onCancel={() => { setProposed(null); setSheetValue(null); }} />
    </div>
  );
}