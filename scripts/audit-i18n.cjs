#!/usr/bin/env node
// ============================================================================
// LogbookAI — i18n audit utility.
// Scans src/pages and src/components (excluding generic ui/ primitives and
// *.test.js) for likely hardcoded, user-facing English strings not yet routed
// through t()/useTranslation. Heuristic, not perfect — meant to find files
// still needing conversion and track progress over time, not as a hard gate.
//
// Usage: node scripts/audit-i18n.cjs [--files]
//   (no args)  prints a per-file count summary, sorted worst-first
//   --files    also prints each matched line (path:line: text)
// ============================================================================
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'src');
const SCAN_DIRS = ['pages', 'components'];
const EXCLUDE_DIR_SEGMENT = `${path.sep}ui${path.sep}`;

// Files that intentionally stay English regardless of app language (official
// exports) — never flagged.
const EXCLUDE_FILES = new Set([
  'lib/pdfGenerator.js',
  'lib/iftaPdf.js',
  'lib/iftaCsv.js',
]);

// JSX text-node text (>Some Text<), ignoring pure whitespace/punctuation/numbers.
const TEXT_NODE_RE = />\s*([A-Z][a-zA-Z][a-zA-Z0-9 ,.'"/#:%()&+_-]{2,})\s*</g;
// Common attrs that carry user-visible copy.
const ATTR_RE = /\b(placeholder|title|aria-label|alt)="([A-Z][^"]{2,})"/g;

// Lines containing these are structural/technical, not copy — skip.
const SKIP_LINE_RE = /^\s*(\/\/|\*|import |export const \w+ = \[|className=)/;
const SKIP_TEXT_RE = /^(OFF_DUTY|SLEEPER_BERTH|DRIVING|ON_DUTY|[A-Z_]+|\d+[\d.,: ]*|[A-Z]{2,5})$/;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (full.includes(EXCLUDE_DIR_SEGMENT)) continue;
      walk(full, out);
    } else if (entry.isFile() && /\.jsx?$/.test(entry.name) && !entry.name.endsWith('.test.js')) {
      out.push(full);
    }
  }
  return out;
}

function relKey(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

function scanFile(file) {
  const rel = relKey(file);
  if (EXCLUDE_FILES.has(rel)) return [];
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const hits = [];
  lines.forEach((line, i) => {
    if (SKIP_LINE_RE.test(line)) return;
    let m;
    TEXT_NODE_RE.lastIndex = 0;
    while ((m = TEXT_NODE_RE.exec(line))) {
      const t = m[1].trim();
      if (!t || SKIP_TEXT_RE.test(t)) continue;
      if (line.includes('t(') && line.indexOf(t) > line.indexOf('t(')) continue; // crude: already wrapped
      hits.push({ line: i + 1, text: t, kind: 'text' });
    }
    ATTR_RE.lastIndex = 0;
    while ((m = ATTR_RE.exec(line))) {
      hits.push({ line: i + 1, text: m[2], kind: `attr:${m[1]}` });
    }
  });
  return hits;
}

function main() {
  const files = SCAN_DIRS.flatMap((d) => walk(path.join(ROOT, d)));
  const results = files
    .map((f) => ({ file: relKey(f), hits: scanFile(f) }))
    .filter((r) => r.hits.length > 0)
    .sort((a, b) => b.hits.length - a.hits.length);

  const showFiles = process.argv.includes('--files');
  let total = 0;
  for (const r of results) {
    total += r.hits.length;
    console.log(`${String(r.hits.length).padStart(4)}  ${r.file}`);
    if (showFiles) {
      for (const h of r.hits) console.log(`      ${r.file}:${h.line}  [${h.kind}] ${h.text}`);
    }
  }
  console.log('---');
  console.log(`${results.length} files, ${total} likely-hardcoded strings (heuristic count)`);
}

main();
