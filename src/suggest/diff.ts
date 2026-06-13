/**
 * Git diff layer for `proofseal suggest` — the only impure part of the
 * feature. Reads which files changed and which lines were added, so the pure
 * core (core.ts) can turn that into claim suggestions. git is REQUIRED here
 * (unlike history/gitinfo.ts which fails open): suggest has nothing to do
 * without a diff, so a missing repo is a precondition error, surfaced by the
 * orchestrator.
 */
import { execFileSync } from 'node:child_process';

export interface DiffOptions {
  /** Diff against this ref (e.g. 'main', 'HEAD~3') instead of the working tree. */
  base?: string;
  /** Diff the staged index vs HEAD. */
  staged?: boolean;
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 15_000,
    maxBuffer: 32 * 1024 * 1024,
  }).toString();
}

/** True when root is inside a git work tree (and git is on PATH). */
export function insideGitRepo(root: string): boolean {
  try {
    git(root, ['rev-parse', '--git-dir']);
    return true;
  } catch {
    return false;
  }
}

/** Diff selector shared by changedFiles + addedLines so both read the SAME range. */
function rangeArgs(opts: DiffOptions): string[] {
  if (opts.base) return [opts.base];
  if (opts.staged) return ['--cached'];
  return []; // working tree vs HEAD
}

/**
 * Changed files in the selected diff, restricted to Added + Modified
 * (`--diff-filter=AM`): deletions have nothing to seal, and a rename's old
 * path is gone. Returns repo-relative POSIX paths.
 */
export function changedFiles(root: string, opts: DiffOptions = {}): string[] {
  const out = git(root, ['diff', '--name-only', '--diff-filter=AM', ...rangeArgs(opts)]);
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * The added (`+`) lines for one file in the selected diff, with the leading
 * `+` stripped. `--unified=0` keeps only changed lines (no surrounding
 * context), and `+++` file headers are filtered out.
 */
export function addedLines(root: string, file: string, opts: DiffOptions = {}): string[] {
  const out = git(root, ['diff', '--unified=0', ...rangeArgs(opts), '--', file]);
  return out
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .map((l) => l.slice(1));
}
