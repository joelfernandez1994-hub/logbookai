// ============================================================================
// LogbookAI — RODS Graph Editor (deterministic helpers, no AI).
// Pure time/geometry + timeline-insertion planning used by the touch editor.
// Nothing here writes to the database. All HOS math delegates to hosEngine.
// ============================================================================

import {
  findOverlaps, findLocationConflicts, needsPreTrip, breakStatus,
} from './proposalValidation';
import { computeHOS, runComplianceCheck } from './hosEngine';
import { collectViolations } from './logAssistant';
import { planInsert as canonicalInsert } from './timelineEngine';

const MS = 60000;

// ---------------------------------------------------------------------------
// Geometry / time-of-day
// ---------------------------------------------------------------------------
export function hourToX(hour, pxPerHour) { return hour * pxPerHour; }

export function snapHour(hour, snapMinutes = 1) {
  if (snapMinutes <= 0) return hour;
  const snapMs = snapMinutes * MS;
  const hourMs = hour * 3600000;
  return (Math.round(hourMs / snapMs) * snapMs) / 3600000;
}

// hour: 0..24 fractional (minutes since midnight / 60). 12h display.
export function formatHour(h) {
  if (h == null || isNaN(h)) return '--';
  const total = Math.max(0, Math.round(h * 60));
  let hh = Math.floor(total / 60) % 24;
  const mm = total % 60;
  const ampm = hh < 12 ? 'AM' : 'PM';
  let h12 = hh % 12;
  if (h12 === 0) h12 = 12;
  return `${h12}:${mm.toString().padStart(2, '0')} ${ampm}`;
}

// hour -> "HH:MM" 24h for time inputs
export function formatH24(h) {
  const total = Math.max(0, Math.min(24 * 60, Math.round(h * 60)));
  const hh = Math.floor(total / 60) % 24;
  const mm = total % 60;
  return `${hh.toString().padStart(2, '0')}:${mm.toString().padStart(2, '0')}`;
}

export function fmtDurationMs(ms) {
  if (ms == null || isNaN(ms) || ms < 0) return '--';
  const totalMin = Math.round(ms / MS);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m} min`;
  return `${h} hr ${m.toString().padStart(2, '0')} min`;
}

// ---------------------------------------------------------------------------
// Day segments for rendering
// ---------------------------------------------------------------------------
function toMs(iso) { return new Date(iso).getTime(); }

export function daySegments(events, dayStartMs, dayEndMs) {
  const segs = [];
  for (const e of events) {
    if (!e.start_timestamp) continue;
    const es = Math.max(toMs(e.start_timestamp), dayStartMs);
    const ee = Math.min(e.end_timestamp ? toMs(e.end_timestamp) : dayEndMs, dayEndMs);
    if (ee <= es) continue;
    segs.push({
      id: e.id,
      startHour: (es - dayStartMs) / 3600000,
      endHour: (ee - dayStartMs) / 3600000,
      status: e.duty_status,
      city: e.city, state: e.state, remark: e.remark,
      startMs: es, endMs: ee,
    });
  }
  return segs.sort((a, b) => a.startHour - b.startHour);
}

// ---------------------------------------------------------------------------
// Timeline insertion planning — keeps the day a continuous, non-overlapping
// duty-status timeline. Drawing inside an existing event splits it.
// Returns { creates:[event], updates:[{id,data}], deletes:[id] }.
// ---------------------------------------------------------------------------
export function planDayInsertion(dayEvents, newEvent) {
  // Delegate to the canonical Timeline Engine so graph edits use the same
  // duplicate-guarded, non-overlapping insertion as every other writer.
  const ops = canonicalInsert(dayEvents, { ...newEvent, is_ongoing: false });
  return { creates: ops.creates, updates: ops.updates, deletes: ops.deletes };
}

// Edit an existing event in place (preserve id for version history) while
// splitting/truncating neighbors that the new range overlaps.
export function planEdit(dayEvents, eventId, editedEvent) {
  const target = dayEvents.find((e) => e.id === eventId);
  if (!target) return planDayInsertion(dayEvents, editedEvent);
  const others = dayEvents.filter((e) => e.id !== eventId);
  const ops = planDayInsertion(others, editedEvent);
  // planDayInsertion (canonicalInsert) has no notion of "this is an edit" —
  // it always appends a fresh self-insert create for editedEvent as the LAST
  // entry of ops.creates (canonicalInsert/planInsert pushes it unconditionally,
  // exactly once, after any neighbor-split creates), since from its point of
  // view it is just inserting a new event into `others`. That self-insert must
  // be dropped here: the edit is applied in place via the `update` below
  // (preserving the event's id), so keeping the self-insert would create a
  // second, duplicate record for the SAME logical event (e.g. adding a
  // city/state to an existing status would create a stray twin instead of
  // just updating the original). An empty ops.creates means planInsert took
  // its exact-duplicate early-return path, so there is nothing to drop.
  const creates = ops.creates.length > 0 ? ops.creates.slice(0, -1) : ops.creates;
  // Carry field_provenance through the edit so explicit/inferred flags persist
  // on the saved record (used by the route-aware reconstruction engine). Only
  // set when the caller provided it (manual edits/corrections pass explicit;
  // AI edits pass the AI-provided flags).
  const update = {
    id: eventId,
    data: {
      duty_status: editedEvent.duty_status,
      start_timestamp: editedEvent.start_timestamp,
      end_timestamp: editedEvent.end_timestamp,
      is_ongoing: editedEvent.is_ongoing ?? !editedEvent.end_timestamp,
      city: editedEvent.city || '',
      state: editedEvent.state || '',
      remark: editedEvent.remark || '',
      tractor_number: editedEvent.tractor_number || '',
      trailer_numbers: editedEvent.trailer_numbers || '',
      bill_of_lading_number: editedEvent.bill_of_lading_number || '',
    },
  };
  if (editedEvent.field_provenance) update.data.field_provenance = editedEvent.field_provenance;
  return { ...ops, creates, updates: [...ops.updates, update] };
}

// Apply ops to a day's events -> the resulting event list (for preview).
export function applyOps(dayEvents, ops) {
  const del = new Set(ops.deletes);
  let list = dayEvents.filter((e) => !del.has(e.id));
  list = list.map((e) => {
    const u = ops.updates.find((x) => x.id === e.id);
    return u ? { ...e, ...u.data } : e;
  });
  list = [...list, ...ops.creates.map((c, i) => ({ ...c, id: c.id || `__new_${i}` }))];
  return list.sort((a, b) => toMs(a.start_timestamp) - toMs(b.start_timestamp));
}

// Full event set after applying day ops (outside-day events unchanged).
export function buildAfterEvents(allEvents, dayEvents, ops) {
  const dayIds = new Set(dayEvents.map((e) => e.id).filter(Boolean));
  const outside = allEvents.filter((e) => !dayIds.has(e.id));
  return [...outside, ...applyOps(dayEvents, ops)];
}

// ---------------------------------------------------------------------------
// Validate the resulting full timeline with the SAME deterministic checks
// used by AI/manual text entry: overlap, geographic continuity, pre-trip,
// 30-min break, 11h/14h/cycle, split-sleeper (via computeHOS), 34h restart.
// ---------------------------------------------------------------------------
export function validateTimeline(events, { cycleType = '70_8', tz = 'UTC', now = new Date() } = {}) {
  const t = now instanceof Date ? now : new Date(now);
  const warnings = [];
  warnings.push(...findOverlaps(events, t));
  warnings.push(...findLocationConflicts(events, t));
  const pretrip = needsPreTrip(events, t);
  if (pretrip.required) {
    warnings.push({
      type: 'pretrip', severity: 'blocking', title: 'PRE-TRIP CHECK',
      message: 'A Driving period begins a new work period. Confirm your pre-trip vehicle inspection was performed before driving.',
    });
  }
  const br = breakStatus(events, t);
  if (br.required) {
    warnings.push({
      type: 'break30', severity: 'blocking', title: '30-MINUTE BREAK REQUIRED',
      message: 'More than 8 cumulative hours of Driving without a qualifying 30-minute interruption. Add or confirm a real qualifying stop.',
    });
  }
  const hos = computeHOS(events, cycleType, tz, t, { historyComplete: true });
  const issues = runComplianceCheck(events, cycleType, tz, t, { historyComplete: true });
  const violations = collectViolations(hos, issues);
  return { warnings, violations, hos, break: br, pretrip };
}

export function hasBlocking(warnings = []) {
  return warnings.some((w) => w?.severity === 'blocking');
}