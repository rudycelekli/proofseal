/**
 * Pure suggestion logic for `proofseal suggest` — no git, no fs, fully
 * testable in isolation. Turns "this file changed, these lines were added"
 * into a claim suggestion:
 *
 *   - a distinctive added line that reads like code AND passes the existing
 *     marker lint cleanly  → a MARKER claim (high confidence), because a
 *     marker survives reformatting and pins the BEHAVIOR, not the bytes;
 *   - otherwise            → a FILE-HASH claim (medium confidence), the safe
 *     fallback that always works but trips on any edit to the file.
 *
 * Harness claims are intentionally NOT inferred: we cannot guess a safe,
 * deterministic command to run from a diff (YAGNI + safety). The user adds
 * those by hand, which is the rare case.
 */
import type { FileHashClaim, MarkerClaim } from '../manifest/schema.js';
import { lintMarker } from '../core/marker-lint.js';

export type Confidence = 'high' | 'medium';

/** suggest never infers harness claims (cannot guess a safe command). */
export type SuggestableClaim = FileHashClaim | MarkerClaim;

export interface SuggestedClaim {
  claim: SuggestableClaim;
  confidence: Confidence;
  /** One-line, human-readable rationale for the suggestion. */
  reason: string;
}

/**
 * Tokens that signal an edit worth pinning: defensive/correctness changes are
 * exactly the silent-regression class proofseal exists to catch. Matching a
 * keyword only RANKS a candidate higher; it is never sufficient on its own
 * (the line must still read like code and pass the marker lint).
 */
const FIX_KEYWORDS =
  /\b(fix|bug|regress|guard|clamp|boundary|bounds|overflow|underflow|assert|validate|sanitize|invariant|threshold|epsilon|precision|rounding|offset)\b/i;

/** Comment-only lines make weak markers (reworded freely) — skip them. */
const COMMENT_LINE = /^\s*(\/\/|#|\*|\/\*|--|<!--)/;

/** A line that looks like a statement/definition rather than prose or punctuation. */
const CODE_SHAPE = /^(return|if|for|while|switch|const|let|var|def|func|fn|function|class|public|private|case|throw|await)\b/;

/**
 * Derive a stable, collision-free claim id from a file path. Uses the
 * basename without extension, slugified, with a numeric suffix on collision.
 */
export function makeId(file: string, existingIds: Set<string>): string {
  const base =
    file
      .replace(/^.*\//, '') // basename
      .replace(/\.[^.]+$/, '') // strip extension
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase() || 'claim';
  let id = base;
  let n = 2;
  while (existingIds.has(id)) id = `${base}-${n++}`;
  return id;
}

/**
 * Choose the single best marker among added lines, or undefined if none
 * qualifies. A candidate must: be 10–120 trimmed chars, not be a comment,
 * carry some code signal, and pass `lintMarker` with ZERO warnings against
 * the file text (which enforces uniqueness, non-log-string, and
 * formatting-robustness — the same bar a hand-authored marker must clear).
 */
export function pickMarker(addedLines: string[], fileText: string): string | undefined {
  let best: { marker: string; score: number } | undefined;
  for (const raw of addedLines) {
    const marker = raw.trim();
    if (marker.length < 10 || marker.length > 120) continue;
    if (COMMENT_LINE.test(raw)) continue;

    let score = 0;
    if (FIX_KEYWORDS.test(marker)) score += 3;
    if (CODE_SHAPE.test(marker)) score += 2;
    if (/\b\w+\s*\(/.test(marker)) score += 1; // a call or definition
    if (score === 0) continue; // require at least one code signal

    // Reuse the authoring-time robustness rules: only a marker that would not
    // earn a lint warning is worth auto-suggesting.
    if (lintMarker(marker, fileText).length > 0) continue;

    if (!best || score > best.score) best = { marker, score };
  }
  return best?.marker;
}

/**
 * Build the suggested claim for one changed file, or `undefined` when nothing
 * worth pinning is found. A robust single-line marker is always suggested.
 * The whole-file-hash fallback is OPT-IN (`includeFileHash`): a file-hash
 * claim trips on any edit to the file, so auto-suggesting one on every
 * recently-touched file is a drift-spam machine by construction. Default off
 * — a run that suggests nothing beats one that suggests noise.
 */
export function suggestForFile(
  file: string,
  addedLines: string[],
  fileText: string,
  existingIds: Set<string>,
  includeFileHash = false,
): SuggestedClaim | undefined {
  const marker = pickMarker(addedLines, fileText);
  if (marker) {
    return {
      claim: { id: makeId(file, existingIds), type: 'marker', file, marker, desc: 'auto-suggested from diff' },
      confidence: 'high',
      reason: `distinctive added line reads like code and is unique in ${file}`,
    };
  }
  if (!includeFileHash) return undefined;
  return {
    claim: { id: makeId(file, existingIds), type: 'file-hash', file, desc: 'auto-suggested from diff' },
    confidence: 'medium',
    reason: 'no robust single-line marker found — sealing the whole-file hash (trips on any edit; opted in via --include-file-hash)',
  };
}
