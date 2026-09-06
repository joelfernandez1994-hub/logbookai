// ============================================================================
// LogbookAI — i18n setup (react-i18next). ONE canonical language system for
// the presentation layer only. Never touches stored data: canonical
// duty-status codes (OFF_DUTY / SLEEPER_BERTH / DRIVING / ON_DUTY) and every
// other database enum stay in English in the database regardless of the
// driver's chosen display language — only the `duty_status` / `duty_status_
// quick` translation keys map them to a display label. Official exports
// (RODS/DVIR/IFTA PDFs and CSVs, certification labels) intentionally do NOT
// import this module — pdfGenerator.js / iftaPdf.js / iftaCsv.js stay
// hardcoded English on purpose, per app policy, regardless of app language.
// ============================================================================
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import es from './locales/es.json';

export const SUPPORTED_LANGUAGES = ['en', 'es'];
export const LANGUAGE_STORAGE_KEY = 'logbookai.language';

function cachedLanguage() {
  try {
    const stored = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    return SUPPORTED_LANGUAGES.includes(stored) ? stored : 'en';
  } catch (e) {
    return 'en';
  }
}

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    es: { translation: es },
  },
  lng: cachedLanguage(),
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
  returnEmptyString: false,
});

// Change the active display language and persist it locally so the next app
// load starts in the right language before the driver's profile has loaded.
// The caller (useDriverData) is responsible for also saving it to
// DriverProfile so it follows the driver across devices.
export function setAppLanguage(lang) {
  const next = SUPPORTED_LANGUAGES.includes(lang) ? lang : 'en';
  if (i18n.language !== next) i18n.changeLanguage(next);
  try { localStorage.setItem(LANGUAGE_STORAGE_KEY, next); } catch (e) {}
}

// Translate a canonical duty-status code to a display label in the CURRENT
// app language. `quick` selects the shorter quick-selector label. Never call
// this on a value before it's written to the database — it's presentation
// only. Falls back to the raw code for an unrecognized value rather than
// throwing, so an unexpected/legacy value still renders something.
export function dutyStatusLabel(code, { quick = false } = {}) {
  const ns = quick ? 'duty_status_quick' : 'duty_status';
  const label = i18n.t(`${ns}.${code}`, { defaultValue: '' });
  return label || code || '';
}

export default i18n;
