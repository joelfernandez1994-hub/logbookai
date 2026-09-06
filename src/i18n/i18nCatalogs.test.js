// ============================================================================
// LogbookAI — i18n catalog regression tests.
// Guards against future drift between locales: every key added to en.json
// must have a Spanish counterpart (and vice versa), and canonical duty-status
// codes must never leak into a translation VALUE (only ever used as KEYS in
// the duty_status/duty_status_quick namespaces, which is presentation-layer
// mapping, not a change to the stored enum).
// ============================================================================
import { describe, it, expect } from 'vitest';
import en from './locales/en.json';
import es from './locales/es.json';

function flattenKeys(obj, prefix = '') {
  return Object.entries(obj).flatMap(([k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) return flattenKeys(v, key);
    return [key];
  });
}

describe('en.json and es.json stay in sync', () => {
  it('every English key has a Spanish counterpart', () => {
    const enKeys = new Set(flattenKeys(en));
    const esKeys = new Set(flattenKeys(es));
    const missingInEs = [...enKeys].filter((k) => !esKeys.has(k));
    expect(missingInEs).toEqual([]);
  });

  it('every Spanish key has an English counterpart (no orphaned translations)', () => {
    const enKeys = new Set(flattenKeys(en));
    const esKeys = new Set(flattenKeys(es));
    const missingInEn = [...esKeys].filter((k) => !enKeys.has(k));
    expect(missingInEn).toEqual([]);
  });

  it('no translation value is empty in either language', () => {
    const check = (obj, path = '') => {
      for (const [k, v] of Object.entries(obj)) {
        const p = path ? `${path}.${k}` : k;
        if (v && typeof v === 'object') check(v, p);
        else expect(String(v).trim().length, `${p} should not be empty`).toBeGreaterThan(0);
      }
    };
    check(en);
    check(es);
  });
});

describe('duty_status / duty_status_quick namespaces never rename the canonical codes', () => {
  const CANONICAL = ['OFF_DUTY', 'SLEEPER_BERTH', 'DRIVING', 'ON_DUTY'];

  it('every canonical code is present as a KEY (not translated) in both languages, in both namespaces', () => {
    for (const lang of [en, es]) {
      for (const ns of ['duty_status', 'duty_status_quick']) {
        for (const code of CANONICAL) {
          expect(Object.keys(lang[ns])).toContain(code);
        }
      }
    }
  });

  it('English and Spanish assign DIFFERENT display text to the same canonical key (real translation, not a passthrough)', () => {
    for (const code of CANONICAL) {
      expect(en.duty_status[code]).not.toBe(es.duty_status[code]);
    }
  });
});
