// Integration test 6 — History + bisection (ADR-0001 §5.5):
// seal twice with a change in between -> history shows 2 snapshots;
// introduce a regression -> history --bisect localizes the commit range.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import {
  SKIP,
  MARKER,
  sealedFixture,
  runCli,
  commitAll,
  headSha,
  readHistoryLines,
  cleanup,
  expectExit,
} from './helpers.mjs';

test('history: two seals -> two snapshots, queryable per claim', { skip: SKIP }, async () => {
  let dir;
  try {
    dir = await sealedFixture(); // seal #1
    const commit1 = await headSha(dir);

    // Change a claimed file (marker intact), commit, seal again.
    await appendFile(
      path.join(dir, 'src', 'feature.js'),
      '\n// v2 tweak, marker preserved\n',
      'utf8',
    );
    const commit2 = await commitAll(dir, 'tweak feature (marker intact)');
    expectExit(await runCli(['seal'], { cwd: dir }), 0, 'seal #2');

    // Contracted artifact: append-only JSONL, one line per seal (§5.5).
    const lines = await readHistoryLines(dir);
    assert.equal(lines.length, 2, 'history.jsonl must have exactly 2 snapshots');
    assert.equal(lines[0].commit, commit1, 'snapshot 1 bound to commit 1');
    assert.equal(lines[1].commit, commit2, 'snapshot 2 bound to commit 2');
    for (const line of lines) {
      assert.ok(line.manifestHash, 'snapshot records manifestHash');
      assert.ok(line.summary, 'snapshot records summary');
      assert.ok(line.claims, 'snapshot records per-claim states');
    }
    // Hash of the edited claim changed across snapshots; untouched one did not.
    assert.notEqual(
      lines[0].claims['feature-marker']?.sha256,
      lines[1].claims['feature-marker']?.sha256,
      'edited claim sha256 must differ between snapshots',
    );
    assert.equal(
      lines[0].claims['util-hash']?.sha256,
      lines[1].claims['util-hash']?.sha256,
      'untouched claim sha256 must be stable between snapshots',
    );

    // CLI endpoint view of the same timeline.
    const hist = expectExit(await runCli(['history'], { cwd: dir }), 0, 'history');
    assert.match(
      hist.stdout,
      /2/,
      'history output must reflect 2 snapshots',
    );
    expectExit(
      await runCli(['history', '--id', 'feature-marker'], { cwd: dir }),
      0,
      'history --id',
    );
    expectExit(await runCli(['history', '--diff'], { cwd: dir }), 0, 'history --diff');
  } finally {
    await cleanup(dir);
  }
});

test('bisect: regression between seals -> history --bisect localizes the commit range', { skip: SKIP }, async () => {
  let dir;
  try {
    dir = await sealedFixture(); // seal #1 (all pass)

    // Benign change + seal #2 — still passing. This is the "last pass".
    await appendFile(
      path.join(dir, 'src', 'util.js'),
      'export const util2 = 2;\n',
      'utf8',
    );
    const lastPassCommit = await commitAll(dir, 'benign change');
    expectExit(await runCli(['seal'], { cwd: dir }), 0, 'seal #2 (last pass)');

    // Introduce the regression: remove the marker, commit, seal #3.
    const file = path.join(dir, 'src', 'feature.js');
    await writeFile(
      file,
      (await readFile(file, 'utf8')).replaceAll(MARKER, ''),
      'utf8',
    );
    const regressingCommit = await commitAll(dir, 'refactor that drops the fix');
    // Seal must record the now-unverifiable claim. ADR §4.1: seal exits
    // 1 on unverifiable claim — but it must STILL append the failing
    // snapshot, otherwise bisection has nothing to localize.
    const seal3 = await runCli(['seal'], { cwd: dir });
    assert.ok(
      seal3.code === 0 || seal3.code === 1,
      `seal over a regressed claim must exit 0 or 1, got ${seal3.code}\n${seal3.stderr}`,
    );
    const lines = await readHistoryLines(dir);
    assert.equal(
      lines.length,
      3,
      'seal must append a history snapshot even when a claim regressed',
    );

    // The endpoint under test: bisection over history.
    const bisect = expectExit(
      await runCli(['history', '--bisect'], { cwd: dir }),
      0,
      'history --bisect',
    );
    assert.match(
      bisect.stdout,
      /feature-marker/,
      'bisect output must name the regressed claim',
    );
    const mentionsRange =
      bisect.stdout.includes(lastPassCommit) ||
      bisect.stdout.includes(regressingCommit) ||
      bisect.stdout.includes(lastPassCommit.slice(0, 7)) ||
      bisect.stdout.includes(regressingCommit.slice(0, 7));
    assert.ok(
      mentionsRange,
      `bisect must localize the regression to the (${lastPassCommit.slice(0, 7)}..${regressingCommit.slice(0, 7)}] range; got:\n${bisect.stdout}`,
    );
    // It must NOT finger the still-passing claim.
    assert.ok(
      !/util-hash.*regress/i.test(bisect.stdout),
      'bisect must not implicate the passing claim',
    );
  } finally {
    await cleanup(dir);
  }
});

// ── History-semantics hardening (premortem: merge interleaving, rewritten
//    history, seal-frequency granularity) ────────────────────────────────

/** Build a minimal v1 history entry for synthetic-history tests. */
function entry({ commit, issuedAt, verified, branch = 'main' }) {
  return {
    v: 1,
    commit,
    issuedAt,
    branch,
    manifestHash: 'f'.repeat(64),
    summary: { totalClaims: 1, verified: verified ? 1 : 0, missing: 0 },
    claims: { 'feature-marker': { sha256: 'a'.repeat(64), verified } },
  };
}

async function writeHistory(dir, entries) {
  await writeFile(
    path.join(dir, 'proofs', 'history.jsonl'),
    entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
    'utf8',
  );
}

test('bisect: out-of-order issuedAt lines (union-merge interleaving) resolve by timestamp, not file order', { skip: SKIP }, async () => {
  let dir;
  try {
    dir = await sealedFixture();
    const sha1 = await headSha(dir);
    await appendFile(path.join(dir, 'src', 'util.js'), '// c2\n', 'utf8');
    const sha2 = await commitAll(dir, 'second commit');
    await appendFile(path.join(dir, 'src', 'util.js'), '// c3\n', 'utf8');
    const sha3 = await commitAll(dir, 'third commit');

    // File order: regressed(T3), pass(T1), pass(T2) — as a union merge could
    // interleave them. File-order "latest" is a PASS; issuedAt-order latest
    // is the REGRESSION. Bisect must follow issuedAt.
    await writeHistory(dir, [
      entry({ commit: sha3, issuedAt: '2026-01-03T00:00:00.000Z', verified: false }),
      entry({ commit: sha1, issuedAt: '2026-01-01T00:00:00.000Z', verified: true }),
      entry({ commit: sha2, issuedAt: '2026-01-02T00:00:00.000Z', verified: true }),
    ]);

    const bisect = expectExit(
      await runCli(['history', '--bisect'], { cwd: dir }),
      0,
      'history --bisect (shuffled file order)',
    );
    assert.match(
      bisect.stdout,
      /feature-marker/,
      `bisect must report the regression even though the last FILE line is a pass; got:\n${bisect.stdout}`,
    );
    assert.ok(
      bisect.stdout.includes(sha2.slice(0, 12)),
      `last pass must be the max-issuedAt passing entry (${sha2.slice(0, 12)}), not a file-position artifact; got:\n${bisect.stdout}`,
    );
    assert.ok(
      bisect.stdout.includes(sha3.slice(0, 12)),
      `regression must be localized at the max-issuedAt entry (${sha3.slice(0, 12)}); got:\n${bisect.stdout}`,
    );
    assert.ok(
      !bisect.stdout.includes('unreachable'),
      `real commits must not be tagged unreachable; got:\n${bisect.stdout}`,
    );
  } finally {
    await cleanup(dir);
  }
});

test('bisect: SHA that git cannot resolve (squash/rebase/force-push) is tagged unreachable', { skip: SKIP }, async () => {
  let dir;
  try {
    dir = await sealedFixture();
    const realSha = await headSha(dir);
    const fakeSha = 'deadbeef'.repeat(5); // 40 hex chars git has never seen

    await writeHistory(dir, [
      entry({ commit: realSha, issuedAt: '2026-01-01T00:00:00.000Z', verified: true }),
      entry({ commit: fakeSha, issuedAt: '2026-01-02T00:00:00.000Z', verified: false }),
    ]);

    const bisect = expectExit(
      await runCli(['history', '--bisect'], { cwd: dir }),
      0,
      'history --bisect (orphaned sha)',
    );
    // The SHA is still printed (it is recorded evidence) but tagged.
    assert.ok(
      bisect.stdout.includes(fakeSha.slice(0, 12)),
      `orphaned SHA must still be printed; got:\n${bisect.stdout}`,
    );
    assert.match(
      bisect.stdout,
      /\(unreachable — rewritten history\?\)/,
      `orphaned SHA must carry the unreachable tag; got:\n${bisect.stdout}`,
    );
    // No range width is computable when one boundary is unreachable.
    assert.ok(
      !/range spans/.test(bisect.stdout),
      `range width must be omitted when a boundary SHA is unreachable; got:\n${bisect.stdout}`,
    );
  } finally {
    await cleanup(dir);
  }
});

test('bisect: reachable range reports commit count (seal-frequency granularity)', { skip: SKIP }, async () => {
  let dir;
  try {
    dir = await sealedFixture(); // seal #1 (pass)

    // Last pass: benign change, commit, seal #2.
    await appendFile(path.join(dir, 'src', 'util.js'), 'export const util3 = 3;\n', 'utf8');
    await commitAll(dir, 'benign change');
    expectExit(await runCli(['seal'], { cwd: dir }), 0, 'seal #2 (last pass)');

    // Two unsealed commits widen the candidate range...
    await appendFile(path.join(dir, 'src', 'util.js'), '// noise 1\n', 'utf8');
    await commitAll(dir, 'unsealed commit 1');
    await appendFile(path.join(dir, 'src', 'util.js'), '// noise 2\n', 'utf8');
    await commitAll(dir, 'unsealed commit 2');

    // ...then the regression lands and seal #3 records it.
    const file = path.join(dir, 'src', 'feature.js');
    await writeFile(file, (await readFile(file, 'utf8')).replaceAll(MARKER, ''), 'utf8');
    await commitAll(dir, 'drops the fix');
    const seal3 = await runCli(['seal'], { cwd: dir });
    assert.ok(seal3.code === 0 || seal3.code === 1, `seal #3 exit 0|1, got ${seal3.code}\n${seal3.stderr}`);

    const bisect = expectExit(await runCli(['history', '--bisect'], { cwd: dir }), 0, 'history --bisect');
    // lastPass..regressedAt = {noise1, noise2, drops-the-fix} = 3 commits.
    assert.match(
      bisect.stdout,
      /range spans 3 commits/,
      `bisect must report how many commits the seal-snapshot range spans; got:\n${bisect.stdout}`,
    );
    assert.match(
      bisect.stdout,
      /seal more often/,
      `multi-commit ranges must carry the seal-frequency advice; got:\n${bisect.stdout}`,
    );
    assert.ok(
      !bisect.stdout.includes('unreachable'),
      `live commits must not be tagged unreachable; got:\n${bisect.stdout}`,
    );
  } finally {
    await cleanup(dir);
  }
});
