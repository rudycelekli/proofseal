// Integration tests 2-4 — Drift semantics (ADR-0001 §5.6, D8):
//   drift     = marker holds, hash changed   -> exit 0, reported
//   regressed = marker gone                  -> exit 1
//   missing   = file deleted                 -> exit 1
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  SKIP,
  MARKER,
  sealedFixture,
  runCli,
  parseJsonOut,
  resultById,
  cleanup,
  expectExit,
} from './helpers.mjs';

test('drift: file edited but marker intact -> verify exit 0, status "drift"', { skip: SKIP }, async () => {
  let dir;
  try {
    dir = await sealedFixture();

    // Edit the marker-claimed file WITHOUT touching the marker substring.
    await appendFile(
      path.join(dir, 'src', 'feature.js'),
      '\n// routine refactor comment — marker untouched\n',
      'utf8',
    );

    // D8: drift is non-fatal. Exit MUST be 0 or the tool gets uninstalled.
    const res = await runCli(['verify', '--json'], { cwd: dir });
    expectExit(res, 0, 'verify with drifted (marker-intact) file');
    const json = parseJsonOut(res);
    assert.equal(json.ok, true, 'ok stays true under drift');

    const claim = resultById(json, 'feature-marker');
    assert.ok(claim, 'feature-marker result present');
    assert.equal(
      claim.status,
      'drift',
      `edited file with intact marker must classify as "drift", got "${claim.status}"`,
    );

    // Untouched file-hash claim stays pass.
    assert.equal(resultById(json, 'util-hash')?.status, 'pass');
  } finally {
    await cleanup(dir);
  }
});

test('regression: marker substring removed -> verify exit 1, status "regressed"', { skip: SKIP }, async () => {
  let dir;
  try {
    dir = await sealedFixture();

    const file = path.join(dir, 'src', 'feature.js');
    const contents = await readFile(file, 'utf8');
    assert.ok(contents.includes(MARKER), 'fixture sanity: marker present');
    await writeFile(file, contents.replaceAll(MARKER, ''), 'utf8');

    const res = await runCli(['verify', '--json'], { cwd: dir });
    expectExit(res, 1, 'verify with removed marker');
    const json = parseJsonOut(res);
    assert.equal(json.ok, false, 'ok must be false on regression');

    const claim = resultById(json, 'feature-marker');
    assert.ok(claim, 'feature-marker result present');
    assert.equal(
      claim.status,
      'regressed',
      `marker removal must classify as "regressed", got "${claim.status}"`,
    );
  } finally {
    await cleanup(dir);
  }
});

test('missing: claimed file deleted -> verify exit 1, status "missing"', { skip: SKIP }, async () => {
  let dir;
  try {
    dir = await sealedFixture();

    // Delete ONE claimed file. The other claim (src/feature.js) remains, so
    // the all-claims-missing precondition heuristic (§5.6 -> exit 2) must NOT
    // trigger: this is a genuine failure, exit 1.
    await rm(path.join(dir, 'src', 'util.js'));

    const res = await runCli(['verify', '--json'], { cwd: dir });
    expectExit(res, 1, 'verify with one deleted claimed file');
    const json = parseJsonOut(res);
    assert.equal(json.ok, false);

    const claim = resultById(json, 'util-hash');
    assert.ok(claim, 'util-hash result present');
    assert.equal(
      claim.status,
      'missing',
      `deleted file must classify as "missing", got "${claim.status}"`,
    );
    // The untouched marker claim must still pass — failures are per-claim.
    assert.equal(resultById(json, 'feature-marker')?.status, 'pass');
  } finally {
    await cleanup(dir);
  }
});
