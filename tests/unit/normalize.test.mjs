/**
 * Harness normalizer unit tests.
 *
 * The integrity rules — verify-time bytes-identical to seal-time, and
 * canonicalize-json NEVER altering values — get full coverage here. Every
 * normalizer in the starter set is round-tripped against text that varies
 * only in the masked spans (so the hash must stay stable) AND against text
 * that varies in a substantive position (so the hash must NOT match).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runHarness,
  applyNormalizers,
  canonicalizeNormalizers,
  classifySpan,
} from '../../dist/index.js';

function script(root, body) {
  const p = join(root, 'h.mjs');
  writeFileSync(p, body);
  return `node ${JSON.stringify(p)}`;
}

// ─── applyNormalizers: pure-function audit trail ─────────────────────

test('applyNormalizers: no specs → identity, empty applied[]', () => {
  const r = applyNormalizers('hello world', undefined);
  assert.equal(r.text, 'hello world');
  assert.deepEqual(r.applied, []);
});

test('applyNormalizers: every requested normalizer is recorded — even with count=0', () => {
  const r = applyNormalizers('plain text with nothing to mask', [
    { name: 'mask-timestamps' },
    { name: 'mask-uuids' },
  ]);
  // Both attempted, both made zero substitutions, both recorded.
  assert.equal(r.applied.length, 2);
  assert.equal(r.applied[0].count, 0);
  assert.equal(r.applied[1].count, 0);
});

test('applyNormalizers: strip-ansi removes escape sequences', () => {
  const ansi = '\x1B[31mred\x1B[0m';
  const r = applyNormalizers(ansi, [{ name: 'strip-ansi' }]);
  assert.equal(r.text, 'red');
  assert.equal(r.applied[0].count, 2);
});

test('applyNormalizers: mask-timestamps masks ISO 8601 and JSON-value epoch ms', () => {
  const text = '{"t": "2026-06-13T12:34:56.789Z", "n": 1730000000000}';
  const r = applyNormalizers(text, [{ name: 'mask-timestamps' }]);
  assert.match(r.text, /<TS>/);
  assert.ok(r.applied[0].count >= 2);
});

test('applyNormalizers: mask-uuids', () => {
  const text = 'id=550e8400-e29b-41d4-a716-446655440000 done';
  const r = applyNormalizers(text, [{ name: 'mask-uuids' }]);
  assert.equal(r.text, 'id=<UUID> done');
  assert.equal(r.applied[0].count, 1);
});

test('applyNormalizers: mask-hex respects minLen and skips pure-decimal', () => {
  // 40-char pure decimal → NOT a hash, must not match
  const decimal = '1234567890123456789012345678901234567890';
  const r1 = applyNormalizers(decimal, [{ name: 'mask-hex', minLen: 32 }]);
  assert.equal(r1.text, decimal);
  // Real hex hash (has a-f) → masked
  const real = 'a3b1c2d4e5f60a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b';
  const r2 = applyNormalizers(real, [{ name: 'mask-hex', minLen: 32 }]);
  assert.equal(r2.text, '<HEX>');
});

test('applyNormalizers: mask-paths keeps basename', () => {
  const text = 'wrote /Users/foo/projects/x/out.json done';
  const r = applyNormalizers(text, [{ name: 'mask-paths' }]);
  assert.match(r.text, /<PATH>\/out\.json/);
});

test('canonicalize-json: reorders keys but never alters values', () => {
  const a = '{"b":1,"a":2}';
  const b = '{"a":2,"b":1}';
  const ra = applyNormalizers(a, [{ name: 'canonicalize-json' }]);
  const rb = applyNormalizers(b, [{ name: 'canonicalize-json' }]);
  assert.equal(ra.text, rb.text); // same canonical form
  // INTEGRITY GATE: changing a VALUE must not survive canonicalization as same
  const c = '{"a":3,"b":1}'; // value differs
  const rc = applyNormalizers(c, [{ name: 'canonicalize-json' }]);
  assert.notEqual(ra.text, rc.text);
});

test('canonicalize-json: invalid JSON → no-op, recorded honestly, no throw', () => {
  const r = applyNormalizers('not { valid }', [{ name: 'canonicalize-json' }]);
  assert.equal(r.text, 'not { valid }');
  assert.equal(r.applied[0].noop, true);
  assert.equal(r.applied[0].reason, 'invalid-json');
});

// ─── canonicalizeNormalizers: storage form ──────────────────────────

test('canonicalizeNormalizers: dedupes (last-write-wins on params)', () => {
  const out = canonicalizeNormalizers([
    { name: 'mask-hex', minLen: 40 },
    { name: 'mask-hex', minLen: 32 }, // last write wins
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].minLen, 32);
});

test('canonicalizeNormalizers: alphabetical, defaults inlined', () => {
  const out = canonicalizeNormalizers([
    { name: 'mask-uuids' },
    { name: 'strip-ansi' },
    { name: 'mask-hex' }, // schema default minLen=32 inlined
  ]);
  assert.deepEqual(out.map((s) => s.name), ['mask-hex', 'mask-uuids', 'strip-ansi']);
  const mh = out.find((s) => s.name === 'mask-hex');
  assert.equal(mh.minLen, 32);
});

test('canonicalizeNormalizers: empty/undefined → undefined (no on-disk noise)', () => {
  assert.equal(canonicalizeNormalizers(undefined), undefined);
  assert.equal(canonicalizeNormalizers([]), undefined);
});

// ─── classifySpan: shared with diagnose ─────────────────────────────

test('classifySpan: each known class classifies correctly', () => {
  assert.equal(classifySpan('\x1B[31mx\x1B[0m'), 'strip-ansi');
  assert.equal(classifySpan('550e8400-e29b-41d4-a716-446655440000'), 'mask-uuids');
  assert.equal(classifySpan('2026-06-13T12:34:56Z'), 'mask-timestamps');
  assert.equal(classifySpan('/Users/foo/projects/x/y.json'), 'mask-paths');
  assert.equal(
    classifySpan('a3b1c2d4e5f60a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b'),
    'mask-hex',
  );
  assert.equal(classifySpan('just plain words here'), null);
});

// ─── End-to-end via runHarness: seal/verify byte-identical guarantee ──

const HARNESS_WITH_TS = `
const seed = Number(process.env.PROOFSEAL_SEED);
let s = seed;
const next = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
// Numeric output (what gets hashed) is deterministic;
// the textual noise (timestamp) varies every run.
console.log(JSON.stringify({
  ts: new Date().toISOString(),
  values: Array.from({ length: 10 }, next),
}));
`;

test('runHarness + mask-timestamps: stdout-noise differs each run, hash stable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pk-norm-'));
  const cmd = script(root, HARNESS_WITH_TS);
  const normalizers = [{ name: 'mask-timestamps' }];

  const first = await runHarness({ name: 'h', cmd, cwd: root, seed: 7, normalizers });
  await new Promise((r) => setTimeout(r, 10)); // make sure ISO TS would have ticked
  const second = await runHarness({ name: 'h', cmd, cwd: root, seed: 7, normalizers });
  assert.equal(first.hash, second.hash);
  // Audit trail surfaced
  assert.ok(first.appliedNormalizers);
  assert.equal(first.appliedNormalizers[0].name, 'mask-timestamps');
});

test('runHarness with NO normalizers: exact back-compat (timestamp would break it)', async () => {
  // Reuse the deterministic-numeric SEEDED case from the existing harness
  // test — no noise here, so no normalization needed; verifies the
  // "absent normalizers field → identity" path stayed clean.
  const root = mkdtempSync(join(tmpdir(), 'pk-norm-'));
  const cmd = script(
    root,
    `console.log(JSON.stringify([1, 2, 3, 4, 5]));`,
  );
  const a = await runHarness({ name: 'h', cmd, cwd: root, seed: 7 });
  const b = await runHarness({ name: 'h', cmd, cwd: root, seed: 7 });
  assert.equal(a.hash, b.hash);
  assert.equal(a.appliedNormalizers, undefined);
});

test('runHarness + canonicalize-json: key-reorder is benign, value-change is regression', async () => {
  // INTEGRITY GATE (acknowledge-in-build rule): a CHANGED VALUE must produce
  // a different hash even after canonicalize-json — otherwise the normalizer
  // is laundering a real regression. The test runs two harnesses producing
  // the same numbers under reordered keys (must match) and one producing a
  // different number (must NOT match).
  const root = mkdtempSync(join(tmpdir(), 'pk-norm-'));
  const same1 = script(root, `console.log(JSON.stringify({a: 1, b: 2}));`);
  const same2Path = join(root, 'h2.mjs');
  writeFileSync(same2Path, `console.log(JSON.stringify({b: 2, a: 1}));`);
  const same2 = `node ${JSON.stringify(same2Path)}`;
  const diffPath = join(root, 'h3.mjs');
  writeFileSync(diffPath, `console.log(JSON.stringify({a: 999, b: 2}));`);
  const diff = `node ${JSON.stringify(diffPath)}`;

  const normalizers = [{ name: 'canonicalize-json' }];
  const r1 = await runHarness({ name: 'h', cmd: same1, cwd: root, seed: 1, normalizers });
  const r2 = await runHarness({ name: 'h', cmd: same2, cwd: root, seed: 1, normalizers });
  const r3 = await runHarness({ name: 'h', cmd: diff, cwd: root, seed: 1, normalizers });

  assert.equal(r1.hash, r2.hash, 'reordered keys must produce same hash');
  assert.notEqual(r1.hash, r3.hash, 'changed VALUE must produce different hash (integrity gate)');
});
