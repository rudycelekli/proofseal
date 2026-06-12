import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize, sha256Hex } from '../../dist/index.js';

test('canonicalize: sorted keys, no whitespace', () => {
  assert.equal(canonicalize({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(canonicalize({ z: { y: 2, x: 1 }, a: [3, 1] }), '{"a":[3,1],"z":{"x":1,"y":2}}');
});

test('canonicalize: drops undefined object values, undefined → null elsewhere', () => {
  assert.equal(canonicalize({ a: 1, gone: undefined }), '{"a":1}');
  assert.equal(canonicalize([1, undefined, 2]), '[1,null,2]');
  assert.equal(canonicalize(undefined), 'null');
  assert.equal(canonicalize(null), 'null');
});

test('canonicalize: insertion order does not affect bytes (determinism)', () => {
  const a = { schema: 'proofkit/v1', gitCommit: 'x', claims: [{ id: 'c1', type: 'marker' }] };
  const b = { claims: [{ type: 'marker', id: 'c1' }], gitCommit: 'x', schema: 'proofkit/v1' };
  assert.equal(canonicalize(a), canonicalize(b));
  assert.equal(sha256Hex(canonicalize(a)), sha256Hex(canonicalize(b)));
});

test('canonicalize: primitives', () => {
  assert.equal(canonicalize('hi'), '"hi"');
  assert.equal(canonicalize(1.5), '1.5');
  assert.equal(canonicalize(true), 'true');
});
