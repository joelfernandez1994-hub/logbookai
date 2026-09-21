// Builds scripts/liveAiStress.console.js — ONE self-contained browser-console
// script — from the tested sources, so the pasted script can never drift from
// the scorer (src/lib/liveAiEvaluator.js) or the 78-prompt set
// (src/lib/liveAiPromptSet.js). No imports remain in the output: the browser
// console cannot load /src/... modules from the Base44 editor origin.
//
//   node scripts/buildLiveAiStress.mjs      (rewrites scripts/liveAiStress.console.js)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const stripExports = (s) => s.replace(/^export\s+/gm, '');

export const HEADER = `/* ============================================================================
 * LogbookAI — LIVE AI STRESS RUN (standalone browser-console script)
 * ----------------------------------------------------------------------------
 * Works from an ALREADY LOGGED-IN LogbookAI tab. It does not import anything from
 * /src (the editor origin serves HTML for those paths). It calls the same backend
 * endpoints the running app's SDK client calls (/api/apps/<id>/functions/...),
 * with the session token the app already stored in localStorage. No API key, no
 * secret, no auth bypass.
 *
 * WHERE TO PASTE: the app runs inside the editor Preview as an IFRAME. In DevTools >
 * Console, switch the context dropdown (default "top") to that iframe, then paste.
 *
 * STEP 1 - SMOKE TEST (1 AI request). Before pasting:
 *     window.LIVE_AI = { testEmail: 'the-test-account@example.com' }
 *   The script verifies: not the editor page, app id, logged-in email === testEmail,
 *   role is not admin, carrier timezone === America/New_York. It then makes ONE real
 *   manualLogAssistant call ("loaded in Miami at 8 AM"), prints the raw structured
 *   response, and stops.
 * STEP 2 - full runs (only after the smoke test passed in this same page session):
 *     window.LIVE_AI = { testEmail: '...', run: 'phase1' }   // 71 prompts (everything except H01-H07)
 *     window.LIVE_AI = { testEmail: '...', run: 'phase2' }   // 7 correction/delete prompts
 *     window.LIVE_AI = { testEmail: '...', run: 'all' }      // all 78
 *     (also: only: ['A01','A10'], delayMs: 1200). Requires ai_allowance_override >= 100.
 *   Results: console tables + window.__liveAiResults (copied to the clipboard when possible).
 *
 * SAFETY: interpret mode with SYNTHETIC events in the request body - the function reads
 * context events from the body, never the database, and never writes duty-status events.
 * Side effects: the account's AI-usage counter and the function's own AIProposal audit row.
 * Route checks call the tripEstimate function (Nominatim/OSRM, no database writes).
 * There is NO save leg in this script.
 * ========================================================================== */`;

export function buildScript() {
  const evaluator = stripExports(read('src/lib/liveAiEvaluator.js'));
  const prompts = stripExports(read('src/lib/liveAiPromptSet.js'));
  const runner = read('scripts/liveAiStress.runner.body');
  return `${HEADER}\n(async () => {\n// ===================== SCORER (from src/lib/liveAiEvaluator.js) =====================\n${evaluator}\n// ===================== PROMPT SET (from src/lib/liveAiPromptSet.js) =====================\n${prompts}\n${runner}})();\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fs.writeFileSync(path.join(root, 'scripts/liveAiStress.console.js'), buildScript());
  console.log('wrote scripts/liveAiStress.console.js');
}
