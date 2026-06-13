/**
 * Harness stdout normalizers — opt-in, explicit, recorded on the claim,
 * applied identically at seal and verify time.
 *
 * The hash is still over the quantized NUMERIC vector (see ./quantize.ts);
 * these normalizers sit between stdout capture and `parseNumericOutput` to
 * mask known sources of noise (timestamps, UUIDs, paths, etc.) BEFORE the
 * numeric parser sees the text. They harden the existing numeric harness;
 * they do not make arbitrary text/JSON output sealable.
 *
 * Single source of truth for two callers: the diagnose tool (which CLASSIFIES
 * a varying span by which regex matches it) and the run path (which APPLIES
 * the same regex to substitute the span with a fixed token).
 *
 * Integrity rules:
 *   1. A normalizer NEVER alters values that could carry a real regression.
 *      canonicalize-json reorders keys but does not alter values.
 *      Masks replace known-noise patterns with FIXED tokens — they never
 *      compute a transform of the matched substring.
 *   2. canonicalize-json is a no-op when input is not valid JSON. The no-op
 *      is recorded honestly.
 *   3. Application order is hard-coded (not data-driven), so the on-disk
 *      normalizer list cannot perturb the hash by being reordered.
 *
 * Known limit: mask-paths preserves the basename to keep audit-readable
 * filenames. If the basename itself is nondeterministic (e.g. a temp file
 * like `/tmp/abc123/out.json` → `<PATH>/out.json` is fine, but
 * `/tmp/abc123/run-NNNNNN.json` will still leak NNNNNN). Use exclude or
 * change the harness for that case.
 */
import { NormalizerSpecSchema, type NormalizerSpec, type NormalizerName } from '../manifest/schema.js';

export type { NormalizerSpec, NormalizerName };

/**
 * Hard-coded internal application order. Independent of the order specs
 * appear in on the claim — that order is for storage canonicalization only.
 *  strip-ansi first (clean text before subsequent regexes match it)
 *  then mask-* (commutative in practice; alphabetical to kill any ambiguity)
 *  canonicalize-json last (operates on already-masked text)
 */
const APPLICATION_ORDER: readonly NormalizerName[] = [
  'strip-ansi',
  'mask-hex',
  'mask-paths',
  'mask-timestamps',
  'mask-uuids',
  'canonicalize-json',
] as const;

// ─── regex sources (shared by classify + apply) ─────────────────────
//
// Notes on conservative defaults:
//  * mask-timestamps: ISO 8601 ALWAYS; epoch ms (13-digit) only at JSON
//    value positions (preceded by ":" with optional whitespace) — a bare
//    13-digit number in a numeric vector would otherwise be wrongly masked.
//    Epoch seconds (10-digit) are skipped on purpose: too ambiguous with
//    ordinary numeric output.
//  * mask-hex: requires AT LEAST one [a-f] character — pure decimal strings
//    of the same length are not hashes.

const RX_ANSI = /\x1B\[[0-?]*[ -/]*[@-~]/g;
const RX_ISO8601 =
  /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g;
const RX_EPOCH_MS_VALUE = /(:\s*)1\d{12}(?=\s*[,}\]])/g;
const RX_UUID = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
const RX_PATH_UNIX = /(?:\/[A-Za-z0-9._-]+){2,}/g;
const RX_PATH_WIN = /[A-Za-z]:\\(?:[A-Za-z0-9._-]+\\)+[A-Za-z0-9._-]+/g;

/** mask-hex regex factory — minLen-aware; requires at least one a-f char. */
function rxHex(minLen: number): RegExp {
  return new RegExp(`\\b(?=[0-9a-fA-F]*[a-fA-F])[0-9a-fA-F]{${minLen},}\\b`, 'g');
}

// ─── public: classification (used by diagnose AND apply) ────────────

/**
 * Classify a string span by which normalizer would match it.
 * Tried in a stable order; first match wins. Returns `null` if no
 * known normalizer matches — diagnose surfaces this as "unclassified",
 * which is the honest signal that the user has nondeterminism the
 * starter normalizer set cannot mask.
 */
export function classifySpan(span: string): NormalizerName | null {
  if (RX_ANSI.test(span)) {
    RX_ANSI.lastIndex = 0;
    return 'strip-ansi';
  }
  RX_ANSI.lastIndex = 0;
  if (RX_UUID.test(span)) {
    RX_UUID.lastIndex = 0;
    return 'mask-uuids';
  }
  RX_UUID.lastIndex = 0;
  if (RX_ISO8601.test(span)) {
    RX_ISO8601.lastIndex = 0;
    return 'mask-timestamps';
  }
  RX_ISO8601.lastIndex = 0;
  if (RX_PATH_UNIX.test(span) || RX_PATH_WIN.test(span)) {
    RX_PATH_UNIX.lastIndex = 0;
    RX_PATH_WIN.lastIndex = 0;
    return 'mask-paths';
  }
  RX_PATH_UNIX.lastIndex = 0;
  RX_PATH_WIN.lastIndex = 0;
  const rxh = rxHex(32);
  if (rxh.test(span)) return 'mask-hex';
  // float beyond a precision threshold — left to diagnose's hint layer
  // since the existing quantizeDecimals already handles it; not a named
  // normalizer here on purpose.
  return null;
}

// ─── public: canonical storage form ─────────────────────────────────

/**
 * Sort by name, dedupe (last write wins on params), inline defaults via
 * the zod schema. The on-disk shape is then a deterministic function of
 * the LOGICAL normalizer set — order of --normalize flags doesn't matter,
 * repeated names don't matter, omitting an optional param doesn't matter.
 * This is required for the hash to stay stable across configurations a
 * human would consider "the same."
 */
export function canonicalizeNormalizers(
  specs: readonly NormalizerSpec[] | undefined,
): NormalizerSpec[] | undefined {
  if (!specs || specs.length === 0) return undefined;
  const byName = new Map<NormalizerName, NormalizerSpec>();
  for (const s of specs) byName.set(s.name, NormalizerSpecSchema.parse(s));
  const out = Array.from(byName.values());
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// ─── public: apply ──────────────────────────────────────────────────

export interface AppliedNormalizer {
  name: NormalizerName;
  /** Substitutions made (masks) or 1 if canonicalize-json reorganized output. */
  count: number;
  /** True when the step was a no-op for a benign reason (e.g. invalid JSON). */
  noop?: boolean;
  /** Why it was a no-op (only set when noop:true). */
  reason?: string;
}

export interface NormalizeResult {
  text: string;
  applied: AppliedNormalizer[];
}

/**
 * Apply the given normalizer set to text. Order is internal (APPLICATION_ORDER),
 * NOT taken from the input array — defensive determinism so a malformed
 * on-disk list cannot perturb the hash.
 *
 * Every normalizer that was requested produces an entry in `applied`,
 * even if it made zero substitutions (count=0) — the audit record says
 * "this was tried" rather than "this was skipped."
 */
export function applyNormalizers(
  text: string,
  specs: readonly NormalizerSpec[] | undefined,
): NormalizeResult {
  const applied: AppliedNormalizer[] = [];
  if (!specs || specs.length === 0) return { text, applied };

  const requested = new Map<NormalizerName, NormalizerSpec>();
  for (const s of specs) requested.set(s.name, s);

  let cur = text;

  for (const name of APPLICATION_ORDER) {
    const spec = requested.get(name);
    if (!spec) continue;
    const before = cur;
    let count = 0;
    let noop: boolean | undefined;
    let reason: string | undefined;

    switch (spec.name) {
      case 'strip-ansi':
        cur = cur.replace(RX_ANSI, () => {
          count++;
          return '';
        });
        break;
      case 'mask-timestamps':
        cur = cur.replace(RX_ISO8601, () => {
          count++;
          return '<TS>';
        });
        cur = cur.replace(RX_EPOCH_MS_VALUE, (_m, p1: string) => {
          count++;
          return `${p1}<TS>`;
        });
        break;
      case 'mask-uuids':
        cur = cur.replace(RX_UUID, () => {
          count++;
          return '<UUID>';
        });
        break;
      case 'mask-hex': {
        const minLen = spec.minLen ?? 32;
        cur = cur.replace(rxHex(minLen), () => {
          count++;
          return '<HEX>';
        });
        break;
      }
      case 'mask-paths': {
        cur = cur.replace(RX_PATH_UNIX, (m) => {
          count++;
          const basename = m.slice(m.lastIndexOf('/') + 1);
          return `<PATH>/${basename}`;
        });
        cur = cur.replace(RX_PATH_WIN, (m) => {
          count++;
          const basename = m.slice(m.lastIndexOf('\\') + 1);
          return `<PATH>\\${basename}`;
        });
        break;
      }
      case 'canonicalize-json': {
        const trimmed = cur.trim();
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          noop = true;
          reason = 'invalid-json';
          break;
        }
        const sorted = sortJsonKeys(parsed);
        cur = JSON.stringify(sorted);
        count = before === cur ? 0 : 1;
        break;
      }
    }

    const entry: AppliedNormalizer = { name: spec.name, count };
    if (noop) {
      entry.noop = true;
      if (reason) entry.reason = reason;
    }
    applied.push(entry);
  }

  return { text: cur, applied };
}

/**
 * Recursively sort object keys. Critical integrity property: values are
 * NEVER altered — only the key order changes. This is the line that makes
 * canonicalize-json safe: it normalizes presentation, not meaning, so a
 * changed value still surfaces as a hash mismatch downstream.
 */
function sortJsonKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortJsonKeys);
  if (v !== null && typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) out[k] = sortJsonKeys(obj[k]);
    return out;
  }
  return v;
}
