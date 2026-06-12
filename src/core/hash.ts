/**
 * SHA-256 helpers. Files are always read as raw bytes (never text mode)
 * so line-ending normalization can never silently change a hash (R2).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** sha256 of a string (utf8) or Buffer, lowercase hex (64 chars). */
export function sha256Hex(input: Buffer | string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** sha256 of a string (utf8) or Buffer, raw 32 bytes. */
export function sha256Bytes(input: Buffer | string): Buffer {
  return createHash('sha256').update(input).digest();
}

/** sha256 of a file's raw bytes, lowercase hex. */
export function fileSha256(absPath: string): string {
  return createHash('sha256').update(readFileSync(absPath)).digest('hex');
}

/**
 * sha256 of a file's bytes with CRLF→LF normalization (premortem #7:
 * Windows insurance). Used ONLY for diagnostics: when a file-hash claim
 * regresses but the CRLF-normalized hash still matches the sealed hash,
 * the cause is almost certainly git autocrlf rewriting line endings —
 * the regressed detail can then name the cause instead of crying tamper.
 */
export function fileSha256CrlfNormalized(absPath: string): string {
  const raw = readFileSync(absPath);
  const out = Buffer.alloc(raw.length);
  let n = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === 0x0d && raw[i + 1] === 0x0a) continue; // drop CR of CRLF
    out[n++] = raw[i];
  }
  return createHash('sha256').update(out.subarray(0, n)).digest('hex');
}

/** True if the file (decoded as utf8) contains the marker substring. */
export function fileContains(absPath: string, marker: string): boolean {
  return readFileSync(absPath, 'utf8').includes(marker);
}

/**
 * Whitespace normalization for marker matching:
 *  1. collapse every run of whitespace (spaces, tabs, newlines) to one space;
 *  2. drop spaces that touch a non-word character (a space is only
 *     SIGNIFICANT between two identifier characters).
 *
 * Step 2 matters because formatters do not just reflow EXISTING whitespace —
 * a Prettier line-wrap inserts whitespace where there was none (a newline
 * after `(`, before `)`, around operators). Pure run-collapsing would still
 * read `computeTotal(\n  items\n)` as missing the marker
 * `computeTotal(items)`. Keeping only word-adjacent spaces makes any
 * whitespace-only rewrite match while `foo bar` can never match `foobar`
 * (so a marker cannot pass via accidental token merging).
 */
function normalizeForMarker(s: string): string {
  return s.replace(/\s+/g, ' ').replace(/ ?([^A-Za-z0-9_ ]) ?/g, '$1').trim();
}

/**
 * Whitespace-normalized marker presence (premortem #7: marker robustness).
 *
 * Markers exist to outlive REBUILDS of a file — but a plain substring check
 * also breaks under routine reformatting (Prettier line-wraps, re-indents,
 * tabs→spaces). That reads as a false "regressed" and teaches users that
 * ProofSeal lies. Both the file text and the marker are normalized (see
 * `normalizeForMarker`) before matching, so whitespace-only rewrites of the
 * marker's surroundings still match while any non-whitespace edit to the
 * marker text itself still (correctly) fails.
 *
 * Plain `fileContains` is kept for exact-substring use cases.
 */
export function markerPresent(text: string, marker: string): boolean {
  return normalizeForMarker(text).includes(normalizeForMarker(marker));
}

/** Whitespace-normalized count of (non-overlapping) marker occurrences. */
export function markerOccurrences(text: string, marker: string): number {
  const needle = normalizeForMarker(marker);
  if (needle === '') return 0;
  return normalizeForMarker(text).split(needle).length - 1;
}
