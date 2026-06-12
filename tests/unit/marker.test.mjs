// Marker robustness (premortem #7): whitespace-normalized matching + lint.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  markerPresent,
  markerOccurrences,
  lintMarker,
  classifyFileClaim,
  refreshClaim,
  fileSha256,
} from '../../dist/index.js';

// ── markerPresent: whitespace-normalized matching ───────────────────

test('markerPresent: exact substring still matches', () => {
  assert.equal(markerPresent('const x = computeTotal(a, b);', 'computeTotal(a, b)'), true);
});

test('markerPresent: survives a Prettier-style line-wrap of the marker', () => {
  const marker = 'export function computeTotal(items, taxRate) { return items.length * taxRate; }';
  const wrapped =
    'export function computeTotal(\n' +
    '  items,\n' +
    '  taxRate\n' +
    ') {\n' +
    '  return items.length * taxRate;\n' +
    '}\n';
  assert.equal(wrapped.includes(marker), false, 'plain substring match must fail (the premise)');
  assert.equal(markerPresent(wrapped, marker), true);
});

test('markerPresent: survives re-indent and tabs→spaces', () => {
  const marker = 'if (user.isAdmin) {\n    grantAccess(user);\n}';
  const reindented = 'function gate(user) {\n\tif (user.isAdmin) {\n\t\tgrantAccess(user);\n\t}\n}\n';
  assert.equal(markerPresent(reindented, marker), true);
});

test('markerPresent: non-whitespace edits to the marker still fail', () => {
  assert.equal(markerPresent('grantAccessToAll(user)', 'grantAccess(user)'), false);
});

test('markerOccurrences: whitespace-normalized count', () => {
  const text = 'foo(a, b)\nfoo(a,\n  b)\nbar()\n';
  assert.equal(markerOccurrences(text, 'foo(a, b)'), 2);
});

// ── classifier integration: reformat ⇒ drift, not regression ────────

test('classifyFileClaim: reformatting around a marker is drift, not regressed', () => {
  const root = mkdtempSync(join(tmpdir(), 'pk-marker-'));
  const abs = join(root, 'mod.js');
  const marker = 'export function applyFix(input) { return sanitize(input); }';
  writeFileSync(abs, `// module\n${marker}\n`);
  const sealed = refreshClaim(root, { id: 'm', type: 'marker', file: 'mod.js', marker });
  assert.equal(sealed.markerVerified, true);

  // Prettier-style rewrap: hash changes, whitespace-normalized marker survives.
  writeFileSync(
    abs,
    '// module\nexport function applyFix(\n  input\n) {\n  return sanitize(input);\n}\n',
  );
  const r = classifyFileClaim(root, { ...sealed, sha256: sealed.sha256 });
  assert.equal(r.status, 'drift');
  assert.equal(r.markerPresent, true);
  assert.equal(r.sha256Match, false);

  // Real removal still regresses.
  writeFileSync(abs, '// module\n// fix reverted\n');
  assert.equal(classifyFileClaim(root, sealed).status, 'regressed');
});

test('refreshClaim: markerVerified true through whitespace-only differences', () => {
  const root = mkdtempSync(join(tmpdir(), 'pk-marker-rc-'));
  writeFileSync(join(root, 'a.js'), 'const  spaced   =\n\t1;\n');
  const c = refreshClaim(root, { id: 'm', type: 'marker', file: 'a.js', marker: 'const spaced = 1;' });
  assert.equal(c.markerVerified, true);
  assert.equal(c.sha256, fileSha256(join(root, 'a.js')));
});

// ── lintMarker heuristics ────────────────────────────────────────────

test('lintMarker: clean identifier marker produces no warnings', () => {
  assert.deepEqual(lintMarker('computeWitnessChain(manifest)', 'x\ncomputeWitnessChain(manifest)\ny\n'), []);
});

test('lintMarker (i): duplicate occurrence in target file', () => {
  const text = 'helper()\nhelper()\n';
  const warnings = lintMarker('helper()', text);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /appears 2 times/);
  assert.match(warnings[0], /prefer a function\/identifier name/);
});

test('lintMarker (i): duplicate count is whitespace-normalized', () => {
  const text = 'foo(a, b)\nfoo(a,\n   b)\n';
  const warnings = lintMarker('foo(a, b)', text);
  assert.match(warnings[0], /appears 2 times/);
});

test('lintMarker (ii): placeholder strings flag as log-message-like', () => {
  assert.match(lintMarker('user %s not found').join('\n'), /log\/exception message/);
  assert.match(lintMarker('count was ${count}').join('\n'), /log\/exception message/);
  assert.match(lintMarker('value {} rejected').join('\n'), /log\/exception message/);
});

test('lintMarker (ii): error-word natural-language sentence flags', () => {
  const warnings = lintMarker('Cannot read property of undefined value');
  assert.match(warnings.join('\n'), /log\/exception message/);
});

test('lintMarker (ii): error word inside a code fragment does NOT flag', () => {
  assert.deepEqual(lintMarker('throwInvalidStateError()'), []);
});

test('lintMarker (iii): formatting-sensitive characters flag', () => {
  assert.match(lintMarker('use `fetchAll` here').join('\n'), /backticks/);
  assert.match(lintMarker('a  =  b').join('\n'), /multiple consecutive spaces/);
  assert.match(lintMarker('  padded()').join('\n'), /leading\/trailing whitespace/);
  assert.match(lintMarker('"quoted sentinel"').join('\n'), /quotes at both ends/);
});

test('lintMarker: never throws on a missing file (text undefined)', () => {
  assert.deepEqual(lintMarker('stableIdentifier', undefined), []);
});
