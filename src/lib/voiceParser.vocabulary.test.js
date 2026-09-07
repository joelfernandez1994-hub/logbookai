// ============================================================================
// LogbookAI — trucking-vocabulary regression tests (deterministic parser).
// Covers the expanded English + Spanish vocabulary added for the AI-logging
// overhaul: a driver should never need to "speak computer" to be understood.
// Fuzz-style: many real-world phrasings of the SAME intended status must all
// resolve to the same canonical duty status.
// ============================================================================
import { describe, it, expect } from 'vitest';
import { parseVoiceCommand } from './voiceParser';

const TZ = 'America/Chicago';
const NOW = new Date('2026-08-20T18:00:00Z'); // 1 PM Chicago

function status(text) {
  const res = parseVoiceCommand(text, { now: NOW, timezone: TZ });
  expect(res.handled).toBe(true);
  return res.events[0];
}

describe('DRIVING synonyms — fuzz: many phrasings, one canonical status', () => {
  const variants = [
    'started driving at 2',
    'started rolling at 2',
    'got rolling at 2',
    'pulled out at 2',
    'started back up at 2',
    'got back on the road at 2',
    'hit the road at 2',
    'took off at 2',
    'headed out at 2',
  ];
  for (const v of variants) {
    it(`"${v}" -> DRIVING`, () => {
      expect(status(v).duty_status).toBe('DRIVING');
    });
  }

  it('Spanish "empecé a manejar a las 2" -> DRIVING', () => {
    expect(status('empecé a manejar a las 2').duty_status).toBe('DRIVING');
  });
  it('Spanish "arranqué a las 2" -> DRIVING', () => {
    expect(status('arranqué a las 2').duty_status).toBe('DRIVING');
  });
});

describe('OFF_DUTY synonyms', () => {
  const variants = [
    'shut down for the night at 10',
    'called it a night at 10',
    'done for the night at 10',
    'off duty at 10',
  ];
  for (const v of variants) {
    it(`"${v}" -> OFF_DUTY`, () => {
      expect(status(v).duty_status).toBe('OFF_DUTY');
    });
  }
  it('Spanish "fuera de servicio a las 10" -> OFF_DUTY', () => {
    expect(status('fuera de servicio a las 10').duty_status).toBe('OFF_DUTY');
  });
});

describe('SLEEPER_BERTH synonyms', () => {
  it('"went in the sleeper at 10" -> SLEEPER_BERTH', () => {
    expect(status('went in the sleeper at 10').duty_status).toBe('SLEEPER_BERTH');
  });
  it('"got in the bunk at 10" -> SLEEPER_BERTH', () => {
    expect(status('got in the bunk at 10').duty_status).toBe('SLEEPER_BERTH');
  });
  it('Spanish "en la litera a las 10" -> SLEEPER_BERTH', () => {
    expect(status('en la litera a las 10').duty_status).toBe('SLEEPER_BERTH');
  });
});

describe('ambiguous rest verbs — never silently assume the sleeper berth', () => {
  it('"went to bed at 10" is ambiguous (OFF_DUTY default, flagged)', () => {
    const res = parseVoiceCommand('went to bed at 10', { now: NOW, timezone: TZ });
    const e = res.events[0];
    expect(e.duty_status).toBe('OFF_DUTY');
    expect(e._ambiguous.duty_status).toBe(true);
  });
  it('"went to bed in the sleeper at 10" resolves unambiguously to SLEEPER_BERTH (explicit berth context)', () => {
    const e = status('went to bed in the sleeper at 10');
    expect(e.duty_status).toBe('SLEEPER_BERTH');
  });
});

describe('ambiguous generic break/lunch — never guessed as the mandatory 30', () => {
  it('"stopped for lunch at noon" is ambiguous between OFF_DUTY and ON_DUTY', () => {
    const res = parseVoiceCommand('stopped for lunch at noon', { now: NOW, timezone: TZ });
    const e = res.events[0];
    expect(e.duty_status).toBe('OFF_DUTY');
    expect(e._ambiguous.duty_status).toBe(true);
  });
  it('"took my 30 at noon" is the UNAMBIGUOUS mandatory break, not the generic-lunch guess', () => {
    const res = parseVoiceCommand('took my 30 at noon', { now: NOW, timezone: TZ });
    const e = res.events[0];
    expect(e.activity_type).toBe('30-Minute Break');
    expect(e._ambiguous.duty_status).toBeFalsy();
  });
});

describe('ON_DUTY activity vocabulary', () => {
  it('"checked the truck at 9" -> ON_DUTY / Vehicle Check', () => {
    const e = status('checked the truck at 9');
    expect(e.duty_status).toBe('ON_DUTY');
    expect(e.activity_type).toBe('Vehicle Check');
  });
  it('"detention at the shipper at 9" -> ON_DUTY / Detention', () => {
    const e = status('detention at the shipper at 9');
    expect(e.duty_status).toBe('ON_DUTY');
    expect(e.activity_type).toBe('Detention');
  });
  it('"did paperwork at 9" -> ON_DUTY / Paperwork', () => {
    const e = status('did paperwork at 9');
    expect(e.duty_status).toBe('ON_DUTY');
    expect(e.activity_type).toBe('Paperwork');
  });
  it('"drop and hook at 9" -> ON_DUTY / Equipment Change', () => {
    const e = status('drop and hook at 9');
    expect(e.duty_status).toBe('ON_DUTY');
    expect(e.activity_type).toBe('Equipment Change');
  });
});

describe('typo / casing / punctuation robustness', () => {
  it('all-caps still resolves', () => {
    expect(status('OFF DUTY AT 10').duty_status).toBe('OFF_DUTY');
  });
  it('extra punctuation does not break parsing', () => {
    expect(status('off duty... at 10!!').duty_status).toBe('OFF_DUTY');
  });
  it('no punctuation at all (speech-like input) still resolves', () => {
    const res = parseVoiceCommand('stopped for fuel around 9 for 20 minutes', { now: NOW, timezone: TZ });
    expect(res.handled).toBe(true);
    const e = res.events[0];
    expect(e.activity_type).toBe('Fuel');
    expect((new Date(e.end_timestamp) - new Date(e.start_timestamp)) / 60000).toBe(20);
  });
});
