/**
 * Orchestrator for `proofseal suggest`: walks the changed files in a git
 * diff and emits a claim suggestion per eligible file. Skips files already
 * covered by a claim, generated/config artifacts, and anything binary or
 * absent from the working tree. The result is advisory — the caller prints
 * it, or (with --write) appends the new claims to proofseal.json.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProofSealConfig } from '../manifest/schema.js';
import { changedFiles, addedLines, insideGitRepo, type DiffOptions } from './diff.js';
import { suggestForFile, type SuggestedClaim } from './core.js';

export interface SkippedFile {
  file: string;
  reason: string;
}

export interface SuggestResult {
  suggestions: SuggestedClaim[];
  skipped: SkippedFile[];
}

/**
 * Generated, vendored, or proofseal-owned paths that should never become a
 * claim: lockfiles churn on every install, minified bundles are not authored,
 * and proofseal.json / proofs/ are the tool's own bookkeeping.
 */
const SKIP_FILE =
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|proofseal\.json)$|\.min\.(js|css)$|(^|\/)proofs\//;

/** NUL byte ⇒ treat as binary; markers and file hashes target text. */
function looksBinary(text: string): boolean {
  return text.includes('\u0000');
}

export function suggestClaims(
  root: string,
  config: ProofSealConfig,
  opts: DiffOptions = {},
): SuggestResult {
  if (!insideGitRepo(root)) {
    throw new Error('not a git repository (suggest reads a git diff) — run inside a repo, or pass --root');
  }

  // Files already pinned by a file-hash/marker claim — don't re-suggest them.
  const claimedFiles = new Set(
    config.claims
      .filter((c): c is Extract<typeof c, { file: string }> => c.type !== 'harness')
      .map((c) => c.file),
  );
  const existingIds = new Set(config.claims.map((c) => c.id));

  const suggestions: SuggestedClaim[] = [];
  const skipped: SkippedFile[] = [];

  for (const file of changedFiles(root, opts)) {
    if (SKIP_FILE.test(file)) {
      skipped.push({ file, reason: 'generated/config/proofs file' });
      continue;
    }
    if (claimedFiles.has(file)) {
      skipped.push({ file, reason: 'already covered by a claim' });
      continue;
    }
    const abs = join(root, file);
    if (!existsSync(abs)) {
      skipped.push({ file, reason: 'not present in the working tree' });
      continue;
    }
    let fileText: string;
    try {
      fileText = readFileSync(abs, 'utf8');
    } catch {
      skipped.push({ file, reason: 'unreadable' });
      continue;
    }
    if (looksBinary(fileText)) {
      skipped.push({ file, reason: 'binary' });
      continue;
    }
    const suggestion = suggestForFile(file, addedLines(root, file, opts), fileText, existingIds);
    existingIds.add(suggestion.claim.id); // keep ids unique across this run
    suggestions.push(suggestion);
  }

  return { suggestions, skipped };
}
