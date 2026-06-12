// Integration test 10 — The stranger test (ADR-0001 §2 sub-claims C3/C5):
// from a CLEAN CLONE of a sealed repo, a fresh process running
// `proofkit verify --root <clone>` with NO prior state exits 0 in < 2 s
// (cold Node start included).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  SKIP,
  sealedFixture,
  git,
  runCli,
  parseJsonOut,
  cleanup,
  expectExit,
} from './helpers.mjs';

test('stranger: verify from a clean clone, fresh process, --root, exit 0 in < 2s', { skip: SKIP }, async () => {
  let origin;
  let work;
  try {
    // Seal AND COMMIT the proofs — a stranger only gets what is in git.
    origin = await sealedFixture({ commitProofs: true });

    // Clean clone into a second temp dir = the stranger's machine.
    work = await mkdtemp(path.join(tmpdir(), 'proofkit-it-stranger-'));
    const clone = path.join(work, 'clone');
    await git(work, 'clone', '-q', origin, clone);

    // Fresh process, cwd deliberately NOT the repo: --root must carry it.
    const t0 = performance.now();
    const res = await runCli(['verify', '--root', clone, '--json'], {
      cwd: work,
    });
    const elapsedMs = performance.now() - t0;

    expectExit(res, 0, 'stranger verify on clean clone');
    const json = parseJsonOut(res);
    assert.equal(json.ok, true, 'clean clone must verify ok');
    assert.ok(
      (json.results ?? []).length >= 2,
      'clone verification covers the sealed claims',
    );

    // C3 latency budget: < 2 s including cold Node start. Our fixture has
    // ~3 claims vs the benchmarked 100, so 2 s is a generous ceiling here —
    // failing it means something is pathologically slow, not borderline.
    assert.ok(
      elapsedMs < 2000,
      `stranger verify took ${elapsedMs.toFixed(0)}ms; budget is < 2000ms (ADR §2 C3)`,
    );
  } finally {
    await cleanup(work);
    await cleanup(origin);
  }
});

test('stranger: --manifest with explicit path works without cwd context', { skip: SKIP }, async () => {
  let origin;
  let work;
  try {
    origin = await sealedFixture({ commitProofs: true });
    work = await mkdtemp(path.join(tmpdir(), 'proofkit-it-stranger2-'));
    const clone = path.join(work, 'clone');
    await git(work, 'clone', '-q', origin, clone);

    const res = await runCli(
      [
        'verify',
        '--manifest',
        path.join(clone, 'proofs', 'manifest.json'),
        '--root',
        clone,
      ],
      { cwd: work },
    );
    expectExit(res, 0, 'verify --manifest <path> --root <path>');
  } finally {
    await cleanup(work);
    await cleanup(origin);
  }
});
