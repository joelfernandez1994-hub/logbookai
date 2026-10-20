import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { getDailyGrid, computeHOS, hasSufficientCycleHistory } from '@/lib/hosEngine';
import {
  daySegments, planDayInsertion, planEdit, applyOps, buildAfterEvents,
  validateTimeline, snapHour, hourToX,
} from '@/lib/rodsEditor';
import { applyTimelineOps } from '@/lib/timelineWriter';
import { computeGraphLayout, getLabelIntervalHours, LEFT_W } from '@/lib/rodsGraphLayout';
import { xToHour, beginDrawGesture, updateDrawGesture, finalizeDrawGesture, autoScrollDelta, clampScroll } from '@/lib/rodsGraphGesture';
import EventSheet from './EventSheet';
import ProposedChangeDialog from './ProposedChangeDialog';
import TimeBubble from './TimeBubble';
import RodsGrid from '@/components/RodsGrid';
import { Button } from '@/components/ui/button';
import { Pencil, Eye, ShieldCheck, GripVertical, ZoomIn, Maximize2, AlertTriangle, RefreshCw, ChevronLeft, ChevronRight } from 'lucide-react';

// Explicit "zoom in for precise edits" window — the default is always the
// full day (undefined/null zoomHours); tapping Zoom switches to this many
// hours visible + horizontally scrollable, tapping "Full Day" resets it.
const ZOOM_WINDOW_HOURS = 5;

const ROW_ORDER = ['OFF_DUTY', 'SLEEPER_BERTH', 'DRIVING', 'ON_DUTY'];
const STATUS_COLORS = {
  OFF_DUTY: '#64748b', SLEEPER_BERTH: '#7c3aed', DRIVING: '#2563eb', ON_DUTY: '#ea580c',
};
const STATUS_LABELS = { OFF_DUTY: 'Off', SLEEPER_BERTH: 'Sleeper', DRIVING: 'Drive', ON_DUTY: 'On' };
const hourLabel = (h) => (h === 0 || h === 24) ? '12A' : h === 12 ? '12P' : String(h < 12 ? h : h - 12);
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
  loading = false, error: loadError = null,
}) {
  const { t } = useTranslation();
  const tz = timezone;
  const cycleType = carrier?.hos_cycle || '70_8';

  // A render failure (bad legacy timestamps, clock skew, ...) must never blank
  // the editor or let a driver save over entries they cannot see: capture the
  // error, show it with a Retry, and block the edit path while it stands.
  const gridRes = useMemo(() => {
    try { return { grid: getDailyGrid(events, dateStr, tz), error: null }; }
    catch (e) { return { grid: null, error: e?.message || 'Failed to render the log timeline.' }; }
  }, [events, dateStr, tz]);
  const grid = gridRes.grid;
  const gridError = gridRes.error;
  const dayStartMs = grid ? grid.dayStart.getTime() : 0;
  const dayEndMs = grid ? grid.dayEnd.getTime() : 0;

  const dayEvents = useMemo(() => {
    if (!grid) return [];
    return events.filter((e) => {
      if (!e.start_timestamp) return false;
      const es = new Date(e.start_timestamp).getTime();
      const ee = e.end_timestamp ? new Date(e.end_timestamp).getTime() : dayEndMs;
      return ee > dayStartMs && es < dayEndMs;
    }).map((e) => e.end_timestamp ? e : { ...e, end_timestamp: new Date(dayEndMs).toISOString() });
  }, [events, grid, dayStartMs, dayEndMs]);

  const daySegs = useMemo(() => {
    if (!grid) return [];
    return ROW_ORDER.flatMap((status) =>
      grid.rows[status].map((s) => ({
        id: s.id, status, startMs: s.start.getTime(), endMs: s.end.getTime(),
        startHour: s.startHour, endHour: s.endHour,
      }))
    ).sort((a, b) => a.startMs - b.startMs);
  }, [grid]);
  const totals = grid ? grid.totals : {};

  // Edit/write paths are blocked while data is loading, while the load
  // failed, and while the graph failed to render — a blank editor can never
  // stage a change that would overwrite entries it does not show.
  const blocked = !!loading || !!loadError || !!gridError;

  const [mode, setMode] = useState('view');
  const [zoomHours, setZoomHours] = useState(null); // null = full day (default)
  const [containerW, setContainerW] = useState(360);
  const [draft, setDraft] = useState(null);
  const [bubble, setBubble] = useState(null);
  const [sheetValue, setSheetValue] = useState(null);
  const [proposed, setProposed] = useState(null);
  const [applyError, setApplyError] = useState(null);
  const [pointerError, setPointerError] = useState(null);

  const scrollRef = useRef(null);
  const contentRef = useRef(null);
  const rowsRef = useRef(null);
  const gesture = useRef(null);
  const lastClientX = useRef(null);
  const rafRef = useRef(0);
  const pan = useRef(null); // active drag-to-pan gesture (zoomed view only)
  const [scrollX, setScrollX] = useState(0); // live scrollLeft, for the window readout + button states

  useEffect(() => {
    const el = scrollRef.current; if (!el) return;
    const ro = new ResizeObserver(() => setContainerW(el.clientWidth));
    ro.observe(el); setContainerW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const editMode = mode === 'edit' && !readOnly;
  // Default is always the full day fit exactly to the available width — no
  // scroll required just to view or edit. zoomHours is only ever set while
  // actively editing (an explicit, driver-triggered "zoom in" for precise
  // touch edits on a short stop); leaving edit mode or dateStr changing
  // resets it back to the full-day default (see the effect below).
  const zoomed = editMode && !!zoomHours;
  const { visibleHours, pxPerHour, graphW, contentW } = useMemo(
    () => computeGraphLayout(containerW, zoomed ? zoomHours : 24),
    [containerW, zoomed, zoomHours]
  );
  useEffect(() => { if (!editMode) setZoomHours(null); }, [editMode]);
  useEffect(() => { setZoomHours(null); }, [dateStr]);
  // Presentation only: how many hours apart a TEXT label is drawn on the
  // hour ruler. The grid itself (hour tick lines + quarter ticks) is always
  // full density regardless of this — only which ticks additionally get a
  // "12A"/"3A"/... label shrinks on a narrow phone so labels never overlap.
  const labelIntervalHours = useMemo(() => getLabelIntervalHours(containerW), [containerW]);
  const x = (h) => LEFT_W + hourToX(h, pxPerHour);

  const evalNow = useMemo(() => dayEndMs <= Date.now() ? new Date(dayEndMs) : new Date(),
    [dayEndMs]);
  // Same history-complete signal Today uses (hasSufficientCycleHistory): a
  // truly fresh account with no prior records is distinguished from a driver
  // who has older history but then an unlogged multi-day gap. computeHOS needs
  // this so the Proposed Log Change dialog's HOS preview renders cycle as "—"
  // (Unverified) for a fresh account instead of coercing it to a placeholder 0.
  const historyComplete = useMemo(() => hasSufficientCycleHistory(events, cycleType, profile?.entered_prior_history, tz, evalNow),
    [events, cycleType, profile, tz, evalNow]);
  const beforeHos = useMemo(() => computeHOS(events, cycleType, tz, evalNow, { historyComplete }),
    [events, cycleType, tz, evalNow, historyComplete]);

  // Pure coordinate math (rodsGraphGesture.js) — same formula as before,
  // just extracted so it's independently unit-testable.
  // Pointer -> hour mapping reads the PLOT element (the wrapper that holds
  // the four duty-status rows, excluding the left status-label gutter), so
  // the mapping is correct in the default full-day view AND when zoomed and
  // horizontally scrolled (getBoundingClientRect is viewport-based, so
  // scrollLeft is inherently accounted for). A missing or zero-width plot
  // element returns null — callers must refuse to draw rather than silently
  // mapping every touch to midnight.
  const hourFromClientX = useCallback((clientX) => {
    const el = rowsRef.current; if (!el) return null;
    const rect = el.getBoundingClientRect();
    if (!rect.width || !pxPerHour) return null;
    return xToHour(clientX, rect.left, pxPerHour);
  }, [pxPerHour]);

  // ---- auto-scroll while dragging near edges (only does anything once
  // zoomed — in the default full-day view there is nothing to scroll, so
  // scrollLeft writes are harmless no-ops) ----
  const startAutoScroll = useCallback(() => {
    const tick = () => {
      if (!gesture.current) { rafRef.current = 0; return; }
      const sc = scrollRef.current;
      const cx = lastClientX.current;
      if (sc && cx != null) {
        const vr = sc.getBoundingClientRect();
        const dx = autoScrollDelta(cx, vr.left, vr.right);
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

  // ---- zoomed-view panning ----
  // Two ways to move the visible ~5h window, per explicit direction:
  //   1. Direct swipe/drag: a touch on the ruler or label areas pans
  //      natively (container touch-action: pan-x); a mouse drag anywhere
  //      except the duty rows pans here; and a SECOND finger touching a row
  //      while one is already drawing cancels the draw and pans instead.
  //   2. The prev/next chevron buttons in the mode bar (window stepping).
  // Drawing itself is unchanged: one finger pressed ON a row still draws.
  const onPanPointerDown = useCallback((e) => {
    if (!zoomed || e.pointerType === 'touch') return; // touch pans natively
    pan.current = { pointerId: e.pointerId, lastX: e.clientX };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) {}
  }, [zoomed]);
  const onPanPointerMove = useCallback((e) => {
    const p = pan.current; if (!p || e.pointerId !== p.pointerId) return;
    const sc = scrollRef.current; if (!sc) return;
    sc.scrollLeft = clampScroll(sc.scrollLeft - (e.clientX - p.lastX), contentW, sc.clientWidth);
    p.lastX = e.clientX;
  }, [contentW]);
  const onPanPointerUp = useCallback((e) => {
    const p = pan.current; if (!p || e.pointerId !== p.pointerId) return;
    pan.current = null;
  }, []);
  // Step the visible window by half a window per tap, clamped to the day.
  const panWindow = useCallback((dir) => {
    const sc = scrollRef.current; if (!sc) return;
    sc.scrollBy({ left: dir * pxPerHour * (visibleHours / 2), behavior: 'smooth' });
  }, [pxPerHour, visibleHours]);

  // ---- pointer handlers (shared by rows + handles) ----
  // The 'draw' branch is a thin wrapper around updateDrawGesture/
  // finalizeDrawGesture (rodsGraphGesture.js): one continuous swipe
  // accumulates into a single gesture object regardless of how many hour
  // boundaries or re-renders happen in between, and produces exactly one
  // canonical {status, lo, hi} range at release — never a fragmented series
  // of inserts. The duty status is fixed at touch-down (beginDrawGesture)
  // and never re-derived from vertical position here either.
  const onPointerMove = useCallback((e) => {
    if (pan.current) return; // two-finger pan in progress — not a draw update
    const g = gesture.current; if (!g) return;
    lastClientX.current = e.clientX;
    const hour = hourFromClientX(e.clientX);
    if (hour == null) return; // plot not measurable — keep gesture, skip update
    if (g.type === 'draw') {
      const updated = updateDrawGesture(g, e.clientX, e.clientY, hour);
      gesture.current = updated;
      setDraft({ status: updated.status, startHour: updated.startHour, endHour: updated.endHour });
      setBubble({ x: e.clientX, y: e.clientY, startHour: updated.startHour, endHour: updated.endHour, status: updated.status, color: STATUS_COLORS[updated.status] });
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
    const result = finalizeDrawGesture(g);
    if (!result) {
      // No net movement (or zero-length) -> a tap, not a draw: edit the
      // existing segment at this hour if there is one. This also covers
      // "cancel discards the gesture completely" — nothing was ever staged
      // to write, so there is nothing to undo.
      if (!g.moved) {
        const seg = daySegs.find((s) => g.startHour >= s.startHour - 0.01 && g.startHour < s.endHour);
        if (seg) openEdit(seg);
      }
      return;
    }
    openNew(result.status, result.lo, result.hi);
  }, [daySegs, stopAutoScroll]);

  const onPointerDownRow = (e, status) => {
    if (readOnly || mode !== 'edit') return;
    e.stopPropagation(); // rows draw; the scroll container's pan handler must not also fire
    if (gesture.current && zoomed) {
      // Second finger while already drawing: switch to panning (the standard
      // drawing-surface escape hatch) — cancel the draw cleanly and pan.
      e.preventDefault();
      stopAutoScroll(); gesture.current = null; setDraft(null); setBubble(null);
      pan.current = { pointerId: e.pointerId, lastX: e.clientX };
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) {}
      return;
    }
    e.preventDefault();
    const hour = hourFromClientX(e.clientX);
    if (hour == null) {
      setPointerError('The log grid is not ready for editing yet — tap Retry to try again.');
      return;
    }
    gesture.current = { ...beginDrawGesture(status, e.clientX, e.clientY, hour), pointerId: e.pointerId };
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
    const sv = sheetValue; if (!sv || !grid || blocked) return;
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
    const afterHos = computeHOS(afterEvents, cycleType, tz, evalNow, { historyComplete });
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
    const p = proposed; if (!p || blocked) return;
    const editedBy = profile?.legal_name || '';
    // Route through the canonical writer: applies deletes/updates/creates in
    // order, preserves EventVersion audit snapshots for certified-day edits,
    // and invalidates the active Certification for every affected log_date.
    try {
      await applyTimelineOps(p.ops, events, {
        editedBy,
        reason: 'Graph edit',
        carrierName: carrier?.carrier_name || '',
        createVersions: true,
      });
      setApplyError(null);
      setProposed(null); setSheetValue(null); setDraft(null);
      reload && reload();
    } catch (e) {
      // Save failed: the log is unchanged. Keep the driver's staged edit
      // (sheetValue) intact, close the review, and surface the error with a
      // Retry that re-runs the review from the staged edit.
      setApplyError(e?.message || 'Save failed — your log is unchanged.');
      setProposed(null);
    }
  };

  const sheetStartHour = sheetValue ? (sheetValue.startMs - dayStartMs) / 3600000 : 0;
  const sheetEndHour = sheetValue ? (sheetValue.endMs - dayStartMs) / 3600000 : 0;

  const hourLabels = []; for (let h = 0; h <= 24; h++) hourLabels.push(h);

  // Zoomed-view window readout + button enablement, derived from the live
  // scroll position (kept current by the container's onScroll).
  const maxScroll = Math.max(0, contentW - containerW);
  const windowLabel = zoomed && pxPerHour
    ? `${hourLabel(Math.round(scrollX / pxPerHour))}–${hourLabel(Math.min(24, Math.round((scrollX + pxPerHour * visibleHours) / pxPerHour)))}`
    : '';

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
            <Button size="sm" variant={editMode ? 'default' : 'outline'} disabled={blocked} onClick={() => setMode('edit')}><Pencil className="w-3.5 h-3.5 mr-1" />{t('rodsEditor.editLogGraph')}</Button>
          </div>
        )}
        {editMode ? (
          zoomed ? (
            <div className="flex items-center gap-1">
              <Button size="sm" variant="outline" data-testid="zoom-pan-prev" aria-label="Earlier hours"
                disabled={scrollX <= 0.5} onClick={() => panWindow(-1)}>
                <ChevronLeft className="w-4 h-4" />
              </Button>
              <span className="text-[11px] tabular-nums text-muted-foreground text-center min-w-[52px]">{windowLabel}</span>
              <Button size="sm" variant="outline" data-testid="zoom-pan-next" aria-label="Later hours"
                disabled={scrollX >= maxScroll - 0.5} onClick={() => panWindow(1)}>
                <ChevronRight className="w-4 h-4" />
              </Button>
              <Button size="sm" variant="outline" onClick={() => setZoomHours(null)}>
                <Maximize2 className="w-3.5 h-3.5 mr-1" /> Full Day
              </Button>
            </div>
          ) : (
            <Button size="sm" variant="outline" onClick={() => setZoomHours(ZOOM_WINDOW_HOURS)}>
              <ZoomIn className="w-3.5 h-3.5 mr-1" /> Zoom
            </Button>
          )
        ) : (
          <div className="text-[11px] text-muted-foreground">Full 24h</div>
        )}
      </div>

      {editMode && (
        <div className="text-[11px] text-warning-surface-foreground bg-warning-surface border border-warning/50 rounded-md px-2.5 py-1.5 mb-2">
          <b>{t('rodsEditor.editMode')}</b> — {zoomed ? `Zoomed to ~${visibleHours}h — swipe the ruler, use the arrows, or drag near the edge to keep going. ` : ''}Press a row and drag to draw. Tap a segment to edit.
        </div>
      )}

      {editMode && (
        <div className="h-28 mb-2" data-testid="graph-drag-readout-slot">
          {bubble && <TimeBubble startHour={bubble.startHour} endHour={bubble.endHour} status={bubble.status} color={bubble.color} />}
        </div>
      )}

      {loading && (
        <div data-testid="editor-loading" className="rounded-lg border border-border bg-accent text-xs text-muted-foreground px-3 py-2 mb-2">
          Loading log data…
        </div>
      )}
      {(loadError || gridError || applyError || pointerError) && (
        <div data-testid="editor-error-banner" className="flex items-start gap-2 rounded-lg border border-error/50 bg-error-surface text-error-surface-foreground text-xs px-3 py-2 mb-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-error" />
          <span className="flex-1">{applyError || loadError || gridError || pointerError}</span>
          <Button size="sm" variant="outline" data-testid="editor-retry"
            onClick={() => {
              if (pointerError) { setPointerError(null); return; }
              if (applyError) review();
              else { setApplyError(null); reload && reload(); }
            }}>
            <RefreshCw className="w-3.5 h-3.5 mr-1" /> Retry
          </Button>
        </div>
      )}

      {/* Graph: view-mode renders the shared canonical RodsGrid (identical to
          Today / Logs / Inspection) so the read-only timeline never drifts.
          Edit-mode renders the interactive HTML grid below — the only place
          with drag/draw/resize affordances, which a read-only SVG cannot
          provide. The visual grid language (lanes, ticks, labels) is shared. */}
      {!editMode ? (
        <RodsGrid segments={daySegs.map((s) => ({ status: s.status, startHour: s.startHour, endHour: s.endHour }))} />
      ) : (
      <div ref={scrollRef} className={`rounded-lg border border-border bg-graph ${zoomed ? 'overflow-x-auto overflow-y-hidden touch-pan-x graph-scroll' : 'overflow-hidden'}`}
        style={zoomed ? { touchAction: 'pan-x' } : undefined}
        onScroll={(e) => setScrollX(e.currentTarget.scrollLeft)}
        onPointerDown={onPanPointerDown} onPointerMove={onPanPointerMove}
        onPointerUp={onPanPointerUp} onPointerCancel={onPanPointerUp}>
        <div ref={contentRef} data-testid="rods-edit-grid"
          onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
          style={{ width: contentW, position: 'relative', height: TOP_PAD + ROW_H * 4 + 6, cursor: zoomed ? 'grab' : undefined }}>
          {/* hour ruler labels */}
          {hourLabels.map((h) => (
            <div key={`lab${h}`} className="absolute pointer-events-none text-[9px] tabular-nums select-none"
              style={{ left: x(h), top: 6, transform: 'translateX(-50%)', color: C.labels }}>
              {hourLabel(h)}
            </div>
          ))}
          {/* vertical hour grid lines across all four rows */}
          {hourLabels.map((h) => (
            <div key={`vl${h}`} className="absolute pointer-events-none"
              style={{ left: x(h), top: TOP_PAD, width: 1, height: ROW_H * 4, background: C.gridMid }} />
          ))}
          {/* The plot area: wrapper anchored at the timeline origin (after the
              status-label gutter) — rowsRef attaches HERE so pointer coords
              map against the plot itself, not the label column, and stay
              correct under zoom + horizontal scroll. */}
          <div ref={rowsRef} data-testid="rods-plot" className="absolute"
            style={{ left: LEFT_W, top: TOP_PAD, width: graphW, height: ROW_H * 4 }}>
          {ROW_ORDER.map((status, i) => (
            <div key={status} data-testid={`rods-row-${status}`}
              onPointerDown={(e) => onPointerDownRow(e, status)}
              className="absolute select-none"
              style={{ left: 0, top: i * ROW_H, width: graphW, height: ROW_H, touchAction: 'none', cursor: 'crosshair', background: i % 2 ? C.bgAlt : 'transparent', borderTop: `1px solid ${C.rowBorder}` }}>
              {/* saved segments for this status */}
              {daySegs.filter((s) => s.status === status).map((s) => (
                <div key={s.id} data-testid={`edit-seg-${s.id}`} className="absolute rounded-sm pointer-events-none"
                  style={{ left: hourToX(s.startHour, pxPerHour), width: Math.max(2, hourToX(s.endHour - s.startHour, pxPerHour)), top: ROW_H / 2 - 7, height: 14, background: STATUS_COLORS[status], opacity: sheetValue?.eventId === s.id ? 0.45 : 1 }} />
              ))}
              {/* live draft preview while drawing (nothing staged to save) */}
              {draft && draft.status === status && (
                <div data-testid="draft-preview" className="absolute rounded-sm pointer-events-none"
                  style={{ left: hourToX(Math.min(draft.startHour, draft.endHour), pxPerHour), width: Math.max(2, hourToX(Math.abs(draft.endHour - draft.startHour), pxPerHour)), top: ROW_H / 2 - 9, height: 18, background: STATUS_COLORS[status], opacity: 0.5 }} />
              )}
              {/* drag handles on the selected (editing) segment */}
              {sheetValue && !sheetValue.isNew && sheetValue.status === status &&
                ['start', 'end'].map((which) => {
                  const hr = which === 'start' ? sheetStartHour : sheetEndHour;
                  return (
                    <div key={which} data-testid={`seg-handle-${which}`}
                      onPointerDown={(e) => onHandleDown(e, which)}
                      className="absolute z-10 rounded-full flex items-center justify-center"
                      style={{ left: hourToX(hr, pxPerHour) - 8, top: ROW_H / 2 - 13, width: 16, height: 26, background: C.gripBg, color: C.gripFg, touchAction: 'none', cursor: 'ew-resize' }}>
                      <GripVertical className="w-3 h-3" />
                    </div>
                  );
                })}
            </div>
          ))}
          </div>
          {/* bottom border of the last row */}
          <div className="absolute pointer-events-none" style={{ left: LEFT_W, top: TOP_PAD + ROW_H * 4, width: graphW, height: 1, background: C.rowBorder }} />
        </div>
      </div>
      )}

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
        historyComplete={historyComplete}
        warnings={proposed?.warnings} violations={proposed?.violations}
        onApply={applyProposed} onEdit={() => setProposed(null)} onCancel={() => { setProposed(null); setSheetValue(null); }} />
    </div>
  );
}