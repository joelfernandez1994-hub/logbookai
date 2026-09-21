/* ============================================================================
 * LogbookAI — LIVE AI STRESS RUN (browser-console script)
 * ----------------------------------------------------------------------------
 * HOW TO RUN (needs a logged-in app tab; the real manualLogAssistant function
 * only answers authenticated users):
 *   1. Open the app (editor Preview or the dev URL) and log in as a TEST account.
 *   2. Give that account an AI allowance >= 100 (User field ai_allowance_override)
 *      — the default is 20 requests/month and this run makes ~78.
 *   3. Open DevTools > Console and paste this whole file, press Enter.
 *      Optional first:  window.LIVE_AI = { only: ['A01','A10'], delayMs: 1200 }
 *   4. When it finishes it prints a table + totals and stores everything in
 *      window.__liveAiResults (also copied to the clipboard when possible).
 *
 * SAFETY:
 *   - Calls manualLogAssistant in `interpret` mode with SYNTHETIC events in the
 *     request body. That function reads context events from the body, not the
 *     database, and never writes duty-status events. Only side effects: the
 *     calling account's monthly AI-usage counter and the function's own
 *     AIProposal audit row.
 *   - Route validation calls the tripEstimate function (Nominatim/OSRM lookups,
 *     no database writes).
 *   - The optional SAVE leg (LIVE_AI.save = ['C16', ...]) WRITES real duty-status
 *     events, so it refuses to run unless LIVE_AI.testEmail exactly equals the
 *     logged-in account's email, and it deletes only the records it created.
 * ========================================================================== */
(async () => {
  const cfg = Object.assign({ only: null, delayMs: 900, save: [], testEmail: null }, window.LIVE_AI || {});
  const imp = (p) => import(/* @vite-ignore */ p);
  const { base44 } = await imp('/src/api/base44Client.js');
  const { PROMPTS, fixtureFor } = await imp('/src/lib/liveAiPromptSet.js');
  const { evaluateLive, evaluateDownstream, wantsClarification } = await imp('/src/lib/liveAiEvaluator.js');
  const PV = await imp('/src/lib/proposalValidation.js');
  const { statedMileageWarnings } = await imp('/src/lib/statedMileage.js');
  const { normalizeCandidateTimeline } = await imp('/src/lib/timelineNormalization.js');

  const me = await base44.auth.me();
  const carrier = (await base44.entities.CarrierProfile.list('-created_date', 1))[0];
  const tz = carrier && carrier.home_terminal_timezone;
  if (!tz) throw new Error('Set the carrier home-terminal timezone on this test account first.');
  const cycle = carrier.hos_cycle || '70_8';

  // ---- local wall time on "today" (carrier tz) -> ISO ----
  const offsetMs = (d) => {
    const p = {}; new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(d).forEach((x) => { if (x.type !== 'literal') p[x.type] = x.value; });
    return Date.UTC(+p.year, +p.month - 1, +p.day, p.hour === '24' ? 0 : +p.hour, +p.minute, +p.second) - d.getTime();
  };
  const todayLocal = new Date().toLocaleDateString('en-CA', { timeZone: tz });
  const mk = (hm, dayOffset = 0) => {
    const [h, m] = hm.split(':').map(Number);
    const [y, mo, d] = todayLocal.split('-').map(Number);
    const wall = Date.UTC(y, mo - 1, d + dayOffset, h, m);
    let inst = wall; for (let i = 0; i < 2; i++) inst = wall - offsetMs(new Date(inst));
    return new Date(inst).toISOString();
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const list = PROMPTS.filter((s) => !cfg.only || cfg.only.includes(s.id));
  const rows = []; const raw = {};
  console.log(`LIVE AI STRESS: ${list.length} prompts as ${me.email}, tz ${tz}, today ${todayLocal}`);

  for (const spec of list) {
    const fixture = fixtureFor(spec, mk);
    let data = null, httpErr = null;
    try {
      const res = await base44.functions.invoke('manualLogAssistant', {
        mode: 'interpret', input: spec.prompt, source: 'typed', events: fixture, documents: [],
        currentLocation: '', tractor: '', trailer: '', hosSummary: '(synthetic stress-test context)',
      });
      data = res.data || res;
      if (res.status === 429 || (data && data.limit)) { console.warn('AI quota reached — stopping. Raise ai_allowance_override.'); rows.push({ id: spec.id, pass: false, note: 'QUOTA' }); break; }
    } catch (e) { httpErr = String((e && e.message) || e); }

    const live = httpErr ? { pass: false, fails: [{ cat: 'shape', msg: `call failed: ${httpErr}` }], clarified: false } : evaluateLive(spec, data, tz);

    // ---- downstream: route + mileage + HOS/timeline validation (real client code) ----
    let down = { routeConflict: false, warningTypes: [], violations: [], blocking: false };
    let downRes = { pass: true, fails: [] };
    try {
      const evs = (data && data.proposed_events) || [];
      if (evs.length && ['add_events', 'replace_day'].includes(data.intent)) {
        const { events: selfNorm } = normalizeCandidateTimeline(evs);
        const enriched = await PV.enrichProposalMileage(selfNorm, { routingProvider: PV.fetchRoute, now: new Date(), narrative: spec.prompt });
        const legs = enriched.legs || [];
        const mileageW = statedMileageWarnings(legs, spec.prompt);
        const v = PV.validateProposal(fixture.map((e) => ({ ...e })), enriched.events, {
          cycleType: cycle, tz, now: new Date(), narrative: spec.prompt,
          provenance: { summary: data.summary, location_confirmations: data.location_confirmations },
        });
        down = {
          routeConflict: legs.some((l) => l.evaluation && l.evaluation.conflict),
          warningTypes: [...v.warnings.map((w) => w.type), ...mileageW.map((w) => w.type)],
          violations: (v.violations || []).map((x) => x.rule || x.title || x.type || String(x)),
          blocking: PV.hasBlocking(v.warnings),
        };
      }
      downRes = evaluateDownstream(spec, down);
    } catch (e) { downRes = { pass: false, fails: [{ cat: 'shape', msg: `downstream error: ${e.message}` }] }; }

    const fails = [...live.fails, ...downRes.fails];
    rows.push({ id: spec.id, cat: spec.cat, prompt: spec.prompt, pass: fails.length === 0, asked: live.clarified, expectedAsk: spec.clarify === true, fails: fails.map((f) => `[${f.cat}] ${f.msg}`), down });
    raw[spec.id] = { input: spec.prompt, response: data, error: httpErr, downstream: down };
    console.log(`${fails.length ? 'FAIL' : 'PASS'}  ${spec.id}  ${spec.prompt}${fails.length ? '\n      ' + fails.map((f) => f.msg).join('\n      ') : ''}`);
    await sleep(cfg.delayMs);
  }

  // ---- optional SAVE leg (dedicated test account only) ----
  const saveRows = [];
  if (cfg.save.length) {
    if (!cfg.testEmail || cfg.testEmail !== me.email) console.warn('SAVE leg skipped: LIVE_AI.testEmail must equal the logged-in test account email.');
    else {
      const { insertEventsBatch } = await imp('/src/lib/timelineWriter.js');
      const created = [];
      for (const id of cfg.save) {
        const r = raw[id]; const spec = PROMPTS.find((p) => p.id === id);
        if (!r || !r.response || !(r.response.proposed_events || []).length) { saveRows.push({ id, ok: false, note: 'no proposal' }); continue; }
        const { events: selfNorm } = normalizeCandidateTimeline(r.response.proposed_events);
        const enriched = await PV.enrichProposalMileage(selfNorm, { routingProvider: PV.fetchRoute, now: new Date(), narrative: spec.prompt });
        const shaped = enriched.events.map((p, i, a) => ({
          log_date: p.date || p.start_timestamp.slice(0, 10), start_timestamp: p.start_timestamp, end_timestamp: p.end_timestamp || null,
          duty_status: p.duty_status, city: p.city || '', state: p.state || '', remark: p.remark || p.activity_type || '',
          method_of_creation: 'Typed AI', is_ongoing: i === a.length - 1 && !p.end_timestamp, ...(p.field_provenance ? { field_provenance: p.field_provenance } : {}),
        }));
        const before = await base44.entities.DutyStatusEvent.list('-created_date', 500);
        const res = await insertEventsBatch(before, shaped, { carrierName: carrier.carrier_name, methodOfCreation: 'Typed AI', reason: 'AI Apply (live stress test)' });
        (res.created || []).forEach((c) => created.push(c.id));
        const after = await base44.entities.DutyStatusEvent.list('-start_timestamp', 500);
        const mine = after.filter((e) => (res.created || []).some((c) => c.id === e.id));
        const same = shaped.length === mine.length && shaped.every((s, i) => mine[mine.length - 1 - i] && mine.some((m) => m.duty_status === s.duty_status && new Date(m.start_timestamp).getTime() === new Date(s.start_timestamp).getTime()));
        saveRows.push({ id, ok: !res.error && same, error: res.error || null, reviewed: shaped.length, persisted: mine.length });
      }
      for (const id of created) { try { await base44.entities.DutyStatusEvent.delete(id); } catch (e) { console.warn('cleanup failed for', id); } }
      console.log('SAVE leg cleaned up', created.length, 'test records');
    }
  }

  // ---- totals ----
  const by = (f) => rows.filter(f).length;
  const catFails = (c) => rows.reduce((n, r) => n + (r.fails || []).filter((x) => x.startsWith(`[${c}]`)).length, 0);
  const totals = {
    total: rows.length, passed: by((r) => r.pass), failed: by((r) => !r.pass),
    clarificationCorrectlyRequested: by((r) => r.expectedAsk && r.asked && r.pass),
    ambiguousLocationsCaught: by((r) => r.cat === 'ambiguous-city' && r.pass),
    impossibleTravelWarnings: by((r) => r.cat === 'impossible-route' && r.pass),
    incorrectLocationResolutions: catFails('location'), incorrectTimeInterpretations: catFails('time'),
    timelineOverlaps: catFails('timeline_overlap'), timelineGaps: catFails('timeline_gap'), hosErrors: catFails('hos'),
    correctionDeleteFailures: catFails('correction_delete'), routeValidationFailures: catFails('route'),
    savePersistenceFailures: saveRows.filter((s) => !s.ok).length, saveRun: saveRows.length,
  };
  console.table(rows.map((r) => ({ id: r.id, cat: r.cat, result: r.pass ? 'PASS' : 'FAIL', issues: (r.fails || []).join(' | ') })));
  console.table(totals);
  window.__liveAiResults = { totals, rows, raw, saveRows };
  try { if (typeof copy === 'function') copy(JSON.stringify(window.__liveAiResults)); } catch (e) { /* clipboard optional */ }
  return totals;
})();
