// Integration tests — CI footgun pack + Windows insurance (ADR-0002):
//  1. seal prints the "now commit these files" checklist (and --json mirrors it);
//  2. missing reference vector at verify -> NAMED precondition, exit 2;
//  3. backslash claim paths are normalized to forward slashes at seal+verify;
//  4. CRLF rewrite of a sealed file -> regressed WITH the autocrlf detail;
//  5. per-claim relaxation: only a dist/ claim missing -> exit 2, not 1.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  SKIP,
  FIXTURES,
  makeTempRepo,
  runCli,
  claimAdd,
  commitAll,
  parseJsonOut,
  readManifest,
  resultById,
  cleanup,
  expectExit,
} from './helpers.mjs';

test('seal prints the commit checklist with every file it wrote', { skip: SKIP }, async () => {
  let dir;
  try {
    const script = await readFile(path.join(FIXTURES, 'harness-det.mjs'), 'utf8');
    dir = await makeTempRepo({ 'scripts/det.mjs': script });
    expectExit(await runCli(['init'], { cwd: dir }), 0, 'init');
    expectExit(
      await claimAdd(dir, {
        id: 'det-output',
        type: 'harness',
        name: 'det',
        cmd: 'node scripts/det.mjs',
        seed: 42,
        quantizeDecimals: 6,
      }),
      0,
      'claim add harness',
    );
    await commitAll(dir, 'add claims');

    const res = expectExit(await runCli(['seal'], { cwd: dir }), 0, 'seal');
    assert.match(res.stdout, /Seal complete\. Now commit these files:/);
    assert.match(res.stdout, /proofs\/manifest\.json/);
    assert.match(res.stdout, /proofs\/history\.jsonl/);
    // First seal mints a harness expectation: reference vector + rewritten config.
    assert.match(res.stdout, /proofs\/det\.reference\.json/);
    assert.match(res.stdout, /proofseal\.json/);

    // --json mirrors the same list machine-readably.
    const jres = expectExit(await runCli(['seal', '--json'], { cwd: dir }), 0, 'seal --json');
    const j = parseJsonOut(jres);
    assert.ok(Array.isArray(j.filesWritten), 'seal --json must include filesWritten');
    assert.ok(j.filesWritten.includes('proofs/manifest.json'));
    assert.ok(j.filesWritten.includes('proofs/history.jsonl'));
  } finally {
    await cleanup(dir);
  }
});

test('missing reference vector at verify -> named precondition, exit 2', { skip: SKIP }, async () => {
  let dir;
  try {
    const script = await readFile(path.join(FIXTURES, 'harness-det.mjs'), 'utf8');
    dir = await makeTempRepo({ 'scripts/det.mjs': script });
    expectExit(await runCli(['init'], { cwd: dir }), 0, 'init');
    expectExit(
      await claimAdd(dir, {
        id: 'det-output',
        type: 'harness',
        name: 'det',
        cmd: 'node scripts/det.mjs',
        seed: 42,
        quantizeDecimals: 6,
      }),
      0,
      'claim add harness',
    );
    await commitAll(dir, 'add claims');
    expectExit(await runCli(['seal'], { cwd: dir }), 0, 'seal');

    // Hash mismatch (mutated output) + reference vector never "committed".
    const file = path.join(dir, 'scripts', 'det.mjs');
    const src = await readFile(file, 'utf8');
    await writeFile(
      file,
      src.replace('out.map((v) => v.toFixed(9))', 'out.map((v) => (v + 0.5).toFixed(9))'),
      'utf8',
    );
    await rm(path.join(dir, 'proofs', 'det.reference.json'), { force: true });

    const res = await runCli(['verify'], { cwd: dir });
    expectExit(res, 2, 'verify without the committed reference vector');
    assert.match(res.stderr, /reference-vector-not-found/);
    assert.match(
      res.stderr,
      /did you commit the seal outputs\?/,
      'hint must point at uncommitted seal outputs',
    );
  } finally {
    await cleanup(dir);
  }
});

test('backslash claim path is sealed and verified as forward slashes', { skip: SKIP }, async () => {
  let dir;
  try {
    dir = await makeTempRepo({ 'sub/file.txt': 'hello sealed world\n' });
    expectExit(await runCli(['init'], { cwd: dir }), 0, 'init');
    // Simulate a claim authored on Windows with a backslash path.
    expectExit(
      await claimAdd(dir, { id: 'win-path', type: 'file-hash', file: 'sub\\file.txt' }),
      0,
      'claim add with backslash path',
    );
    await commitAll(dir, 'add claims');
    expectExit(await runCli(['seal'], { cwd: dir }), 0, 'seal');

    const doc = await readManifest(dir);
    const sealed = doc.manifest.claims.find((c) => c.id === 'win-path');
    assert.equal(sealed.file, 'sub/file.txt', 'manifest must store forward slashes');

    const res = await runCli(['verify', '--json'], { cwd: dir });
    expectExit(res, 0, 'verify backslash-authored claim on POSIX');
    assert.equal(resultById(parseJsonOut(res), 'win-path')?.status, 'pass');
  } finally {
    await cleanup(dir);
  }
});

test('CRLF rewrite stays regressed but names git autocrlf in the detail', { skip: SKIP }, async () => {
  let dir;
  try {
    dir = await makeTempRepo({ 'src/lines.js': 'const a = 1;\nconst b = 2;\n' });
    expectExit(await runCli(['init'], { cwd: dir }), 0, 'init');
    expectExit(
      await claimAdd(dir, { id: 'lines-hash', type: 'file-hash', file: 'src/lines.js' }),
      0,
      'claim add file-hash',
    );
    await commitAll(dir, 'add claims');
    expectExit(await runCli(['seal'], { cwd: dir }), 0, 'seal');

    // Simulate git autocrlf: same content, CRLF line endings.
    await writeFile(path.join(dir, 'src/lines.js'), 'const a = 1;\r\nconst b = 2;\r\n', 'utf8');

    const res = await runCli(['verify', '--json'], { cwd: dir });
    expectExit(res, 1, 'CRLF rewrite is still a byte-level regression');
    const r = resultById(parseJsonOut(res), 'lines-hash');
    assert.equal(r?.status, 'regressed', 'classification stays regressed');
    assert.match(
      r?.detail ?? '',
      /line-ending normalization/,
      'detail must name the likely autocrlf cause',
    );
    assert.match(r?.detail ?? '', /\.gitattributes/);
  } finally {
    await cleanup(dir);
  }
});

test('per-claim relaxation: ONLY missing dist/ claims -> exit 2 even when others pass', { skip: SKIP }, async () => {
  let dir;
  try {
    dir = await makeTempRepo({
      'dist/index.js': 'export const built = true;\n',
      'src/keep.js': 'export const keep = 1;\n',
    });
    expectExit(await runCli(['init'], { cwd: dir }), 0, 'init');
    expectExit(
      await claimAdd(dir, { id: 'dist-index', type: 'file-hash', file: 'dist/index.js' }),
      0,
      'claim add dist-index',
    );
    expectExit(
      await claimAdd(dir, { id: 'keep-hash', type: 'file-hash', file: 'src/keep.js' }),
      0,
      'claim add keep-hash',
    );
    await commitAll(dir, 'mixed claims');
    expectExit(await runCli(['seal'], { cwd: dir }), 0, 'seal');

    // Source checkout without a build: ONLY the dist claim fails.
    await rm(path.join(dir, 'dist'), { recursive: true, force: true });
    await mkdir(path.join(dir, 'dist'), { recursive: true });
    await rm(path.join(dir, 'dist'), { recursive: true, force: true });

    const res = await runCli(['verify'], { cwd: dir });
    expectExit(res, 2, 'every failing claim is precondition-suspect (missing build output)');
    assert.match(res.stderr, /precondition/);
    assert.match(res.stderr, /build/i);
  } finally {
    await cleanup(dir);
  }
});
