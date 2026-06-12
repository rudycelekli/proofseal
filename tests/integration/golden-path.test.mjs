// Integration test 1 — Golden path (ADR-0001 §4.1, §5.6).
// init -> claim add (file-hash + marker) -> seal -> verify exits 0 all-pass;
// verify --json parses and summary counts match results.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  SKIP,
  MARKER,
  makeTempRepo,
  runCli,
  claimAdd,
  commitAll,
  parseJsonOut,
  resultById,
  cleanup,
  expectExit,
} from './helpers.mjs';

test('golden path: init -> claim add -> seal -> verify (exit 0, all pass)', { skip: SKIP }, async () => {
  let dir;
  try {
    dir = await makeTempRepo({
      'src/feature.js':
        'export function feature() { return 42; }\n' + `// fix: ${MARKER}\n`,
      'src/util.js': 'export const util = 1;\n',
    });

    // init scaffolds proofseal.json + proofs/ + a sample claim, exit 0.
    expectExit(await runCli(['init'], { cwd: dir }), 0, 'init');
    assert.ok(
      existsSync(path.join(dir, 'proofseal.json')),
      'init must scaffold proofseal.json',
    );
    assert.ok(
      existsSync(path.join(dir, 'proofs')),
      'init must scaffold proofs/ directory',
    );

    // Idempotence guard: re-init without --force refuses with exit 2
    // (extraction-map pitfall #13: hand-edited/overwritten state breaks
    // signatures; regeneration is the only legal mutation).
    expectExit(
      await runCli(['init'], { cwd: dir }),
      2,
      'init without --force on existing scaffold',
    );
    // ...and --force is allowed.
    expectExit(await runCli(['init', '--force'], { cwd: dir }), 0, 'init --force');

    expectExit(
      await claimAdd(dir, {
        id: 'util-hash',
        type: 'file-hash',
        file: 'src/util.js',
        desc: 'util file integrity',
      }),
      0,
      'claim add file-hash',
    );
    expectExit(
      await claimAdd(dir, {
        id: 'feature-marker',
        type: 'marker',
        file: 'src/feature.js',
        marker: MARKER,
        desc: 'feature fix marker present',
      }),
      0,
      'claim add marker',
    );

    // claim list shows both claims.
    const list = expectExit(
      await runCli(['claim', 'list'], { cwd: dir }),
      0,
      'claim list',
    );
    assert.match(list.stdout, /util-hash/, 'claim list shows file-hash claim');
    assert.match(list.stdout, /feature-marker/, 'claim list shows marker claim');

    await commitAll(dir, 'add proofkit claims');
    expectExit(await runCli(['seal'], { cwd: dir }), 0, 'seal');
    assert.ok(
      existsSync(path.join(dir, 'proofs', 'manifest.json')),
      'seal must write proofs/manifest.json',
    );
    assert.ok(
      existsSync(path.join(dir, 'proofs', 'history.jsonl')),
      'seal must append proofs/history.jsonl',
    );

    // Human-readable verify: exit 0.
    expectExit(await runCli(['verify'], { cwd: dir }), 0, 'verify');

    // Machine-readable verify: {ok, signature, summary, results[]}.
    const res = await runCli(['verify', '--json'], { cwd: dir });
    expectExit(res, 0, 'verify --json');
    const json = parseJsonOut(res);
    assert.equal(json.ok, true, 'verify --json: ok must be true');
    assert.ok('signature' in json, 'verify --json: signature block present');
    assert.ok('summary' in json, 'verify --json: summary present');
    assert.ok(Array.isArray(json.results), 'verify --json: results[] present');

    // Every claim freshly sealed must classify as pass (§5.6).
    for (const r of json.results) {
      assert.equal(
        r.status,
        'pass',
        `freshly sealed claim ${r.id} must be "pass", got "${r.status}"`,
      );
    }
    const ours = ['util-hash', 'feature-marker'];
    for (const id of ours) {
      assert.ok(resultById(json, id), `results must include claim ${id}`);
    }

    // Summary counts must agree with results[] (internal consistency of the
    // machine contract — CI dashboards key off summary).
    const statusCounts = {};
    for (const r of json.results) {
      statusCounts[r.status] = (statusCounts[r.status] ?? 0) + 1;
    }
    const total =
      json.summary.totalClaims ?? json.summary.total ?? json.results.length;
    assert.equal(
      total,
      json.results.length,
      'summary total must equal results length',
    );
    // All pass => no regressed/missing reported anywhere in summary.
    const summaryStr = JSON.stringify(json.summary);
    assert.equal(statusCounts.regressed ?? 0, 0);
    assert.equal(statusCounts.missing ?? 0, 0);
    assert.ok(
      !/"(regressed|missing)":\s*[1-9]/.test(summaryStr),
      `summary must not report regressed/missing on golden path: ${summaryStr}`,
    );
  } finally {
    await cleanup(dir);
  }
});

test('claim rm removes a claim from claim list', { skip: SKIP }, async () => {
  let dir;
  try {
    dir = await makeTempRepo({ 'src/util.js': 'export const util = 1;\n' });
    expectExit(await runCli(['init'], { cwd: dir }), 0, 'init');
    expectExit(
      await claimAdd(dir, {
        id: 'util-hash',
        type: 'file-hash',
        file: 'src/util.js',
        desc: 'util file integrity',
      }),
      0,
      'claim add',
    );
    expectExit(
      await runCli(['claim', 'rm', 'util-hash'], { cwd: dir }),
      0,
      'claim rm',
    );
    const list = expectExit(
      await runCli(['claim', 'list'], { cwd: dir }),
      0,
      'claim list after rm',
    );
    assert.ok(
      !list.stdout.includes('util-hash'),
      'removed claim must not appear in claim list',
    );
  } finally {
    await cleanup(dir);
  }
});
