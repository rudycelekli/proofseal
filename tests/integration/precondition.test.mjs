// Integration test 8 — Precondition exit code (ADR-0001 §5.6, D7,
// ruflo issue #1880): all claims missing AND manifest references dist/
// => source-only checkout heuristic => exit 2 (NOT 1) with a message
// telling the user to build. This is what stops scheduled CI from filing
// duplicate regression issues for "you just didn't run npm run build".
import test from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  SKIP,
  makeTempRepo,
  runCli,
  claimAdd,
  commitAll,
  readManifest,
  cleanup,
  expectExit,
} from './helpers.mjs';

test('precondition: all claims missing + manifest references dist/ -> exit 2, message mentions building', { skip: SKIP }, async () => {
  let dir;
  try {
    dir = await makeTempRepo({
      'dist/index.js': 'export const built = true;\n',
      'dist/util.js': 'export const builtUtil = true;\n',
      'src/index.ts': 'export const built = true;\n',
    });
    expectExit(await runCli(['init'], { cwd: dir }), 0, 'init');
    expectExit(
      await claimAdd(dir, {
        id: 'dist-index',
        type: 'file-hash',
        file: 'dist/index.js',
        desc: 'build output integrity',
      }),
      0,
      'claim add dist-index',
    );
    expectExit(
      await claimAdd(dir, {
        id: 'dist-util',
        type: 'file-hash',
        file: 'dist/util.js',
        desc: 'build output integrity',
      }),
      0,
      'claim add dist-util',
    );
    await commitAll(dir, 'claims over dist');
    expectExit(await runCli(['seal'], { cwd: dir }), 0, 'seal');

    // Simulate the source-only checkout: every claimed file is gone.
    // (init's sample claim may target a non-dist file; delete every claimed
    // file from the sealed manifest so "ALL claims missing" really holds.)
    const doc = await readManifest(dir);
    for (const claim of doc.manifest.claims ?? []) {
      if (claim.file) {
        await rm(path.join(dir, claim.file), { force: true });
      }
    }
    await rm(path.join(dir, 'dist'), { recursive: true, force: true });

    const res = await runCli(['verify', '--json'], { cwd: dir });
    // The load-bearing assertion: 2, not 1.
    assert.equal(
      res.code,
      2,
      `source-only checkout must be a PRECONDITION (exit 2), not a regression (exit 1).\n` +
        `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`,
    );
    assert.match(
      res.stdout + res.stderr,
      /build/i,
      'precondition message must tell the user to build (e.g. "run npm ci && npm run build")',
    );
  } finally {
    await cleanup(dir);
  }
});

test('precondition contrast: a non-suspect failure alongside missing dist -> still exit 1', { skip: SKIP }, async () => {
  // Guards against an over-eager heuristic that turns every failure into
  // exit 2 and hides real regressions from CI. A missing dist/ claim alone
  // is now (correctly) precondition-suspect; the moment a NON-suspect
  // failure exists (a regressed source file), verify must report exit 1.
  let dir;
  try {
    dir = await makeTempRepo({
      'dist/index.js': 'export const built = true;\n',
      'src/keep.js': 'export const keep = 1;\n',
    });
    expectExit(await runCli(['init'], { cwd: dir }), 0, 'init');
    expectExit(
      await claimAdd(dir, {
        id: 'dist-index',
        type: 'file-hash',
        file: 'dist/index.js',
        desc: 'build output integrity',
      }),
      0,
      'claim add dist-index',
    );
    expectExit(
      await claimAdd(dir, {
        id: 'keep-hash',
        type: 'file-hash',
        file: 'src/keep.js',
        desc: 'source file integrity',
      }),
      0,
      'claim add keep-hash',
    );
    await commitAll(dir, 'mixed claims');
    expectExit(await runCli(['seal'], { cwd: dir }), 0, 'seal');

    await rm(path.join(dir, 'dist'), { recursive: true, force: true });
    // A real regression on a source file: not missing, not build output.
    await writeFile(path.join(dir, 'src/keep.js'), 'export const keep = 2;\n');

    const res = await runCli(['verify'], { cwd: dir });
    expectExit(
      res,
      1,
      'a non-suspect failing claim (regressed source file) must keep exit 1',
    );
  } finally {
    await cleanup(dir);
  }
});
