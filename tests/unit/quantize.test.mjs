import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  roundHalfEven,
  quantizeValues,
  packLEFloat64,
  hashQuantized,
  allClose,
} from '../../dist/index.js';

test('roundHalfEven: golden vectors (banker\'s rounding, not Math.round)', () => {
  // ties go to the even neighbor — numpy semantics (pitfall 7)
  assert.equal(roundHalfEven(2.5, 0), 2);
  assert.equal(roundHalfEven(3.5, 0), 4);
  assert.equal(roundHalfEven(-2.5, 0), -2);
  assert.equal(roundHalfEven(-1.5, 0), -2);
  assert.equal(roundHalfEven(0.5, 0), 0);
  assert.equal(roundHalfEven(1.5, 0), 2);
  // 0.125 is exact in binary → true tie at 2 decimals
  assert.equal(roundHalfEven(0.125, 2), 0.12);
  assert.equal(roundHalfEven(-0.125, 2), -0.12);
  assert.equal(roundHalfEven(0.375, 2), 0.38);
  // non-ties round normally
  assert.equal(roundHalfEven(1.234567891, 6), 1.234568);
  assert.equal(roundHalfEven(-1.2344, 3), -1.234);
  // non-finite passes through
  assert.equal(roundHalfEven(Infinity, 6), Infinity);
  assert.ok(Number.isNaN(roundHalfEven(NaN, 6)));
});

test('packLEFloat64 matches struct.pack("<d")', () => {
  const buf = packLEFloat64([1.0]);
  // IEEE-754 LE for 1.0 = 00 00 00 00 00 00 f0 3f
  assert.equal(buf.toString('hex'), '000000000000f03f');
  assert.equal(packLEFloat64([1.0, 2.0]).length, 16);
});

test('hashQuantized: streamed hash equals one-shot quantize+pack+sha256', () => {
  const values = Array.from({ length: 10000 }, (_, i) => Math.sin(i) * 1000);
  const quantized = quantizeValues(values, 6);
  const expected = createHash('sha256').update(packLEFloat64(quantized)).digest('hex');
  assert.equal(hashQuantized(values, 6), expected);
});

test('hashQuantized: quantization collapses sub-decimal drift', () => {
  const a = [1.0000001, 2.0000002];
  const b = [1.0000002, 2.0000001];
  assert.equal(hashQuantized(a, 6), hashQuantized(b, 6));
  assert.notEqual(hashQuantized([1.1], 6), hashQuantized([1.2], 6));
});

test('allClose: numpy semantics + divergence forensics', () => {
  assert.equal(allClose([1.0, 2.0], [1.0, 2.0]).ok, true);
  assert.equal(allClose([1.00005, 2.0], [1.0, 2.0], 1e-4, 1e-6).ok, true);
  const r = allClose([1.1, 2.0, 5.0], [1.0, 2.0, 3.0], 1e-4, 1e-6);
  assert.equal(r.ok, false);
  assert.equal(r.outOfTolerance, 2);
  assert.equal(r.worst.index, 2);
  assert.equal(allClose([1.0], [1.0, 2.0]).lengthMatch, false);
});
