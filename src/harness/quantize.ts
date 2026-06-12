/**
 * Deterministic numeric hashing (RuView Trust Kill Switch port):
 * round-half-even quantization at N decimals → little-endian IEEE-754
 * float64 packing → streamed SHA-256. Plus the rtol/atol tolerance gate
 * with divergence forensics (issue #560 dual-gate verdict).
 */
import { createHash } from 'node:crypto';

export const DEFAULT_DECIMALS = 6;
export const DEFAULT_TOLERANCE = { rtol: 1e-4, atol: 1e-6 } as const;

/**
 * Round to N decimals with ties going to the even neighbor (banker's
 * rounding — numpy semantics, NOT JS Math.round half-up; pitfall 7).
 */
export function roundHalfEven(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return value;
  const factor = Math.pow(10, decimals);
  const scaled = value * factor;
  let rounded = Math.round(scaled); // half-toward-+Infinity
  // Math.round on an exact .5 tie always lands on floor(scaled)+1; if that
  // result is odd, the even neighbor is rounded-1 (works for both signs).
  if (scaled - Math.floor(scaled) === 0.5 && rounded % 2 !== 0) {
    rounded -= 1;
  }
  return rounded / factor;
}

/** Quantize every value (round-half-even at N decimals). */
export function quantizeValues(values: readonly number[], decimals: number): number[] {
  return values.map((v) => roundHalfEven(v, decimals));
}

/** Pack values as little-endian IEEE-754 float64 (struct.pack "<Nd"). */
export function packLEFloat64(values: readonly number[]): Buffer {
  const buf = Buffer.alloc(values.length * 8);
  for (let i = 0; i < values.length; i++) {
    buf.writeDoubleLE(values[i], i * 8);
  }
  return buf;
}

/**
 * The full quantize → pack-LE-f64 → SHA-256 pipeline.
 * Streams in chunks so large vectors never materialize one giant buffer.
 */
export function hashQuantized(values: readonly number[], decimals: number = DEFAULT_DECIMALS): string {
  const hasher = createHash('sha256');
  const CHUNK = 4096;
  for (let i = 0; i < values.length; i += CHUNK) {
    const slice = values.slice(i, i + CHUNK).map((v) => roundHalfEven(v, decimals));
    hasher.update(packLEFloat64(slice));
  }
  return hasher.digest('hex');
}

export interface AllCloseResult {
  ok: boolean;
  /** Lengths matched? */
  lengthMatch: boolean;
  /** Count of out-of-tolerance elements. */
  outOfTolerance: number;
  /** Worst offender, for divergence forensics. */
  worst?: { index: number; actual: number; expected: number; diff: number };
}

/**
 * numpy.allclose semantics: |a - b| <= atol + rtol * |b|, element-wise,
 * with divergence forensics (per-element out-of-tolerance count + worst index).
 */
export function allClose(
  actual: readonly number[],
  expected: readonly number[],
  rtol: number = DEFAULT_TOLERANCE.rtol,
  atol: number = DEFAULT_TOLERANCE.atol,
): AllCloseResult {
  if (actual.length !== expected.length) {
    return { ok: false, lengthMatch: false, outOfTolerance: Math.abs(actual.length - expected.length) };
  }
  let outOfTolerance = 0;
  let worst: AllCloseResult['worst'];
  for (let i = 0; i < actual.length; i++) {
    const a = actual[i];
    const b = expected[i];
    const diff = Math.abs(a - b);
    const bound = atol + rtol * Math.abs(b);
    if (!(diff <= bound)) {
      outOfTolerance += 1;
      if (!worst || diff > worst.diff) {
        worst = { index: i, actual: a, expected: b, diff };
      }
    }
  }
  return { ok: outOfTolerance === 0, lengthMatch: true, outOfTolerance, worst };
}
