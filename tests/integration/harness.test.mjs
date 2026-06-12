// Integration test 7 — Deterministic harness claims (ADR-0001 D9, §5.3):
// seeded execution via PROOFSEAL_SEED, 6-decimal quantization, hash compare.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  SKIP,
  FIXTURES,
  makeTempRepo,
  runCli,
  claimAdd,
  commitAll,
  parseJsonOut,
  resultById,
  cleanup,
  expectExit,
} from './helpers.mjs';

async function harnessRepo() {
  const script = await readFile(
    path.join(FIXTURES, 'harness-det.mjs'),
    'utf8',
  );
  const dir = await makeTempRepo({ 'scripts/det.mjs': script });
  expectExit(await runCli(['init'], { cwd: dir }), 0, 'init');
  expectExit(
    await claimAdd(dir, {
      id: 'det-output',
      type: 'harness',
      name: 'det',
      cmd: 'node scripts/det.mjs',
      seed: 42,
      quantizeDecimals: 6,
      desc: 'pipeline output is deterministic under PROOFSEAL_SEED',
    }),
    0,
    'claim add harness',
  );
  await commitAll(dir, 'add harness claim');
  expectExit(await runCli(['seal'], { cwd: dir }), 0, 'seal');
  return dir;
}

test('harness: seeded deterministic script passes harness run and verify', { skip: SKIP }, async () => {
  let dir;
  try {
    dir = await harnessRepo();

    // Run the harness endpoint twice — determinism means it passes twice.
    expectExit(
      await runCli(['harness', 'run', 'det'], { cwd: dir }),
      0,
      'harness run det (1st)',
    );
    expectExit(
      await runCli(['harness', 'run', 'det'], { cwd: dir }),
      0,
      'harness run det (repeat — determinism gate)',
    );

    const res = await runCli(['verify', '--json'], { cwd: dir });
    expectExit(res, 0, 'verify with passing harness claim');
    const json = parseJsonOut(res);
    assert.equal(resultById(json, 'det-output')?.status, 'pass');
  } finally {
    await cleanup(dir);
  }
});

test('harness: changed script output -> verify exit 1, claim regressed', { skip: SKIP }, async () => {
  let dir;
  try {
    dir = await harnessRepo();

    // Change the OUTPUT (not just the file): shift every value well past
    // quantizeDecimals=6 and any rtol/atol tolerance, so both gates of the
    // dual hash/tolerance verdict (D9) must fail.
    const file = path.join(dir, 'scripts', 'det.mjs');
    const src = await readFile(file, 'utf8');
    const mutated = src.replace(
      'out.map((v) => v.toFixed(9))',
      'out.map((v) => (v + 0.5).toFixed(9))',
    );
    assert.notEqual(mutated, src, 'fixture sanity: mutation applied');
    await writeFile(file, mutated, 'utf8');

    // Direct harness endpoint fails...
    const run = await runCli(['harness', 'run', 'det'], { cwd: dir });
    expectExit(run, 1, 'harness run det after output change');

    // ...and verify classifies the claim as regressed with exit 1 (§5.6:
    // "harness hash+tolerance both fail" -> regressed).
    const res = await runCli(['verify', '--json'], { cwd: dir });
    expectExit(res, 1, 'verify after harness output change');
    const json = parseJsonOut(res);
    assert.equal(json.ok, false);
    assert.equal(
      resultById(json, 'det-output')?.status,
      'regressed',
      'harness output change must classify as "regressed"',
    );
  } finally {
    await cleanup(dir);
  }
});

test('harness: --update regenerates the expectation, after which verify passes', { skip: SKIP }, async () => {
  let dir;
  try {
    dir = await harnessRepo();

    const file = path.join(dir, 'scripts', 'det.mjs');
    const src = await readFile(file, 'utf8');
    await writeFile(
      file,
      src.replace(
        'out.map((v) => v.toFixed(9))',
        'out.map((v) => (v + 0.5).toFixed(9))',
      ),
      'utf8',
    );

    // Reviewed-bump path: --update regenerates the committed expectation.
    expectExit(
      await runCli(['harness', 'run', 'det', '--update'], { cwd: dir }),
      0,
      'harness run det --update',
    );
    // Expectation changed -> reseal, then verify is green again.
    await commitAll(dir, 'reviewed harness expectation bump');
    expectExit(await runCli(['seal'], { cwd: dir }), 0, 'reseal after update');
    expectExit(await runCli(['verify'], { cwd: dir }), 0, 'verify after update');
  } finally {
    await cleanup(dir);
  }
});
