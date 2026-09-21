// Harness-only tests: the standalone browser-console script must (1) match its
// tested sources exactly, (2) contain no /src imports, and (3) behave correctly
// against a MOCKED backend — smoke test first, hard guards on identity/config, no
// database writes. No application behavior is exercised or changed here.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import { buildScript } from '../../scripts/buildLiveAiStress.mjs';

const APP = '6a861df91bc2d86b11ec06b1';
const TEST_EMAIL = 'stress-test@example.invalid';
const SCRIPT = fs.readFileSync('scripts/liveAiStress.console.js', 'utf8');
const GLOBALS = ['window', 'location', 'localStorage', 'fetch', 'copy'];
let saved;

const todayIso = (hm) => { const [h, m] = hm.split(':').map(Number); return new Date(Date.UTC(2026, 8, 21, h + 4, m)).toISOString(); }; // EDT
const fp = { start_time: 'explicit', end_time: 'explicit', status: 'explicit', city: 'explicit', state: 'explicit' };
const pe = (status, city, state, s, e) => ({ duty_status: status, city, state, start_timestamp: todayIso(s), end_timestamp: e ? todayIso(e) : null, field_provenance: fp, ambiguous_fields: [] });

function defaultModel(input) {
  if (input === 'loaded in Miami at 8 AM') return { intent: 'add_events', proposed_events: [pe('ON_DUTY', 'Miami', 'FL', '08:00')], used: 1, allowance: 150 };
  if (input === 'Left Miami at 8 AM and got to Orlando at 9 AM') return { intent: 'add_events', proposed_events: [pe('DRIVING', 'Miami', 'FL', '08:00', '09:00'), pe('ON_DUTY', 'Orlando', 'FL', '09:00')] };
  if (input === 'delete that fuel stop') return { intent: 'delete_events', delete_target_indices: [3], proposed_events: [] };
  return { intent: 'clarification', requires_clarification: true, clarification_question: 'q', proposed_events: [] };
}

function setup({ email = TEST_EMAIL, role = 'user', allowance = 150, tz = 'America/New_York', hostname = 'preview-abc.base44.app', pathname = '/', appId = APP, token = 'tok-123', model = defaultModel, quotaAfter = Infinity } = {}) {
  const calls = [];
  let modelCalls = 0;
  const store = { base44_app_id: appId, base44_access_token: token };
  Object.assign(globalThis, {
    window: globalThis,
    location: { hostname, pathname, href: `https://${hostname}${pathname}`, origin: `https://${hostname}`, search: '' },
    localStorage: { getItem: (k) => (k in store && store[k] != null ? store[k] : null) },
  });
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method, headers: init.headers, body });
    const reply = (status, data) => ({ ok: status < 400, status, text: async () => JSON.stringify(data) });
    if (url.endsWith('/entities/User/me')) return reply(200, { email, role, ai_allowance_override: allowance });
    if (url.includes('/entities/CarrierProfile')) return reply(200, [{ home_terminal_timezone: tz, hos_cycle: '70_8' }]);
    if (url.endsWith('/functions/tripEstimate')) return reply(200, { miles: 233, hours: 4.37 });
    if (url.endsWith('/functions/manualLogAssistant')) {
      modelCalls += 1;
      if (modelCalls > quotaAfter) return reply(429, { error: 'limit', limit: true });
      return reply(200, model(body.input, body));
    }
    return reply(404, { error: 'unexpected ' + url });
  };
  return { calls, modelCalls: () => modelCalls };
}
const run = (liveAi) => { window.LIVE_AI = liveAi; return (0, eval)(SCRIPT); };

beforeEach(() => {
  saved = Object.fromEntries(GLOBALS.map((g) => [g, Object.getOwnPropertyDescriptor(globalThis, g)]));
  delete globalThis.__liveAiSmokeOk; delete globalThis.__liveAiSmoke; delete globalThis.__liveAiResults;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'table').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const g of GLOBALS) { delete globalThis[g]; if (saved[g]) Object.defineProperty(globalThis, g, saved[g]); }
  delete globalThis.LIVE_AI; delete globalThis.__liveAiSmokeOk; delete globalThis.__liveAiSmoke; delete globalThis.__liveAiResults;
});

describe('the pasted script is the tested code, with no /src imports', () => {
  it('scripts/liveAiStress.console.js is exactly what the build produces from the tested sources', () => {
    expect(SCRIPT).toBe(buildScript());
  });
  it('contains no import()/import-from and never references /src paths', () => {
    expect(/\bimport\s*\(/.test(SCRIPT)).toBe(false);
    expect(/^\s*import\s/m.test(SCRIPT)).toBe(false);
    expect(/['"`]\/src\//.test(SCRIPT)).toBe(false);
  });
  it('embeds all 78 prompts and the previously-broken ones', () => {
    for (const id of ['A01', 'A10', 'H07', 'L04']) expect(SCRIPT.includes(`id: '${id}'`)).toBe(true);
    expect((SCRIPT.match(/^\s*\{ id: '[A-Z]\d\d'/gm) || []).length).toBe(78);
  });
});

describe('smoke test (one real call, then stop)', () => {
  it('verifies identity/config, makes exactly ONE manualLogAssistant call with the app session credentials, prints the structured response, and unlocks the full run', async () => {
    const env = setup();
    const r = await run({ testEmail: TEST_EMAIL });
    expect(r.ok).toBe(true);
    expect(env.modelCalls()).toBe(1);
    const modelCall = env.calls.find((c) => c.url.endsWith('/functions/manualLogAssistant'));
    expect(modelCall.url).toBe(`https://preview-abc.base44.app/api/apps/${APP}/functions/manualLogAssistant`);
    expect(modelCall.method).toBe('POST');
    expect(modelCall.headers.Authorization).toBe('Bearer tok-123');
    expect(modelCall.headers['X-App-Id']).toBe(APP);
    expect(modelCall.body).toMatchObject({ mode: 'interpret', input: 'loaded in Miami at 8 AM', events: [] });
    expect(env.calls.some((c) => c.url.endsWith('/functions/tripEstimate'))).toBe(false); // smoke uses no routing
    expect(window.__liveAiSmokeOk).toBe(true);
    const printed = console.log.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(printed).toContain('RAW STRUCTURED RESPONSE');
    expect(printed).toContain('SMOKE TEST PASSED');
  });

  it('a failed/unstructured call does NOT unlock the full run', async () => {
    setup({ model: () => ({ error: 'LogbookAI is temporarily unavailable.' }) });
    const r = await run({ testEmail: TEST_EMAIL });
    expect(r.ok).toBe(false);
    expect(window.__liveAiSmokeOk).toBe(false);
  });

  it('the smoke prompt is scored too (informational): a correct proposal passes the scorer', async () => {
    setup();
    const r = await run({ testEmail: TEST_EMAIL });
    expect(r.scored.pass).toBe(true);
  });
});

describe('hard guards run BEFORE any AI request', () => {
  it.each([
    ['no testEmail configured', { }, {}, /testEmail/],
    ['logged-in email is not the designated test account', { testEmail: 'someone-else@example.com' }, {}, /Refusing to run on any other account/],
    ['admin role', { testEmail: TEST_EMAIL }, { role: 'admin' }, /admin/],
    ['wrong carrier timezone', { testEmail: TEST_EMAIL }, { tz: 'America/Chicago' }, /timezone/],
    ['editor page (the original /src failure context)', { testEmail: TEST_EMAIL }, { hostname: 'app.base44.com', pathname: `/apps/${APP}/editor/preview` }, /EDITOR page/],
    ['wrong app id in this frame', { testEmail: TEST_EMAIL }, { appId: 'other-app' }, /app id/],
  ])('%s -> aborts with zero model calls', async (_l, live, env, msg) => {
    const e = setup(env);
    await expect(run(live)).rejects.toThrow(msg);
    expect(e.modelCalls()).toBe(0);
  });

  it('no session token -> aborts', async () => {
    const e = setup({ token: null });
    await expect(run({ testEmail: TEST_EMAIL })).rejects.toThrow(/no logged-in session/);
    expect(e.modelCalls()).toBe(0);
  });

  it('a full run requires a passed smoke test in this page session', async () => {
    const e = setup();
    await expect(run({ testEmail: TEST_EMAIL, run: 'all' })).rejects.toThrow(/smoke test first/);
    expect(e.modelCalls()).toBe(0);
  });

  it('a full run requires ai_allowance_override >= 100 (smoke is allowed below it)', async () => {
    const e = setup({ allowance: 20 });
    const smoke = await run({ testEmail: TEST_EMAIL });
    expect(smoke.ok).toBe(true);
    await expect(run({ testEmail: TEST_EMAIL, run: 'phase1' })).rejects.toThrow(/>= 100/);
    expect(e.modelCalls()).toBe(1);
  });
});

describe('full runs (after a passed smoke test)', () => {
  it('"all" attempts 78 prompts, uses synthetic events, scores structurally, and NEVER touches DutyStatusEvent or any write endpoint', async () => {
    const env = setup();
    await run({ testEmail: TEST_EMAIL });
    const totals = await run({ testEmail: TEST_EMAIL, run: 'all', delayMs: 0 });
    expect(totals.attempted).toBe(78);
    expect(totals.completed).toBe(78);
    expect(totals.saveLeg).toBe('not run');
    expect(env.calls.some((c) => /DutyStatusEvent/.test(c.url))).toBe(false);
    const writes = env.calls.filter((c) => c.method !== 'GET' && !/\/functions\/(manualLogAssistant|tripEstimate)$/.test(c.url));
    expect(writes).toEqual([]);
    const res = window.__liveAiResults;
    expect(res.raw.H05.fixture).toHaveLength(7);   // synthetic correction timeline
    expect(res.raw.J01.fixture).toHaveLength(1);   // synthetic prior-rest fixture
    expect(res.raw.A01.replay).toMatchObject({ tz: 'America/New_York', cycle: '70_8' });
    expect(res.rows.find((r) => r.id === 'H05').pass).toBe(true);        // correct delete target [3]
    expect(res.rows.find((r) => r.id === 'I01').pass).toBe(true);        // vague -> asked
    expect(res.rows.find((r) => r.id === 'A10').pass).toBe(true);        // ambiguous -> asked, no state chosen
  });

  it('A01: route lookup performed and the impossible Miami->Orlando 8-9 AM leg is flagged', async () => {
    const env = setup();
    await run({ testEmail: TEST_EMAIL });
    await run({ testEmail: TEST_EMAIL, run: 'phase1', only: ['A01', 'E01'], delayMs: 0 });
    const a01 = window.__liveAiResults.rows.find((r) => r.id === 'A01');
    expect(a01.down.routeConflict).toBe(true);
    expect(a01.pass).toBe(true);
    expect(a01.down.legs[0]).toMatchObject({ origin: 'Miami, FL', destination: 'Orlando, FL', miles: 233, evaluated: true });
    expect(env.calls.some((c) => c.url.endsWith('/functions/tripEstimate') && c.body.origin === 'Miami, FL' && c.body.destination === 'Orlando, FL')).toBe(true);
  });

  it('the scorer catches a model that silently changes the times to make the trip legal', async () => {
    setup({ model: (input) => (input.startsWith('Left Miami at 8 AM') ? { intent: 'add_events', proposed_events: [pe('DRIVING', 'Miami', 'FL', '08:00', '12:30'), pe('ON_DUTY', 'Orlando', 'FL', '12:30')] } : defaultModel(input)) });
    await run({ testEmail: TEST_EMAIL });
    await run({ testEmail: TEST_EMAIL, run: 'phase1', only: ['A01'], delayMs: 0 });
    const a01 = window.__liveAiResults.rows.find((r) => r.id === 'A01');
    expect(a01.pass).toBe(false);
    expect(a01.fails.some((f) => /end 12:30 != 09:00/.test(f))).toBe(true);
  });

  it('phase2 runs only the 7 correction/delete prompts', async () => {
    const env = setup();
    await run({ testEmail: TEST_EMAIL });
    const totals = await run({ testEmail: TEST_EMAIL, run: 'phase2', delayMs: 0 });
    expect(totals.attempted).toBe(7);
    expect(env.modelCalls()).toBe(1 + 7);
  });

  it('stops on a 429 quota response instead of hammering the function', async () => {
    const env = setup({ quotaAfter: 3 }); // smoke + 2 prompts succeed, then 429
    await run({ testEmail: TEST_EMAIL });
    const totals = await run({ testEmail: TEST_EMAIL, run: 'all', delayMs: 0 });
    expect(env.modelCalls()).toBeLessThan(10);
    expect(totals.completed).toBeLessThan(78);
  });
});
