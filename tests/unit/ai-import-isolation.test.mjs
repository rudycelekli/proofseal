// The iron rule, made structural. BFS the transitive import tree of every
// file on the verdict path (seal, verify, harness/run, harness/normalize)
// and assert no path reaches src/suggest/ai/*. If a future PR ever adds the
// wrong import, this test fails the build. That's the whole point — the
// boundary cannot erode by accident.
//
// We parse `import ... from '...';` lines off the SOURCE files (not dist)
// so the test catches drift before tsc has a chance to inline anything.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', '..', 'src');

const ROOTS = [
  'manifest/seal.ts',
  'manifest/verify.ts',
  'harness/run.ts',
  'harness/normalize.ts',
];

const FORBIDDEN_PREFIX = 'suggest/ai/';

/** Resolve a relative .js import (as written in TS source) to an absolute .ts path. */
function resolveImport(fromFile, spec) {
  if (!spec.startsWith('.')) return null; // external dep
  const fromDir = dirname(fromFile);
  // Specs are written `'./foo.js'` per NodeNext convention; the real file is .ts.
  const candidates = [
    resolve(fromDir, spec.replace(/\.js$/, '.ts')),
    resolve(fromDir, spec.replace(/\.js$/, '.tsx')),
    resolve(fromDir, spec, 'index.ts'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

function importsOf(absPath) {
  const text = readFileSync(absPath, 'utf8');
  const out = [];
  // Match top-level static imports only — we don't trace dynamic imports
  // because the test's purpose is to catch accidental static coupling.
  const re = /^\s*import\b[^;]*?from\s+['"]([^'"]+)['"]\s*;?/gm;
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[1]);
  // Also catch `import '…';` side-effect form.
  const re2 = /^\s*import\s+['"]([^'"]+)['"]\s*;?/gm;
  while ((m = re2.exec(text)) !== null) out.push(m[1]);
  return out;
}

function walk(startAbs) {
  const visited = new Set();
  const queue = [startAbs];
  while (queue.length) {
    const f = queue.shift();
    if (visited.has(f)) continue;
    visited.add(f);
    const specs = importsOf(f);
    for (const spec of specs) {
      const resolved = resolveImport(f, spec);
      if (resolved && !visited.has(resolved)) queue.push(resolved);
    }
  }
  return visited;
}

for (const rel of ROOTS) {
  test(`iron rule: ${rel} does not transitively import src/suggest/ai/*`, () => {
    const root = resolve(SRC, rel);
    assert.ok(existsSync(root), `expected root file to exist: ${rel}`);
    const reached = walk(root);

    const violations = [];
    for (const f of reached) {
      const r = relative(SRC, f).replace(/\\/g, '/');
      if (r.startsWith(FORBIDDEN_PREFIX)) violations.push(r);
    }
    assert.deepEqual(
      violations,
      [],
      `${rel} reached forbidden AI module(s): ${violations.join(', ')}\n` +
        'The AI module MUST NOT be reachable from the verdict path. ' +
        'If you intentionally need a helper from suggest/ai, move that helper out of suggest/ai/ first.',
    );
  });
}

test('iron rule (Build 3): verdict-path files cannot reach src/suggest/ai/triage.ts in particular', () => {
  // Build 2's BFS test above already forbids ALL of src/suggest/ai/* — this
  // is a direct, by-name pin that documents the Build 3 boundary. If a future
  // PR renames triage.ts or moves it out of suggest/ai/, this assertion
  // names the file explicitly so the failure message points at the rule.
  const triagePath = resolve(SRC, 'suggest', 'ai', 'triage.ts');
  assert.ok(existsSync(triagePath), 'expected src/suggest/ai/triage.ts to exist (Build 3)');
  for (const rel of ROOTS) {
    const root = resolve(SRC, rel);
    const reached = walk(root);
    assert.equal(
      reached.has(triagePath),
      false,
      `${rel} reached suggest/ai/triage.ts — the verdict path must not import the AI triage module`,
    );
  }
});

test('iron rule: src/suggest/ai/client.ts is the ONLY file that READS the API key env var', () => {
  // Defense-in-depth next to the static import graph. We forbid actual env
  // reads (process.env.ANTHROPIC_API_KEY, env.ANTHROPIC_API_KEY) — not
  // documentation strings, since the CLI's --ai option description rightly
  // names the env var so the user knows what to set. The point of the rule
  // is "no module outside suggest/ai/* ever READS the key", and that's
  // what we test for.
  const READ_PATTERNS = [
    /process\.env\.ANTHROPIC_API_KEY/,
    /env\.ANTHROPIC_API_KEY/,
    /process\.env\[\s*['"]ANTHROPIC_API_KEY['"]\s*\]/,
  ];
  const filesToCheck = [
    'manifest/seal.ts',
    'manifest/verify.ts',
    'harness/run.ts',
    'harness/normalize.ts',
    'suggest/suggest.ts',
    'suggest/core.ts',
    'suggest/diff.ts',
    'index.ts',
    'cli/index.ts',
  ];
  const offenders = [];
  for (const rel of filesToCheck) {
    const p = resolve(SRC, rel);
    if (!existsSync(p)) continue;
    const text = readFileSync(p, 'utf8');
    if (READ_PATTERNS.some((re) => re.test(text))) offenders.push(rel);
  }
  assert.deepEqual(
    offenders,
    [],
    `process.env.ANTHROPIC_API_KEY is read outside src/suggest/ai/: ${offenders.join(', ')}`,
  );
});
