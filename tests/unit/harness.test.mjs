import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHarness, parseNumericOutput, hashQuantized } from '../../dist/index.js';

function harnessScript(root, body) {
  const p = join(root, 'h.mjs');
  writeFileSync(p, body);
  return `node ${JSON.stringify(p)}`;
}

const SEEDED = `
const seed = Number(process.env.PROOFSEAL_SEED);
let s = seed;
const next = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
console.log(JSON.stringify(Array.from({ length: 20 }, next)));
`;

test('parseNumericOutput: JSON array, nested, object with exclude, plain numbers', () => {
  assert.deepEqual(parseNumericOutput('[1, 2.5, 3]'), [1, 2.5, 3]);
  assert.deepEqual(parseNumericOutput('[[1, 2], [3]]'), [1, 2, 3]);
  // object: keys sorted, excluded keys skipped (pitfall 6: un-hashable features)
  assert.deepEqual(parseNumericOutput('{"b": [3, 4], "a": [1, 2], "doppler": [9]}', ['doppler']), [1, 2, 3, 4]);
  assert.deepEqual(parseNumericOutput('1.5 2.5\n3.5'), [1.5, 2.5, 3.5]);
  assert.deepEqual(parseNumericOutput(''), []);
});

test('runHarness: seeded run is deterministic; bit-exact hash → pass', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pk-harness-'));
  const cmd = harnessScript(root, SEEDED);

  const first = await runHarness({ name: 'h', cmd, cwd: root, seed: 7 });
  assert.equal(first.status, 'missing'); // no expectation committed yet
  assert.match(first.hash, /^[0-9a-f]{64}$/);
  assert.equal(first.hash, hashQuantized(first.values, 6));

  const again = await runHarness({ name: 'h', cmd, cwd: root, seed: 7, expectedSha256: first.hash });
  assert.equal(again.status, 'pass');
  assert.equal(again.hashMatch, true);

  // different seed → different output → regressed (no reference vector)
  const other = await runHarness({ name: 'h', cmd, cwd: root, seed: 8, expectedSha256: first.hash });
  assert.equal(other.status, 'regressed');
});

test('runHarness: dual verdict — hash mismatch but tolerance pass → drift', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pk-harness-'));
  const cmd = harnessScript(root, SEEDED);
  const baseline = await runHarness({ name: 'h', cmd, cwd: root, seed: 7 });

  // committed reference = real values nudged below tolerance; expected hash deliberately stale
  writeFileSync(join(root, 'ref.json'), JSON.stringify(baseline.values.map((v) => v + 1e-9)));
  const drifted = await runHarness({
    name: 'h', cmd, cwd: root, seed: 7,
    expectedSha256: 'f'.repeat(64),
    referenceVector: 'ref.json',
    tolerance: { rtol: 1e-4, atol: 1e-6 },
  });
  assert.equal(drifted.status, 'drift');
  assert.equal(drifted.hashMatch, false);
  assert.equal(drifted.toleranceMatch, true);

  // reference far outside tolerance → regressed, with forensics
  writeFileSync(join(root, 'ref.json'), JSON.stringify(baseline.values.map((v) => v + 1)));
  const regressed = await runHarness({
    name: 'h', cmd, cwd: root, seed: 7,
    expectedSha256: 'f'.repeat(64),
    referenceVector: 'ref.json',
  });
  assert.equal(regressed.status, 'regressed');
  assert.equal(regressed.forensics.ok, false);
  assert.ok(regressed.forensics.outOfTolerance > 0);
});

test('runHarness: command failure → error status, never throws', async () => {
  const result = await runHarness({ name: 'boom', cmd: 'node -e "process.exit(3)"' });
  assert.equal(result.status, 'error');
  assert.equal(result.exitCode, 3);
  assert.match(result.error, /exited with code 3/);
});
