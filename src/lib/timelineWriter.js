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

// ---------------------------------------------------------------------------
// Idempotency re-check (DB-side). Before issuing creates, we re-fetch the
// current DutyStatusEvent rows for every affected log_date and skip a create
// whose (start_timestamp, duty_status) already exists. This makes normal
// retries, double-clicks, and stale-snapshot replays idempotent at the DB
// layer, complementing the UI button lock and the in-flight guard.
//
// CAVEAT: this is read-before-create dedupe, NOT an atomic uniqueness
// constraint. Base44 entities expose no unique constraint / idempotency
// token, so two truly simultaneous independent writers could still create a
// duplicate pair. The button lock + in-flight guard prevent that within a
// single Apply flow; cross-flow concurrency is out of scope for this fix.
// ---------------------------------------------------------------------------
async function existingKeysForDates(dates) {
  const set = new Set();
  if (!dates || !dates.length) return set;
  for (const d of dates) {
    try {
      const rows = await base44.entities.DutyStatusEvent.filter({ log_date: d });
      for (const r of (rows || [])) {
        if (r && r.start_timestamp && r.duty_status) {
          set.add(`${new Date(r.start_timestamp).getTime()}|${r.duty_status}`);
        }
      }
    } catch (e) { /* best-effort; ignore */ }
  }
  return set;
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

  // Idempotency: re-check current DB rows (after deletes/updates so removed
  // rows don't block replacement creates) and skip any create that already
  // exists. Also dedupe within this batch.
  const existingKeys = await existingKeysForDates(dates);
  const created = [];
  const seenInBatch = new Set();
  for (const c of ops.creates) {
    const { id, ...rest } = c;
    if (!rest.start_timestamp || !rest.duty_status) continue;
    const key = `${new Date(rest.start_timestamp).getTime()}|${rest.duty_status}`;
    if (existingKeys.has(key) || seenInBatch.has(key)) continue;
    seenInBatch.add(key);
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
  let dupHit = false, invalidHit = false;
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
    const delSet = new Set(ops.deletes);
    for (const u of ops.updates) {
      const idx = working.findIndex(e => e && e.id === u.id);
      if (idx >= 0) working[idx] = { ...working[idx], ...u.data };
    }
    for (let i = working.length - 1; i >= 0; i--) if (delSet.has(working[i]?.id)) working.splice(i, 1);
    for (const c of ops.creates) working.push({ ...c, id: c.id || `__new_${merged.creates.length}` });
    merged.creates.push(...ops.creates);
    merged.updates.push(...ops.updates);
    merged.deletes.push(...ops.deletes);
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

// Canonical route-timing correction: persist an in-memory-reconstructed day as
// ONE logical correction. All planning happens against a working copy (NO DB
// writes during planning); a single applyTimelineOps call applies the entire
// approved correction at once — it never writes event-by-event as reconstruction
// runs, so a failed apply cannot leave a partially corrected timeline.
// Only timestamps that actually changed are patched, and each patched
// timestamp is marked explicit (driver-confirmed correction), so a later fix
// won't re-shift it. Preserves EventVersion audit snapshots and invalidates
// certification exactly like any manual edit (reason: 'Fix route timing').
export async function applyRouteTimingCorrection(allEvents, dateStr, tz, correctedDayEvents, opts = {}) {
  const working = [...(allEvents || [])];
  const merged = { creates: [], updates: [], deletes: [] };
  let changedCount = 0;

  for (const corrected of (correctedDayEvents || [])) {
    if (!corrected?.id) continue;
    const original = (allEvents || []).find((e) => e && e.id === corrected.id);
    if (!original) continue;
    const startChanged = (corrected.start_timestamp || null) !== (original.start_timestamp || null);
    const endChanged = (corrected.end_timestamp || null) !== (original.end_timestamp || null);
    if (!startChanged && !endChanged) continue;

    // Corrected timestamps become explicit — the driver confirmed the fix.
    const editedEvent = {
      ...original,
      start_timestamp: corrected.start_timestamp,
      end_timestamp: corrected.end_timestamp,
      field_provenance: { start_time: 'explicit', end_time: 'explicit' },
    };

    // Plan each edit against the working copy (mirrors post-op state) so later
    // edits see earlier ones — preventing overlaps/duplicates among the set.
    const ops = planEdit(working, corrected.id, editedEvent);
    const delSet = new Set(ops.deletes);
    for (const u of ops.updates) {
      const idx = working.findIndex((e) => e && e.id === u.id);
      if (idx >= 0) working[idx] = { ...working[idx], ...u.data };
    }
    for (let i = working.length - 1; i >= 0; i--) if (delSet.has(working[i]?.id)) working.splice(i, 1);
    for (const c of ops.creates) working.push({ ...c, id: c.id || `__new_${merged.creates.length}` });

    merged.creates.push(...ops.creates);
    merged.updates.push(...ops.updates);
    merged.deletes.push(...ops.deletes);
    changedCount++;
  }

  if (!changedCount) return { ops: merged, changedCount: 0, created: [] };

  const res = await applyTimelineOps(merged, allEvents, { ...opts, reason: opts.reason || 'Fix route timing' });
  return { ...res, ops: merged, changedCount };
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

  // Same-status re-select guard: if the most recent ongoing event already equals
  // the new status, do NOT end it and do NOT create a new event. Only fill blank
  // fields on the existing ongoing record from provided details (original
  // start_timestamp, duty_status, and is_ongoing=true are preserved). Stale
  // older ongoing duplicates are still ended so the one-ongoing invariant holds.
  if (allOngoing.length > 0) {
    const mostRecent = allOngoing.slice().sort((a, b) =>
      new Date(b.start_timestamp).getTime() - new Date(a.start_timestamp).getTime())[0];
    if (mostRecent.duty_status === newStatus) {
      const updates = [];
      for (const o of allOngoing) {
        if (o.id !== mostRecent.id) {
          updates.push({ id: o.id, data: { end_timestamp: startTs, is_ongoing: false } });
        }
      }
      const patch = {};
      const fillFields = ['city', 'state', 'remark', 'tractor_number', 'trailer_numbers', 'bill_of_lading_number'];
      for (const f of fillFields) {
        const v = details[f];
        if (v != null && v !== '' && !mostRecent[f]) patch[f] = v;
      }
      if (Object.keys(patch).length > 0) updates.push({ id: mostRecent.id, data: patch });
      if (updates.length > 0) {
        await applyTimelineOps({ creates: [], updates, deletes: [] }, allEvents, { reason: 'Change duty status' });
      }
      return mostRecent;
    }
  }

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
    bill_of_lading_number: details.bill_of_lading_number || '',
    carrier_name: details.carrier_name || '',
    method_of_creation: details.method_of_creation || 'Manual',
    is_current_version: true,
  }];

  const ops = { creates, updates, deletes: [] };
  const res = await applyTimelineOps(ops, allEvents, { reason: 'Change duty status' });
  return res.created[0] || null;
}