// Unit tests for the pure suggest core (no git, no fs). Imports only the
// published library surface, per the same contract as the other unit suites.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickMarker, makeId, suggestForFile } from '../../dist/index.js';

// ─── makeId ──────────────────────────────────────────────────────────
test('makeId: slugifies a path basename without extension', () => {
  assert.equal(makeId('src/foo/Report.ts', new Set()), 'report');
  assert.equal(makeId('a/b/quarterly_revenue.py', new Set()), 'quarterly-revenue');
});

test('makeId: suffixes on collision to stay unique', () => {
  const have = new Set(['report']);
  assert.equal(makeId('src/Report.ts', have), 'report-2');
  have.add('report-2');
  assert.equal(makeId('other/report.js', have), 'report-3');
});

test('makeId: falls back to "claim" for an empty slug', () => {
  assert.equal(makeId('._.', new Set()), 'claim');
});

// ─── pickMarker ──────────────────────────────────────────────────────
test('pickMarker: prefers a fix-keyword code line that lints clean', () => {
  const file =
    'function f(x) {\n' +
    '  const clampedThreshold = Math.min(x, 100);\n' +
    '  return clampedThreshold;\n' +
    '}\n';
  const added = ['  const clampedThreshold = Math.min(x, 100);'];
  assert.equal(pickMarker(added, file), 'const clampedThreshold = Math.min(x, 100);');
});

test('pickMarker: rejects comment-only added lines', () => {
  const file = '// fix: handle the boundary case here\nconst x = 1;\n';
  const added = ['// fix: handle the boundary case here'];
  assert.equal(pickMarker(added, file), undefined);
});

test('pickMarker: rejects a log/exception string (lint would flag it)', () => {
  const file = "if (bad) throw new Error('invalid configuration provided');\n";
  const added = ["throw new Error('invalid configuration provided');"];
  // hasLogWords + sentence-shape → lintMarker warns → not suggested.
  assert.equal(pickMarker(added, file), undefined);
});

test('pickMarker: rejects a non-unique line (duplicate masks removal)', () => {
  const dupLine = 'return validateBounds(value);';
  const file = `function a() { ${dupLine} }\nfunction b() { ${dupLine} }\n`;
  assert.equal(pickMarker([dupLine], file), undefined);
});

test('pickMarker: returns undefined when nothing carries code signal', () => {
  const file = 'plain prose line with no code shape at all\n';
  assert.equal(pickMarker(['plain prose line with no code shape at all'], file), undefined);
});

// ─── suggestForFile ──────────────────────────────────────────────────
test('suggestForFile: emits a high-confidence marker claim when one qualifies', () => {
  const file = 'export const guardThreshold = clampValue(input, 0, 1);\n';
  const s = suggestForFile('src/calc.ts', ['export const guardThreshold = clampValue(input, 0, 1);'], file, new Set());
  assert.equal(s.confidence, 'high');
  assert.equal(s.claim.type, 'marker');
  assert.equal(s.claim.file, 'src/calc.ts');
  assert.equal(s.claim.id, 'calc');
  assert.equal(s.claim.marker, 'export const guardThreshold = clampValue(input, 0, 1);');
});

test('suggestForFile: falls back to a medium-confidence file-hash claim', () => {
  const file = 'x\n';
  const s = suggestForFile('src/calc.ts', ['x'], file, new Set());
  assert.equal(s.confidence, 'medium');
  assert.equal(s.claim.type, 'file-hash');
  assert.equal(s.claim.file, 'src/calc.ts');
});

test('suggestForFile: respects ids already taken in the run', () => {
  const file = 'noop\n';
  const s = suggestForFile('src/calc.ts', ['noop'], file, new Set(['calc']));
  assert.equal(s.claim.id, 'calc-2');
});
