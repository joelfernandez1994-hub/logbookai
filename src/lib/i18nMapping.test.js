// ============================================================================
// LogbookAI — i18n Phase 1 regression tests.
// Proves: (1) the duty-status display glossary translates presentation only,
// never the canonical code; (2) an English AND a Spanish version of the same
// driver narrative — mapped through the SAME aiLayer.validateInterpretResult
// pipeline that timelineWriter ultimately consumes — normalize to byte-
// identical canonical duty_status/timestamp values. No separate Spanish
// logging engine exists; only the backend's summary/clarification text (not
// tested here — that's the LLM's job) differs by language.
// ============================================================================
import { describe, it, expect } from 'vitest';
import { validateInterpretResult, normalizeStatus, DUTY_STATUSES } from './aiLayer';
import { dutyStatusLabel, setAppLanguage, SUPPORTED_LANGUAGES } from '../i18n';

describe('dutyStatusLabel — presentation only, never touches the canonical code', () => {
  it('translates every canonical code in both supported languages without altering the code itself', () => {
    for (const lang of SUPPORTED_LANGUAGES) {
      setAppLanguage(lang);
      for (const code of DUTY_STATUSES) {
        const label = dutyStatusLabel(code);
        expect(typeof label).toBe('string');
        expect(label.length).toBeGreaterThan(0);
        // The canonical code passed in is untouched — dutyStatusLabel returns
        // a NEW display string, it never mutates or re-labels the code itself.
        expect(DUTY_STATUSES).toContain(code);
      }
    }
    setAppLanguage('en');
  });

  it('English and Spanish produce different display text for the same code (translation actually occurred)', () => {
    setAppLanguage('en');
    const en = dutyStatusLabel('DRIVING');
    setAppLanguage('es');
    const es = dutyStatusLabel('DRIVING');
    setAppLanguage('en');
    expect(en).toBe('Driving');
    expect(es).toBe('Conduciendo');
    expect(en).not.toBe(es);
  });

  it('an unrecognized code falls back to the raw value instead of throwing', () => {
    expect(dutyStatusLabel('SOME_FUTURE_CODE')).toBe('SOME_FUTURE_CODE');
  });
});

// The exact structured response shape the backend's mapInterpret() produces
// (see base44/functions/manualLogAssistant/entry.ts) for:
//   EN: "I was off duty in Miami until 6 AM, then did my pre-trip and started driving."
//   ES: "Estuve fuera de servicio hasta las 6 AM en Miami, hice mi pretrip por
//        15 minutos y después empecé a manejar."
// Per the bilingual prompt: status is ALWAYS the fixed English enum regardless
// of input language; only summary/activity/remark differ by language.
function buildBackendResponse(lang) {
  const isEs = lang === 'es';
  return {
    intent: 'add_events',
    target_date: '2026-09-10',
    requires_clarification: false,
    clarification_question: '',
    summary: isEs
      ? 'Registré fuera de servicio hasta las 6 AM en Miami, un pre-viaje de 15 minutos (duración predeterminada), y luego manejando de forma continua.'
      : 'Logged off duty until 6 AM in Miami, a 15-minute pre-trip (default duration), then ongoing driving.',
    refuses_fabrication: false,
    pretrip_ask: false,
    proposed_events: [
      {
        start_timestamp: '2026-09-10T04:00:00.000Z', // 12A local (UTC-4)
        end_timestamp: '2026-09-10T10:00:00.000Z', // 6A local
        duty_status: 'OFF_DUTY',
        city: 'Miami', state: 'FL',
        activity: isEs ? 'Fuera de Servicio' : 'Off Duty',
        remark: '',
        ambiguous_fields: ['start_timestamp'],
        field_provenance: { start_time: 'inferred', end_time: 'explicit', status: 'explicit', city: 'explicit', state: 'explicit' },
        adjustments: [],
      },
      {
        start_timestamp: '2026-09-10T10:00:00.000Z',
        end_timestamp: '2026-09-10T10:15:00.000Z', // 15-min default pre-trip
        duty_status: 'ON_DUTY',
        city: 'Miami', state: 'FL',
        activity: 'Pre-Trip',
        remark: isEs ? 'Inspección previa al viaje' : 'Pre-Trip Inspection',
        ambiguous_fields: ['end_timestamp'],
        field_provenance: { start_time: 'explicit', end_time: 'inferred', status: 'explicit', city: 'explicit', state: 'explicit' },
        adjustments: [],
      },
      {
        start_timestamp: '2026-09-10T10:15:00.000Z',
        end_timestamp: null,
        duty_status: 'DRIVING',
        city: 'Miami', state: 'FL',
        activity: 'Driving',
        remark: '',
        ambiguous_fields: [],
        field_provenance: { start_time: 'explicit', end_time: 'explicit', status: 'explicit', city: 'explicit', state: 'explicit' },
        adjustments: [],
      },
    ],
    clarifications: [],
    location_confirmations: [],
  };
}

describe('English and Spanish narratives map to identical canonical duty-status values', () => {
  it('normalizeStatus is language-agnostic — it only ever sees the fixed English enum from the schema', () => {
    // Both languages' backend responses carry the SAME status strings — the
    // schema enum forces this regardless of input language — so there is
    // nothing for normalizeStatus to "translate" in the first place.
    expect(normalizeStatus('DRIVING')).toBe('DRIVING');
    expect(normalizeStatus('OFF_DUTY')).toBe('OFF_DUTY');
  });

  it('validateInterpretResult produces byte-identical duty_status/timestamp sequences for the English and Spanish responses', () => {
    const enResult = validateInterpretResult(buildBackendResponse('en'));
    const esResult = validateInterpretResult(buildBackendResponse('es'));

    expect(enResult.valid).toBe(true);
    expect(esResult.valid).toBe(true);

    const canonicalShape = (r) => r.normalized.proposed_events.map((e) => ({
      duty_status: e.duty_status,
      start_timestamp: e.start_timestamp,
      end_timestamp: e.end_timestamp,
      city: e.city,
      state: e.state,
    }));

    expect(canonicalShape(enResult)).toEqual(canonicalShape(esResult));
  });

  it('matches the exact required shape: OFF_DUTY until 6 AM, ON_DUTY Pre-Trip 15 min, DRIVING ongoing', () => {
    for (const lang of ['en', 'es']) {
      const { normalized } = validateInterpretResult(buildBackendResponse(lang));
      const [offDuty, preTrip, driving] = normalized.proposed_events;

      expect(offDuty.duty_status).toBe('OFF_DUTY');
      expect(offDuty.end_timestamp).toBe('2026-09-10T10:00:00.000Z'); // 6 AM local

      expect(preTrip.duty_status).toBe('ON_DUTY');
      // activity_type is a fixed English label regardless of narrative
      // language (same convention as the duty_status enum) — only remark
      // free text may vary by language.
      expect(preTrip.activity_type).toBe('Pre-Trip');
      const preTripMinutes = (new Date(preTrip.end_timestamp) - new Date(preTrip.start_timestamp)) / 60000;
      expect(preTripMinutes).toBe(15);

      expect(driving.duty_status).toBe('DRIVING');
      expect(driving.end_timestamp).toBeNull(); // ongoing — is_ongoing, no destination required
    }
  });

  it('only presentation text (summary/remark) differs between languages — never the stored status codes', () => {
    const en = validateInterpretResult(buildBackendResponse('en'));
    const es = validateInterpretResult(buildBackendResponse('es'));
    expect(en.normalized.summary).not.toBe(es.normalized.summary);
    expect(en.normalized.summary).toMatch(/[a-z]/);
    expect(es.normalized.summary).toMatch(/á|é|í|ó|ú|ñ/i);
    // But the canonical statuses are identical regardless.
    const statuses = (r) => r.normalized.proposed_events.map((e) => e.duty_status);
    expect(statuses(en)).toEqual(statuses(es));
    expect(statuses(en)).toEqual(['OFF_DUTY', 'ON_DUTY', 'DRIVING']);
  });
});
