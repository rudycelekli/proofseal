/**
 * Canonical JSON — sorted-key, undefined-dropping, deterministic
 * serialization (ADR-0001 D5: RuView's byte-stable discipline, ported
 * from the ruflo graph-intelligence witness-signer pattern).
 *
 * The bytes produced here are what gets hashed and signed; any change
 * to this function is a schema-breaking change (bump proofseal/v1).
 */

/**
 * Serialize any JSON-representable value to canonical JSON:
 * - object keys sorted lexicographically
 * - keys with `undefined` values dropped
 * - `undefined` itself serializes as `null`
 * - no whitespace
 */
export function canonicalize(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}';
}
