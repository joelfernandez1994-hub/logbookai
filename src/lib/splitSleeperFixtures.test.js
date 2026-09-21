// ============================================================================
// Split-sleeper re-test (previous ad-hoc fixture was inconclusive because it
// never formed a PAIR). These use the canonical scenario fixtures in
// hosScenarios.js — the engine's own definitions — and assert each requested
// category explicitly plus determinism (same input -> identical output).
// ============================================================================
import { describe, it, expect } from 'vitest';
import { SCENARIOS, runScenario } from './hosScenarios';

const byId = (id) => SCENARIOS.find((s) => s.id === id);

describe('split sleeper (canonical engine fixtures)', () => {
  it('valid 7/3 (7h sleeper + 3h off, driving between the periods): active split, no violation', () => {
    const r = runScenario(byId(1));
    expect(r.pairingLabel).toBe('7h Sleeper + 3h Off');
    expect(r.splitStatus).toBe('active');
    expect(r.violation).toBe(false);
    expect([r.driveAccumH, r.driveRemH, r.windowRemH]).toEqual([10, 1, 4]);
  });

  it('valid 8/2 (8h sleeper + 2h off, driving between): active split, no violation', () => {
    const r = runScenario(byId(2));
    expect(r.pairingLabel).toBe('8h Sleeper + 2h Off');
    expect(r.splitStatus).toBe('active');
    expect(r.violation).toBe(false);
    expect([r.driveAccumH, r.driveRemH, r.windowRemH]).toEqual([9, 2, 5]);
  });

  it('valid 7/3 sleeper + sleeper', () => {
    const r = runScenario(byId(3));
    expect(r.pairingLabel).toBe('7h Sleeper + 3h Sleeper');
    expect(r.splitStatus).toBe('active');
  });

  it('INVALID 6/4 (no >=7h period): no pairing, split status none, violation flagged', () => {
    const r = runScenario(byId(4));
    expect(r.pairingLabel).toBe('None (invalid)');
    expect(r.splitStatus).toBe('none');
    expect(r.violation).toBe(true);
  });

  it('missing paired segment (7h sleeper only): "available", not active; needs 3h more; no violation', () => {
    const r = runScenario(byId(5));
    expect(r.splitStatus).toBe('available');
    expect(r.pairingLabel).toBe('Available (7h Sleeper; need 3h)');
    expect(r.violation).toBe(false);
  });

  it('every canonical scenario matches its documented expectation', () => {
    for (const s of SCENARIOS) {
      const r = runScenario(s);
      expect(r.splitStatus, s.name).toBe(s.expected.splitStatus);
      expect(r.violation, s.name).toBe(s.expected.violation);
      expect(r.pairingLabel, s.name).toBe(s.expected.pairing);
      expect([r.driveAccumH, r.driveRemH, r.windowRemH, r.cycleRemH], s.name)
        .toEqual([s.expected.driveAccumH, s.expected.driveRemH, s.expected.windowRemH, s.expected.cycleRemH]);
    }
  });

  it('is deterministic: running every scenario twice gives identical results', () => {
    for (const s of SCENARIOS) expect(runScenario(s)).toEqual(runScenario(s));
  });
});
