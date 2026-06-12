import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadHistory, appendHistory, fixTimeline, diffLatest, findRegressionIntroductions } from '../../dist/index.js';

const entryLine = (commit, claims) =>
  JSON.stringify({
    v: 1,
    commit,
    issuedAt: '2026-06-11T00:00:00.000Z',
    branch: 'main',
    manifestHash: 'f'.repeat(64),
    summary: { totalClaims: Object.keys(claims).length, verified: 0, missing: 0 },
    claims,
  });

test('loadHistory: tolerates blank lines and missing trailing newline (pitfall 9)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pk-jsonl-'));
  const p = join(dir, 'history.jsonl');
  const l1 = entryLine('a'.repeat(40), { c1: { sha256: '1', verified: true } });
  const l2 = entryLine('b'.repeat(40), { c1: { sha256: '2', verified: false } });
  writeFileSync(p, `${l1}\n\n\n${l2}`); // blank lines + no trailing newline
  const h = loadHistory(p);
  assert.equal(h.length, 2);
  assert.equal(h[0].commit, 'a'.repeat(40));
  assert.equal(h[1].claims.c1.verified, false);
});

test('loadHistory: missing file → empty; parse error reports 1-indexed line', () => {
  assert.deepEqual(loadHistory(join(tmpdir(), 'pk-does-not-exist.jsonl')), []);
  const dir = mkdtempSync(join(tmpdir(), 'pk-jsonl-'));
  const p = join(dir, 'history.jsonl');
  writeFileSync(p, entryLine('a'.repeat(40), {}) + '\n{not json\n');
  assert.throws(() => loadHistory(p), /line 2/);
});

test('appendHistory: exactly one \\n per line; round-trips through loadHistory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pk-jsonl-'));
  const p = join(dir, 'history.jsonl');
  const manifest = {
    schema: 'proofkit/v1',
    issuedAt: '2026-06-11T00:00:00.000Z',
    gitCommit: 'c'.repeat(40),
    branch: 'main',
    salt: 's',
    releases: {},
    summary: { totalClaims: 2, verified: 1, missing: 0 },
    claims: [
      { id: 'm1', type: 'marker', file: 'x.ts', marker: 'fix', sha256: 'ab', markerVerified: true },
      { id: 'h1', type: 'harness', harness: 'h1', cmd: 'node x', expectedSha256: 'cd' },
    ],
  };
  appendHistory(p, manifest, 'e'.repeat(64));
  appendHistory(p, manifest, 'e'.repeat(64));
  const raw = readFileSync(p, 'utf8');
  assert.equal(raw.split('\n').length, 3); // 2 lines + trailing newline
  assert.ok(raw.endsWith('\n') && !raw.endsWith('\n\n'));
  const h = loadHistory(p);
  assert.equal(h.length, 2);
  assert.deepEqual(h[0].claims.m1, { sha256: 'ab', verified: true });
  assert.deepEqual(h[0].claims.h1, { sha256: 'cd', verified: true });
});

test('history queries: timeline, diff, bisection (lib.mjs port)', () => {
  const mk = (commit, verified) => ({
    v: 1, commit, issuedAt: 't', branch: 'main', manifestHash: 'x',
    summary: { totalClaims: 1, verified: verified ? 1 : 0, missing: 0 },
    claims: { c1: { sha256: 'h', verified } },
  });
  const history = [mk('c1commit', true), mk('c2commit', true), mk('c3commit', false), mk('c4commit', false)];

  const tl = fixTimeline(history, 'c1');
  assert.deepEqual(tl.map((t) => t.status), ['pass', 'pass', 'regressed', 'regressed']);
  assert.deepEqual(fixTimeline(history, 'nope').map((t) => t.status), ['absent', 'absent', 'absent', 'absent']);

  const bisect = findRegressionIntroductions(history);
  assert.equal(bisect.length, 1);
  assert.equal(bisect[0].lastPassCommit, 'c2commit');
  assert.equal(bisect[0].regressedAtCommit, 'c3commit');

  const diff = diffLatest([mk('a', true), mk('b', false)]);
  assert.deepEqual(diff.newlyRegressed, ['c1']);
  assert.deepEqual(diffLatest([mk('a', false), mk('b', true)]).newlyPassing, ['c1']);
  assert.deepEqual(diffLatest([mk('only', true)]), { newlyRegressed: [], newlyPassing: [], added: [], removed: [] });
});
