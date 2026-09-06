// ============================================================================
// LogbookAI — "Edit Log" reuse regression test.
// Confirms Today and Logs both open the SAME editing component/workflow for
// the selected day, rather than Today growing a second graph-editor
// implementation. Uses Vite's `?raw` import to read the page source as text
// (a full render-test isn't practical here: both pages transitively import
// @/api/base44Client, which throws under vitest's default node environment —
// see the note in src/lib/i18nMapping.test.js and prior session history).
// A static import/usage check is a precise, reliable proxy for "reuses the
// same component" and catches the exact regression class this guards against:
// someone copy-pasting RodsGraphEditor into a Today-specific component.
// ============================================================================
import { describe, it, expect } from 'vitest';
import todaySource from '../pages/Today.jsx?raw';
import logsSource from '../pages/Logs.jsx?raw';

const RODS_EDITOR_IMPORT = "from '@/components/rodsEditor/RodsGraphEditor'";

describe('Today and Logs both reuse the exact same RodsGraphEditor component', () => {
  it('Today imports RodsGraphEditor from the shared component path (not a local copy)', () => {
    expect(todaySource).toContain(RODS_EDITOR_IMPORT);
  });

  it('Logs imports RodsGraphEditor from the same shared component path', () => {
    expect(logsSource).toContain(RODS_EDITOR_IMPORT);
  });

  it('Today actually renders <RodsGraphEditor ... /> in JSX, not just imports it unused', () => {
    expect(todaySource).toMatch(/<RodsGraphEditor\b/);
  });

  it('Logs actually renders <RodsGraphEditor ... /> in JSX', () => {
    expect(logsSource).toMatch(/<RodsGraphEditor\b/);
  });

  it('there is no second/parallel graph-editor component defined inside Today.jsx itself', () => {
    // Guards against the exact anti-pattern the task explicitly forbids: a
    // Today-specific reimplementation (e.g. a local "TodayGraphEditor" or a
    // duplicated swipe/paint handler) instead of reusing the shared one.
    expect(todaySource).not.toMatch(/function\s+\w*GraphEditor\w*\s*\(/);
  });

  it('both pass the same canonical props (events/dateStr/timezone/reload) into RodsGraphEditor', () => {
    const todayCallMatch = todaySource.match(/<RodsGraphEditor([^/>]*)\/>/);
    const logsCallMatch = logsSource.match(/<RodsGraphEditor([^/>]*)\/>/);
    expect(todayCallMatch).not.toBeNull();
    expect(logsCallMatch).not.toBeNull();
    for (const prop of ['events=', 'dateStr=', 'timezone=', 'reload=']) {
      expect(todayCallMatch[1]).toContain(prop);
      expect(logsCallMatch[1]).toContain(prop);
    }
  });
});
