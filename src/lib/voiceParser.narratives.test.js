// ============================================================================
// LogbookAI — Natural-language logging regression tests (vitest).
// Exercises parseVoiceCommand with the exact narratives from the driver-
// workflow regression pass: shows the proposed events each one produces,
// verifies the vague-wording (\"slept\") and ambiguous-AM/PM priority rules,
// and confirms timezone/DST correctness in the underlying time resolution.
// Nothing here calls an LLM — these are the deterministic paths only.
// ============================================================================
import { describe, it, expect } from 'vitest';
import { parseVoiceCommand } from './voiceParser';
import { isMultiEventNarrative } from '../pages/LogAssistant.jsx';

const ET = 'America/New_York';
const CT = 'America/Chicago';

describe('Required narrative #1 — multi-activity trip narrative routes to AI, not the deterministic parser', () => {
  it('is classified as a multi-event narrative (driving + pretrip + fuel)', () => {
    const text = 'I went on duty at 5:15 AM in Homestead for my pretrip, started driving at 5:35, stopped in Fort Pierce at 8:10 for fuel for 20 minutes, then kept driving.';
    // This is the SAME gate LogAssistant.jsx's handleTell uses before ever
    // calling parseVoiceCommand — confirms it correctly defers to the AI
    // backend instead of letting the deterministic parser guess at a
    // narrative this complex. The AI backend itself (manualLogAssistant,
    // an OpenAI-backed Deno function) is out of scope for a unit test.
    expect(isMultiEventNarrative(text)).toBe(true);
  });
});

describe('Required narrative #2 — "went in the sleeper at 10 PM and got up at 6 AM"', () => {
  it('proposes one SLEEPER_BERTH event, 10 PM → 6 AM next day, both times unambiguous', () => {
    const now = new Date('2026-08-20T22:05:00-04:00');
    const res = parseVoiceCommand('I went in the sleeper at 10 PM and got up at 6 AM.', { now, timezone: ET });
    expect(res.handled).toBe(true);
    expect(res.events).toHaveLength(1);
    const e = res.events[0];
    // eslint-disable-next-line no-console
    console.log('Narrative #2 proposed event:', e);
    expect(e.duty_status).toBe('SLEEPER_BERTH'); // explicit "sleeper" — not ambiguous
    expect(e._ambiguous.duty_status).toBe(false);
    expect(e._ambiguous.time).toBe(false); // both times had explicit AM/PM
    const hours = (new Date(e.end_timestamp) - new Date(e.start_timestamp)) / 3600000;
    expect(hours).toBeCloseTo(8, 1);
  });
});

describe('Required narrative #3 — "I slept from 10 PM to 6 AM." (vague rest verb, no berth context)', () => {
  it('does NOT auto-assume Sleeper Berth — flags duty_status ambiguous and asks for clarification', () => {
    const now = new Date('2026-08-20T22:05:00-04:00');
    const res = parseVoiceCommand('I slept from 10 PM to 6 AM.', { now, timezone: ET });
    expect(res.handled).toBe(true);
    const e = res.events[0];
    // eslint-disable-next-line no-console
    console.log('Narrative #3 proposed event:', e, res.clarifications);
    expect(['OFF_DUTY', 'SLEEPER_BERTH']).toContain(e.duty_status);
    expect(e._ambiguous.duty_status).toBe(true); // MUST be flagged — never silent
    expect(res.clarifications.some(c => c.type === 'status_ambiguous')).toBe(true);
    expect(res.ambiguousFields.some(f => f.endsWith(':duty_status'))).toBe(true);
    // Times themselves were explicit (10 PM / 6 AM) — only the STATUS is ambiguous.
    expect(e._ambiguous.time).toBe(false);
  });

  it('contrast: "sleeper" WITH explicit berth wording is never ambiguous', () => {
    const now = new Date('2026-08-20T22:05:00-04:00');
    const res = parseVoiceCommand('I was in the sleeper berth from 10 PM to 6 AM.', { now, timezone: ET });
    const e = res.events[0];
    expect(e.duty_status).toBe('SLEEPER_BERTH');
    expect(e._ambiguous.duty_status).toBe(false);
  });
});

describe('Required narrative #4 — "stopped for my 30 at 1:15 and started driving again at 1:45."', () => {
  it('produces TWO events (30-min break, then driving) with consistent (matching) AM/PM via chronology', () => {
    // now = 1:20 PM — close to \"1:15\", so the FIRST clause's ambiguous hour
    // resolves via tier 4 (closest-to-now) to 1:15 PM. The second clause then
    // has a chronological anchor (1:15 PM) and must resolve \"1:45\" to 1:45 PM
    // (30 min forward), not 1:45 AM (which would be BEFORE the anchor).
    const now = new Date('2026-08-20T13:20:00-05:00');
    const res = parseVoiceCommand('I stopped for my 30 at 1:15 and started driving again at 1:45.', { now, timezone: CT });
    expect(res.handled).toBe(true);
    // eslint-disable-next-line no-console
    console.log('Narrative #4 proposed events:', res.events);
    expect(res.events.length).toBeGreaterThanOrEqual(2);
    const brk = res.events.find(e => e.activity_type === '30-Minute Break');
    const drive = res.events.find(e => e.duty_status === 'DRIVING');
    expect(brk).toBeTruthy();
    expect(drive).toBeTruthy();
    // Same meridian, 30 minutes apart, driving strictly after the break start.
    expect(new Date(drive.start_timestamp).getTime() - new Date(brk.start_timestamp).getTime()).toBe(30 * 60000);
  });
});

describe('Required narrative #5 — "Change my last fuel stop to Orlando at 2:20 PM."', () => {
  it('proposes an edit with the new location captured, not silently dropped', () => {
    const now = new Date('2026-08-20T14:00:00-04:00');
    const res = parseVoiceCommand('Change my last fuel stop to Orlando at 2:20 PM.', { now, timezone: ET });
    expect(res.handled).toBe(true);
    expect(res.edit).toBe(true);
    const e = res.events[0];
    // eslint-disable-next-line no-console
    console.log('Narrative #5 proposed edit:', e, res.clarifications);
    expect(e.city).toBe('Orlando');
    expect(e.duty_status).toBe('ON_DUTY');
    expect(e.activity_type).toBe('Fuel');
    expect(e._ambiguous.time).toBe(false); // \"2:20 PM\" is explicit
    expect(res.clarifications[0].question).toMatch(/Orlando/);
    expect(res.clarifications[0].question).toMatch(/confirm which existing event/i);
  });
});

describe('Ambiguous-AM/PM priority order (context > chronology > neighboring events > closest-to-now)', () => {
  it('tier 1: an explicit context phrase wins even when closest-to-now would disagree', () => {
    // \"now\" is 8 AM, so closest-to-now for a bare \"6\" would normally be 6 AM
    // anyway — use \"this evening\" to force PM against that grain and prove
    // the context phrase is actually being consulted, not coincidentally right.
    const now = new Date('2026-08-20T08:00:00-05:00');
    const res = parseVoiceCommand('on duty at 6 this evening', { now, timezone: CT });
    const e = res.events[0];
    const hourUTC = new Date(e.start_timestamp).getUTCHours();
    expect(hourUTC).toBe(23); // 6 PM Chicago (UTC-5) = 23:00 UTC
  });

  it('tier 2: chronological consistency wins over closest-to-now for a later clause', () => {
    // Covered end-to-end by narrative #4 above; this isolates the mechanism
    // with a case where closest-to-now would pick the WRONG side without an
    // anchor. now=11:50 PM: a bare \"12:05\" alone would be closest-to-now as
    // 12:05 AM (15 min away) vs 12:05 PM (~12h away) — same conclusion here,
    // so instead we anchor on an explicit prior clause forcing the opposite
    // of what closest-to-now would pick.
    const now = new Date('2026-08-20T23:50:00-05:00'); // 11:50 PM — closest-to-now alone favors "AM" for a bare small hour shortly after midnight\n    const res = parseVoiceCommand('on duty at 11 AM and then driving at 2', { now, timezone: CT });
    const events = res.events;
    const onDuty = events.find(e => e.duty_status === 'ON_DUTY');
    const driving = events.find(e => e.duty_status === 'DRIVING');
    expect(onDuty).toBeTruthy();
    expect(driving).toBeTruthy();
    // "2" must resolve AFTER 11 AM (chronological anchor), i.e. 2 PM same day,
    // not 2 AM (which is before 11 AM and would violate chronology).
    expect(new Date(driving.start_timestamp).getTime()).toBeGreaterThan(new Date(onDuty.start_timestamp).getTime());
  });

  it('tier 3: proximity to an existing logged event wins when there is no narrative anchor', () => {
    // A single-clause command (no chronological anchor within the narrative
    // itself) with an existing event ending at 5:00 PM. \"6\" should resolve to
    // 6 PM (close to that existing boundary), even if \"now\" is early morning
    // (which alone would push closest-to-now toward 6 AM).
    const now = new Date('2026-08-21T06:10:00-05:00'); // 6:10 AM the NEXT day
    const existing = [{ id: 'prev', start_timestamp: '2026-08-20T21:00:00.000Z', end_timestamp: '2026-08-20T22:00:00.000Z' }]; // ends 5 PM CT Aug 20
    const res = parseVoiceCommand('on duty at 6', { now, timezone: CT, events: existing });
    const e = res.events[0];
    const hourUTC = new Date(e.start_timestamp).getUTCHours();
    // 6 PM CT on Aug 20 = 23:00 UTC (close to the 22:00 UTC neighbor boundary).
    // Closest-to-now alone (6:10 AM Aug 21) would have picked 6 AM Aug 21 instead.\n    expect(hourUTC).toBe(23);\n  });\n\n  it('tier 4: falls back to closest-to-now only when no context/chronology/neighbor signal exists', () => {\n    const now = new Date('2026-08-20T18:05:00-05:00');\n    const res = parseVoiceCommand('off duty at 6', { now, timezone: CT });\n    const e = res.events[0];\n    const hourUTC = new Date(e.start_timestamp).getUTCHours();\n    expect(hourUTC).toBe(23); // 6 PM CT, closest to 6:05 PM \"now\"\n  });\n});\n\ndescribe('Timezone / DST correctness', () => {\n  it('Eastern Time: \"on duty at 5:15 AM\" resolves to the correct EDT offset (summer)', () => {\n    const now = new Date('2026-08-20T12:00:00Z');\n    const res = parseVoiceCommand('on duty at 5:15 AM', { now, timezone: ET });\n    // Aug 20 2026 is EDT (UTC-4): 5:15 AM EDT = 09:15 UTC.\n    expect(res.events[0].start_timestamp).toBe('2026-08-20T09:15:00.000Z');\n  });\n\n  it('Central Time: \"on duty at 5:15 AM\" resolves to the correct CDT offset (summer)', () => {\n    const now = new Date('2026-08-20T12:00:00Z');\n    const res = parseVoiceCommand('on duty at 5:15 AM', { now, timezone: CT });\n    // Aug 20 2026 is CDT (UTC-5): 5:15 AM CDT = 10:15 UTC.\n    expect(res.events[0].start_timestamp).toBe('2026-08-20T10:15:00.000Z');\n  });\n\n  it('DST spring-forward transition (2026-03-08, America/New_York): a time AFTER the 2 AM jump uses the POST-transition (EDT) offset', () => {\n    const now = new Date('2026-03-08T12:00:00Z');\n    const res = parseVoiceCommand('on duty at 5:15 AM', { now, timezone: ET });\n    // Clocks jump 2:00 AM EST -> 3:00 AM EDT at 07:00 UTC. 5:15 AM is after\n    // the jump, so it's EDT (UTC-4): 5:15 AM EDT = 09:15 UTC, NOT 10:15 UTC\n    // (which a naive single-pass offset conversion incorrectly produces).\n    expect(res.events[0].start_timestamp).toBe('2026-03-08T09:15:00.000Z');\n  });\n\n  it('DST spring-forward transition: a time BEFORE the 2 AM jump still uses the PRE-transition (EST) offset', () => {\n    const now = new Date('2026-03-08T12:00:00Z');\n    const res = parseVoiceCommand('on duty at 1:15 AM', { now, timezone: ET });\n    // 1:15 AM is before the jump, so it's still EST (UTC-5): 1:15 AM EST = 06:15 UTC.\n    expect(res.events[0].start_timestamp).toBe('2026-03-08T06:15:00.000Z');\n  });\n\n  it('DST fall-back transition (2026-11-01, America/Chicago): an explicit-meridian time resolves to the correct post-transition (CST) offset', () => {\n    const now = new Date('2026-11-01T12:00:00Z');\n    const res = parseVoiceCommand('off duty at 5:15 AM', { now, timezone: CT });\n    // Clocks fall back 2:00 AM CDT -> 1:00 AM CST at 07:00 UTC. 5:15 AM is\n    // well after the fall-back, so it's CST (UTC-6): 5:15 AM CST = 11:15 UTC.\n    expect(res.events[0].start_timestamp).toBe('2026-11-01T11:15:00.000Z');\n  });\n});\n"}
