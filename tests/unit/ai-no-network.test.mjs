// Runtime no-network/no-key test. verify and plain suggest must work when:
//   1. ANTHROPIC_API_KEY is deleted from process.env, and
//   2. globalThis.fetch is replaced with a function that throws on any call.
// If either path tries to network, this test catches it.
//
// This is belt-and-suspenders next to the import-isolation static test —
// the static test proves the AI module is unreachable from the verdict
// path, this test proves the runtime stays clean even if some new
// dependency tries to fetch behind our back.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  seal,
  verify,
  suggestClaims,
} from '../../dist/index.js';

function makeRepo(claims) {
  const root = mkdtempSync(join(tmpdir(), 'pk-ai-no-net-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'pk@local'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'pk'], { cwd: root });
  mkdirSync(join(root, 'proofs'), { recursive: true });
  // A trivial marker claim against a real file.
  writeFileSync(
    join(root, 'app.js'),
    'function f(x) {\n  const clampedThreshold = Math.min(x, 100);\n  return clampedThreshold;\n}\n',
  );
  writeFileSync(
    join(root, 'proofseal.json'),
    JSON.stringify({ schema: 'proofseal/v1', claims }, null, 2),
  );
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: root });
  return root;
}

test('verify passes with ANTHROPIC_API_KEY deleted AND fetch throwing', async () => {
  const root = makeRepo([
    {
      type: 'marker',
      id: 'clamp',
      file: 'app.js',
      marker: 'const clampedThreshold = Math.min(x, 100);',
    },
  ]);
  const sealRes = await seal({ root });
  assert.ok(sealRes.witness, 'seal produced a witness');

  // Now the actual experiment.
  const prevKey = process.env.ANTHROPIC_API_KEY;
  const prevFetch = globalThis.fetch;
  delete process.env.ANTHROPIC_API_KEY;
  globalThis.fetch = () => {
    throw new Error('FETCH MUST NOT BE CALLED FROM VERIFY PATH');
  };
  try {
    const v = await verify({ root });
    assert.equal(v.summary.regressed, 0, 'no regressions');
    assert.equal(v.summary.missing, 0, 'no missing');
    assert.equal(v.summary.pass, 1, 'one claim passes');
  } finally {
    if (prevKey !== undefined) process.env.ANTHROPIC_API_KEY = prevKey;
    globalThis.fetch = prevFetch;
  }
});

test('plain suggest works with ANTHROPIC_API_KEY deleted AND fetch throwing', () => {
  const root = makeRepo([]);
  // Add an edit so suggest has something to look at.
  writeFileSync(
    join(root, 'totals.js'),
    'function total(xs) {\n  return xs.reduce((a, b) => a + b, 0);\n}\n',
  );

  const prevKey = process.env.ANTHROPIC_API_KEY;
  const prevFetch = globalThis.fetch;
  delete process.env.ANTHROPIC_API_KEY;
  globalThis.fetch = () => {
    throw new Error('FETCH MUST NOT BE CALLED FROM PLAIN SUGGEST');
  };
  try {
    const config = JSON.parse(readFileSync(join(root, 'proofseal.json'), 'utf8'));
    const r = suggestClaims(root, config, {});
    // suggest may return [] or some suggestions depending on lint outcome;
    // the assertion is "does not throw, does not network".
    assert.ok(Array.isArray(r.suggestions));
    assert.ok(Array.isArray(r.skipped));
  } finally {
    if (prevKey !== undefined) process.env.ANTHROPIC_API_KEY = prevKey;
    globalThis.fetch = prevFetch;
  }
});
