/**
 * Cross-platform claim-path normalization (premortem #7: Windows insurance).
 *
 * Claim file paths are stored and compared with forward slashes ONLY, at
 * both seal and verify time: a claim authored on Windows with backslashes
 * must match on POSIX and vice versa. `node:path.join` accepts forward
 * slashes on every platform, so normalized paths resolve everywhere.
 */

/** Normalize a repo-relative claim path to forward slashes. */
export function normalizeClaimPath(p: string): string {
  return p.replace(/\\/g, '/');
}
