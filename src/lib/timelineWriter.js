// ============================================================================
// LogbookAI — CANONICAL TIMELINE WRITER (the single DB-write chokepoint).
// ----------------------------------------------------------------------------
// EVERY mutation of DutyStatusEvent records — Add Event, Edit Event, Delete,
// Change Duty Status, pre-trip, AI Apply, AI "Redo my day", graph edits, and
// Clear Day Log — goes through this module. It computes ops with the canonical
// timelineEngine (so overlaps/duplicates cannot reappear) and applies them,
// then invalidates any active certification for every affected log_date and
// preserves an EventVersion audit snapshot for edited/deleted certified events.
//
// No caller may use base44.entities.DutyStatusEvent.create/update/delete
// directly for duty-status events. Import from here instead.
// ============================================================================

import { base44 } from '@/api/base44Client';
import { planInsert, planReplaceRange, startOfDayInTz } from './timelineEngine';
import { planEdit } from './rodsEditor';

const H = 3600000;

// Collect every log_date touched by an ops set (creates carry log_date;
// updates/deletes reference existing events whose log_date we read from
// allEvents). Cert invalidation must cover all of them.
function affectedDates(ops, allEvents) {
  const set = new Set();
  const byId = new Map((allEvents || []).filter(e => e && e.id).map(e => [e.id, e]));
  for (const c of ops.creates) if (c.log_date) set.add(c.log_date);
  for (const u of ops.updates) {
    const ev = byId.get(u.id);
    if (ev?.log_date) set.add(ev.log_date);
    if (u.data?.log_date) set.add(u.data.log_date);
  }
  for (const id of ops.deletes) {
    const ev = byId.get(id);
    if (ev?.log_date) set.add(ev.log_date);
  }
  return [...set];
}

// Fetch the active (non-superseded) certification for each date, if any.
async function activeCertsByDate(dates) {
  const map = {};
  for (const d of dates) {
    const list = await base44.entities.Certification.filter({ log_date: d });
    map[d] = (list || []).find(c => !c.is_superseded) || null;
  }
  return map;
}

// Apply a computed ops set to the database in canonical order (deletes, then
// updates, then creates), then supersede active certifications for every
// affected date. When a certified day is edited/deleted, an EventVersion
// audit snapshot is preserved first. Returns { created }.
export async function applyTimelineOps(ops, allEvents = [], opts = {}) {
  const { editedBy = '', reason = 'Edit', createVersions = true } = opts;
  const dates = affectedDates(ops, allEvents);
  const certMap = dates.length ? await activeCertsByDate(dates) : {};

  if (createVersions) {
    const byId = new Map((allEvents || []).filter(e => e && e.id).map(e => [e.id, e]));
    const snap = async (ev, action) => {
      if (!ev || !ev.log_date) return;
      const cert = certMap[ev.log_date];
      if (!cert) return;
      await base44.entities.EventVersion.create({
        original_event_id: ev.id,
        version_number: 1,
        snapshot: { ...ev },
        edited_by: editedBy,
        edit_reason: reason,
        action,
      });
    };
    for (const u of ops.updates) await snap(byId.get(u.id), 'edited');
    for (const id of ops.deletes) await snap(byId.get(id), 'deleted');
  }

  for (const id of ops.deletes) await base44.entities.DutyStatusEvent.delete(id);
  for (const u of ops.updates) await base44.entities.DutyStatusEvent.update(u.id, u.data);
  const created = [];
  for (const c of ops.creates) {
    const { id, ...rest } = c;
    created.push(await base44.entities.DutyStatusEvent.create(rest));
  }

  // Invalidate certifications for every affected date (item: cert invalidation).
  for (const d of dates) {
    const cert = certMap[d];
    if (cert) await base44.entities.Certification.update(cert.id, { is_superseded: true });
  }
  return { created };
}

// Canonical insert: add a new event, splitting/truncating neighbors.
// Returns { error?, duplicate?, invalid?, created, ops }.
export async function insertEvent(allEvents, newEvent, opts = {}) {
  const { carrierName, methodOfCreation } = opts;
  const ev = {
    ...newEvent,
    method_of_creation: methodOfCreation || newEvent.method_of_creation || 'Manual',
    carrier_name: carrierName || newEvent.carrier_name || '',
    is_current_version: true,
  };
  const ops = planInsert(allEvents, ev);
  if (ops.invalid) return { error: 'Invalid event: the end time is before the start time.', invalid: true, ops, created: [] };
  if (ops.duplicate) return { error: 'An identical event (same start time and status) already exists.', duplicate: true, ops, created: [] };
  const res = await applyTimelineOps(ops, allEvents, opts);
  return { ...res, ops };
}

// Canonical in-place edit of an existing event (preserves id, splits neighbors).
export async function editEvent(allEvents, eventId, editedEvent, opts = {}) {
  const ops = planEdit(allEvents, eventId, editedEvent);
  const res = await applyTimelineOps(ops, allEvents, opts);
  return { ...res, ops };
}

// Canonical batch insert for AI Apply (multiple proposed events). Each event is
// planInserted against a working copy that mirrors the post-op state, so later
// proposed events see earlier ones (preventing overlaps/duplicates among the
// proposed set itself). All ops are applied in a single applyTimelineOps call.
export async function insertEventsBatch(allEvents, newEvents, opts = {}) {
  const t = new Date();
  const working = [...(allEvents || [])];
  const merged = { creates: [], updates: [], deletes: [] };
  // Map a pending create's synthetic id -> its index in merged.creates. A later
  // proposed event that truncates/deletes an EARLIER proposed event must fold
  // onto the pending create directly; otherwise the op is emitted as a DB
  // update/delete against an id that does not exist yet (no-op), leaving an
  // overlapping/duplicate record behind.
  const pendingIdx = new Map();
  let dupHit = false, invalidHit = false;
  const newId = () => `__new_${pendingIdx.size}_${Math.random().toString(36).slice(2, 8)}`;
  const rebuildIndex = () => {
    pendingIdx.clear();
    merged.creates.forEach((c, i) => { if (c.id) pendingIdx.set(c.id, i); });
  };
  for (const ne of (newEvents || [])) {
    if (!ne || !ne.start_timestamp || !ne.duty_status) continue;
    const ev = {
      ...ne,
      method_of_creation: opts.methodOfCreation || ne.method_of_creation || (ne.source === 'voice' ? 'Voice AI' : 'Typed AI'),
      carrier_name: opts.carrierName || ne.carrier_name || '',
      is_current_version: true,
    };
    const ops = planInsert(working, ev, t);
    if (ops.invalid) { invalidHit = true; continue; }
    if (ops.duplicate) { dupHit = true; continue; }

    // Fold updates onto pending creates; emit DB updates only for real records.
    for (const u of ops.updates) {
      if (pendingIdx.has(u.id)) Object.assign(merged.creates[pendingIdx.get(u.id)], u.data);
      else merged.updates.push(u);
    }
    // Fold deletes onto pending creates; emit DB deletes only for real records.
    let foldedDelete = false;
    for (const id of ops.deletes) {
      if (pendingIdx.has(id)) { merged.creates.splice(pendingIdx.get(id), 1); foldedDelete = true; }
      else merged.deletes.push(id);
    }
    if (foldedDelete) rebuildIndex();

    // Mirror the post-op state into the working copy so the next proposed event
    // sees earlier proposed events as if already persisted.
    const delSet = new Set(ops.deletes);
    for (const u of ops.updates) {
      const idx = working.findIndex(e => e && e.id === u.id);
      if (idx >= 0) working[idx] = { ...working[idx], ...u.data };
    }
    for (let i = working.length - 1; i >= 0; i--) if (delSet.has(working[i]?.id)) working.splice(i, 1);
    for (const c of ops.creates) {
      const withId = { ...c, id: c.id || newId() };
      working.push(withId);
      pendingIdx.set(withId.id, merged.creates.length);
      merged.creates.push(withId);
    }
  }
  const res = await applyTimelineOps(merged, allEvents, opts);
  return { ...res, ops: merged, duplicate: dupHit, invalid: invalidHit };
}

// Canonical delete of a single event.
export async function deleteEventById(allEvents, id, opts = {}) {
  const ops = { creates: [], updates: [], deletes: [id] };
  const res = await applyTimelineOps(ops, allEvents, opts);
  return { ...res, ops };
}

// Canonical "redo this range": remove events overlapping [rangeStart, rangeEnd]
// (truncating cross-boundary events to preserve adjacent days) and insert the
// replacement events. Used by AI "Redo my entire day/trip".
export async function replaceRangeEvents(allEvents, rangeStart, rangeEnd, replacementEvents, opts = {}) {
  const ops = planReplaceRange(allEvents, rangeStart, rangeEnd, replacementEvents);
  const res = await applyTimelineOps(ops, allEvents, opts);
  return { ...res, ops };
}

// Clear Day Log: remove every event intersecting the selected day, splitting
// cross-midnight events so the adjacent day's timeline is preserved. Also
// invalidates that day's certification. Implemented as a replace-range with an
// empty replacement (planReplaceRange already handles the split/truncate logic).
export async function clearDayEvents(allEvents, dateStr, tz, opts = {}) {
  const dayStart = startOfDayInTz(new Date(dateStr + 'T12:00:00'), tz);
  const dayEnd = new Date(dayStart.getTime() + 24 * H);
  const ops = planReplaceRange(allEvents, dayStart, dayEnd, []);
  const res = await applyTimelineOps(ops, allEvents, opts);
  return { ...res, ops, dayStart, dayEnd };
}

// Change Duty Status: end every currently-ongoing event at the new status
// start, then create the new ongoing status (deduped). Routes through
// applyTimelineOps so certification for the affected day is invalidated.
export async function changeStatus(newStatus, details = {}, allEvents = []) {
  const now = new Date();
  const startTs = details.start_timestamp || now.toISOString();
  const logDate = startTs.slice(0, 10);

  const ongoing = (allEvents || []).filter(e => e.is_ongoing && !e.end_timestamp);
  let dbOngoing = [];
  try {
    dbOngoing = await base44.entities.DutyStatusEvent.filter({ is_ongoing: true }, '-start_timestamp', 50);
  } catch (e) { /* read-only fallback */ }
  const seen = new Set(ongoing.map(o => o.id));
  const allOngoing = [...ongoing, ...(dbOngoing || []).filter(d => d && !seen.has(d.id))];

  const updates = allOngoing.map(o => ({ id: o.id, data: { end_timestamp: startTs, is_ongoing: false } }));

  const startMs = new Date(startTs).getTime();
  const dup = (allEvents || []).some(e =>
    e && e.duty_status === newStatus && e.start_timestamp &&
    Math.abs(new Date(e.start_timestamp).getTime() - startMs) < 1000);

  const creates = dup ? [] : [{
    log_date: logDate,
    start_timestamp: startTs,
    end_timestamp: null,
    is_ongoing: true,
    duty_status: newStatus,
    city: details.city || '',
    state: details.state || '',
    remark: details.remark || '',
    tractor_number: details.tractor_number || '',
    trailer_numbers: details.trailer_numbers || '',
    carrier_name: details.carrier_name || '',
    method_of_creation: details.method_of_creation || 'Manual',
    is_current_version: true,
  }];

  const ops = { creates, updates, deletes: [] };
  const res = await applyTimelineOps(ops, allEvents, { reason: 'Change duty status' });
  return res.created[0] || null;
}