// ============================================================================
// LogbookAI — deterministic route-feasibility question regression tests.
// "Can I make it to Atlanta tonight?" must combine REAL route mileage +
// ACTUAL current HOS (both injected, never AI-guessed) and never touch the
// duty-status timeline. No network calls — fetchRouteFn/earliestLegalEtaFn
// are injected fakes so this stays a pure, fast unit test.
// ============================================================================
import { describe, it, expect, vi } from 'vitest';
import { detectFeasibilityQuestion, answerFeasibilityQuestion } from './feasibilityQuestion';

describe('detectFeasibilityQuestion — pattern recognition (English + Spanish)', () => {
  it('recognizes "Can I make it to Atlanta tonight?"', () => {
    expect(detectFeasibilityQuestion('Can I make it to Atlanta tonight?')).toEqual({ city: 'Atlanta', state: '' });
  });
  it('recognizes a city with an explicit state', () => {
    expect(detectFeasibilityQuestion('Can I make it to Atlanta, GA tonight?')).toEqual({ city: 'Atlanta', state: 'GA' });
  });
  it('recognizes "will I make it to Dallas today"', () => {
    expect(detectFeasibilityQuestion('will I make it to Dallas today')).toEqual({ city: 'Dallas', state: '' });
  });
  it('recognizes "can I get to Houston by 8"', () => {
    expect(detectFeasibilityQuestion('can I get to Houston by 8')).toEqual({ city: 'Houston', state: '' });
  });
  it('recognizes the Spanish equivalent', () => {
    const r = detectFeasibilityQuestion('¿Puedo llegar a Atlanta esta noche?');
    expect(r?.city?.toLowerCase()).toContain('atlanta');
  });
  it('does not misfire on an unrelated question', () => {
    expect(detectFeasibilityQuestion('How many hours do I have left?')).toBeNull();
  });
  it('does not misfire on ordinary narrative text', () => {
    expect(detectFeasibilityQuestion('I drove to Atlanta and unloaded.')).toBeNull();
  });
  it('returns null for empty/garbage input', () => {
    expect(detectFeasibilityQuestion('')).toBeNull();
    expect(detectFeasibilityQuestion(null)).toBeNull();
  });
});

const fakeHos = { calculable: true, driving: { drivingRemainingMs: 5 * 3600000 }, window14: { remainingMs: 8 * 3600000 }, break30: { drivingAccumulatedMs: 0 }, cycle: { cycleRemainingHours: 40 }, split: { status: 'none' } };

describe('answerFeasibilityQuestion — combines real route + actual HOS, never invents either', () => {
  it('falls back (handled:false) when the text is not a feasibility question', async () => {
    const res = await answerFeasibilityQuestion('Off duty now', { currentLocation: { city: 'Miami', state: 'FL' }, hos: fakeHos });
    expect(res.handled).toBe(false);
  });

  it('falls back when current location is unknown (never guesses a starting point)', async () => {
    const res = await answerFeasibilityQuestion('Can I make it to Atlanta tonight?', { currentLocation: null, hos: fakeHos });
    expect(res.handled).toBe(false);
    expect(res.reason).toBe('no_current_location');
  });

  it('falls back when HOS is not calculable (never answers off a broken timeline)', async () => {
    const res = await answerFeasibilityQuestion('Can I make it to Atlanta tonight?', { currentLocation: { city: 'Miami', state: 'FL' }, hos: { calculable: false } });
    expect(res.handled).toBe(false);
    expect(res.reason).toBe('hos_not_calculable');
  });

  it('falls back when the routing provider cannot resolve a road route', async () => {
    const fetchRouteFn = vi.fn().mockResolvedValue(null);
    const res = await answerFeasibilityQuestion('Can I make it to Atlanta tonight?', {
      currentLocation: { city: 'Miami', state: 'FL' }, hos: fakeHos, fetchRouteFn,
    });
    expect(res.handled).toBe(false);
    expect(res.reason).toBe('route_unavailable');
    expect(fetchRouteFn).toHaveBeenCalledWith('Miami, FL', 'Atlanta');
  });

  it('answers "yes" with a real ETA when the route fits within current HOS (no rest needed)', async () => {
    const fetchRouteFn = vi.fn().mockResolvedValue({ miles: 200, hours: 3.2 });
    const truckEtaHoursFn = vi.fn().mockReturnValue(4);
    const earliestLegalEtaFn = vi.fn().mockReturnValue({ eta: new Date('2026-08-20T18:00:00Z'), segments: [{ type: 'drive' }] });
    const res = await answerFeasibilityQuestion('Can I make it to Atlanta tonight?', {
      currentLocation: { city: 'Miami', state: 'FL' }, hos: fakeHos, fetchRouteFn, truckEtaHoursFn, earliestLegalEtaFn,
    });
    expect(res.handled).toBe(true);
    expect(res.requiresRest).toBe(false);
    expect(res.answer).toMatch(/^Yes/);
    expect(res.answer).toContain('200 mi');
    expect(res.miles).toBe(200);
  });

  it('answers "not without a rest stop" when the route requires more than available HOS', async () => {
    const fetchRouteFn = vi.fn().mockResolvedValue({ miles: 900, hours: 14 });
    const truckEtaHoursFn = vi.fn().mockReturnValue(16);
    const earliestLegalEtaFn = vi.fn().mockReturnValue({
      eta: new Date('2026-08-21T08:00:00Z'),
      segments: [{ type: 'drive' }, { type: 'sleeper' }, { type: 'drive' }],
    });
    const res = await answerFeasibilityQuestion('Can I make it to Atlanta tonight?', {
      currentLocation: { city: 'Miami', state: 'FL' }, hos: fakeHos, fetchRouteFn, truckEtaHoursFn, earliestLegalEtaFn,
    });
    expect(res.handled).toBe(true);
    expect(res.requiresRest).toBe(true);
    expect(res.answer).toMatch(/^Not without/);
  });

  it('never touches the log — the answer is pure text/data, no proposed events, no writer call', async () => {
    const fetchRouteFn = vi.fn().mockResolvedValue({ miles: 200, hours: 3.2 });
    const res = await answerFeasibilityQuestion('Can I make it to Atlanta tonight?', {
      currentLocation: { city: 'Miami', state: 'FL' }, hos: fakeHos, fetchRouteFn,
      truckEtaHoursFn: () => 4, earliestLegalEtaFn: () => ({ eta: new Date(), segments: [] }),
    });
    expect(res).not.toHaveProperty('proposed_events');
    expect(res).not.toHaveProperty('events');
  });

  it('responds in Spanish when isSpanish is set', async () => {
    const fetchRouteFn = vi.fn().mockResolvedValue({ miles: 200, hours: 3.2 });
    const res = await answerFeasibilityQuestion('¿Puedo llegar a Atlanta esta noche?', {
      currentLocation: { city: 'Miami', state: 'FL' }, hos: fakeHos, fetchRouteFn,
      truckEtaHoursFn: () => 4, earliestLegalEtaFn: () => ({ eta: new Date(), segments: [{ type: 'drive' }] }),
      isSpanish: true,
    });
    expect(res.handled).toBe(true);
    expect(res.answer).toMatch(/^Sí/);
  });
});
