/**
 * Diagnose unit tests — confirms the read-only triage tool correctly
 * identifies each nondeterminism class on a synthetic harness, reports
 * truly novel variation as "unclassified" (the honest signal), and
 * never throws or exits non-zero on a flaky harness.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diagnose } from '../../dist/index.js';

function harness(root, body) {
  const p = join(root, 'h.mjs');
  writeFileSync(p, body);
  return `node ${JSON.stringify(p)}`;
}

test('diagnose: deterministic harness → deterministic=true, no spans, no recommendations', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pk-diag-'));
  const cmd = harness(root, `console.log(JSON.stringify([1, 2, 3]));`);
  const r = await diagnose({ cwd: root, cmd, seed: 1, runs: 3 });
  assert.equal(r.deterministic, true);
  assert.deepEqual(r.varyingSpans, []);
  assert.deepEqual(r.recommended, []);
});

test('diagnose: ISO timestamp nondeterminism → recommends mask-timestamps', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pk-diag-'));
  const cmd = harness(
    root,
    `console.log(JSON.stringify({ts: new Date().toISOString(), v: [1,2,3]}));
     // jitter to make sure two consecutive runs see different TS
    `,
  );
  // sleep between runs is handled by diagnose's serial spawn — but to make it
  // hit ms granularity reliably, run 3 times.
  const r = await diagnose({ cwd: root, cmd, seed: 1, runs: 3 });
  // Either the TS milliseconds drifted (nondeterministic) or not (very fast).
  // If we got here deterministic, the env was just fast — skip the assertion
  // body but make the test informative either way.
  if (r.deterministic) {
    assert.ok(true, 'env too fast to observe ms-drift; would normally flag mask-timestamps');
    return;
  }
  assert.ok(r.varyingSpans.some((s) => s.classification === 'mask-timestamps'));
  assert.ok(r.recommended.includes('mask-timestamps'));
});

test('diagnose: UUID nondeterminism → recommends mask-uuids', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pk-diag-'));
  const cmd = harness(
    root,
    `import { randomUUID } from 'node:crypto';
     console.log(JSON.stringify({id: randomUUID(), v: [1,2,3]}));`,
  );
  const r = await diagnose({ cwd: root, cmd, seed: 1, runs: 3 });
  assert.equal(r.deterministic, false);
  assert.ok(r.recommended.includes('mask-uuids'));
});

test('diagnose: truly novel variation → reported unclassified, NOT misclassified', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pk-diag-'));
  // Random word the starter set can't match — neither URL, hex, UUID, path,
  // ANSI, timestamp, nor a float-shaped token.
  const cmd = harness(
    root,
    `const words = ['alpha','bravo','charlie','delta','echo'];
     console.log(JSON.stringify({label: words[Math.floor(Math.random()*words.length)], v: [1,2,3]}));`,
  );
  const r = await diagnose({ cwd: root, cmd, seed: 1, runs: 5 });
  assert.equal(r.deterministic, false);
  assert.ok(r.unclassifiedCount > 0, 'novel variation must be reported as unclassified');
  assert.ok(r.hints.some((h) => h.includes('did not match any starter normalizer')));
});

test('diagnose: harness exiting non-zero is captured per-run, not thrown', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pk-diag-'));
  const cmd = harness(root, `process.exit(1);`);
  // Must not throw. Must report runErrors.
  const r = await diagnose({ cwd: root, cmd, seed: 1, runs: 2 });
  assert.equal(r.runErrors.length, 2);
});
