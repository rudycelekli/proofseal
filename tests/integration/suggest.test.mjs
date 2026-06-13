// Integration: `proofseal suggest` against the REAL CLI in a throwaway git
// repo. Proves the diff → suggest → --write → seal → verify loop end-to-end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  SKIP,
  makeTempRepo,
  commitAll,
  runCli,
  expectExit,
  parseJsonOut,
  writeFiles,
  cleanup,
} from './helpers.mjs';

test('suggest: surfaces a marker for a distinctive edit and writes it', { skip: SKIP }, async () => {
  // Repo with proofseal already initialised + committed (so HEAD is a clean base).
  const dir = await makeTempRepo({
    'src/report.js': 'export function rev(base, g, q) {\n  let total = 0;\n  return total;\n}\n',
  });
  expectExit(await runCli(['init'], { cwd: dir }), 0, 'init');
  await commitAll(dir, 'init proofseal');

  try {
    // Edit the source: add a distinctive, lint-clean code line (uncommitted).
    await writeFiles(dir, {
      'src/report.js':
        'export function rev(base, g, q) {\n' +
        '  let total = 0;\n' +
        '  const clampedGrowth = Math.min(g, 0.5);\n' +
        '  return total + clampedGrowth;\n' +
        '}\n',
    });

    // suggest (read-only) → expect ONE high-confidence marker on src/report.js.
    const sug = expectExit(await runCli(['suggest', '--json'], { cwd: dir }), 0, 'suggest');
    const payload = parseJsonOut(sug);
    assert.equal(payload.ok, true);
    assert.equal(payload.suggestions.length, 1, 'one changed source file → one suggestion');
    const s = payload.suggestions[0];
    assert.equal(s.claim.type, 'marker');
    assert.equal(s.claim.file, 'src/report.js');
    assert.equal(s.confidence, 'high');
    assert.match(s.claim.marker, /clampedGrowth/);

    // Read-only run must NOT mutate proofseal.json.
    const before = JSON.parse(await readFile(path.join(dir, 'proofseal.json'), 'utf8'));
    assert.equal(before.claims.some((c) => c.file === 'src/report.js'), false);

    // --write → the suggestion lands in proofseal.json.
    const wrote = expectExit(await runCli(['suggest', '--write', '--json'], { cwd: dir }), 0, 'suggest --write');
    assert.equal(parseJsonOut(wrote).written, 1);
    const after = JSON.parse(await readFile(path.join(dir, 'proofseal.json'), 'utf8'));
    const added = after.claims.find((c) => c.file === 'src/report.js');
    assert.ok(added, 'claim persisted');
    assert.equal(added.type, 'marker');

    // The suggested claim is real: seal + verify both pass on the live tree.
    await commitAll(dir, 'add suggested claim');
    expectExit(await runCli(['seal'], { cwd: dir }), 0, 'seal');
    const verify = expectExit(await runCli(['verify', '--json'], { cwd: dir }), 0, 'verify');
    const vj = parseJsonOut(verify);
    const result = (vj.results ?? []).find((r) => r.id === added.id);
    assert.equal(result.status, 'pass', 'suggested marker verifies green');
  } finally {
    await cleanup(dir);
  }
});

test('suggest: --write is idempotent (re-running adds nothing)', { skip: SKIP }, async () => {
  const dir = await makeTempRepo({
    'src/calc.js': 'export const a = 1;\n',
  });
  expectExit(await runCli(['init'], { cwd: dir }), 0, 'init');
  await commitAll(dir, 'init');
  try {
    await writeFiles(dir, { 'src/calc.js': 'export const a = 1;\nexport const guardBound = clampRange(a);\n' });
    expectExit(await runCli(['suggest', '--write'], { cwd: dir }), 0, 'first write');
    // Second write: file is now covered by a claim → nothing new.
    const second = expectExit(await runCli(['suggest', '--write', '--json'], { cwd: dir }), 0, 'second write');
    assert.equal(parseJsonOut(second).written, 0, 'already-covered file is skipped');
  } finally {
    await cleanup(dir);
  }
});

test('suggest: errors cleanly outside a git repo', { skip: SKIP }, async () => {
  // A temp dir that is NOT a git repo, but DOES have a proofseal.json.
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(path.join(tmpdir(), 'proofseal-nogit-'));
  try {
    expectExit(await runCli(['init'], { cwd: dir }), 0, 'init');
    const res = await runCli(['suggest', '--json'], { cwd: dir });
    assert.equal(res.code, 2, 'precondition exit code');
    assert.match(parseJsonOut(res).error, /git/i);
  } finally {
    await cleanup(dir);
  }
});
