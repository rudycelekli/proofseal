/**
 * Cheap git-side validation of bisect results (premortem hazards b/c/d):
 * recorded SHAs can be orphaned by squash-merge, rebase, or force-push, and
 * bisect granularity is seal frequency, not commits. We check reachability
 * with `git cat-file -e <sha>^{commit}` and measure range width with
 * `git rev-list --count`. Everything here is best-effort: git absent or
 * not-a-repo → skip validation silently and return the input unchanged.
 */
import { execFileSync } from 'node:child_process';
import type { RegressionIntroduction } from './queries.js';

export interface RegressionGitInfo {
  /** false = git rejects the SHA (rewritten history?); undefined = not checked. */
  lastPassReachable?: boolean;
  regressedAtReachable?: boolean;
  /** `git rev-list --count lastPass..regressedAt` when both SHAs are reachable. */
  rangeCommitCount?: number;
}

export type EnrichedRegression = RegressionIntroduction & RegressionGitInfo;

/** Tag appended to a SHA that git can no longer resolve. */
export const UNREACHABLE_TAG = '(unreachable — rewritten history?)';

const SHA_RE = /^[0-9a-f]{7,40}$/i;

function git(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 10_000,
  }).toString();
}

function insideGitRepo(root: string): boolean {
  try {
    git(root, ['rev-parse', '--git-dir']);
    return true;
  } catch {
    return false; // git absent, or root is not a repo → skip validation
  }
}

function commitReachable(root: string, sha: string): boolean {
  try {
    git(root, ['cat-file', '-e', `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function revListCount(root: string, from: string, to: string): number | undefined {
  try {
    const n = Number(git(root, ['rev-list', '--count', `${from}..${to}`]).trim());
    return Number.isFinite(n) ? n : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Annotate regressions with reachability + range width. Fail-open: outside
 * a git repo (or git missing) the regressions pass through untouched.
 */
export function enrichRegressionsWithGit(
  root: string,
  regressions: RegressionIntroduction[],
): EnrichedRegression[] {
  if (regressions.length === 0 || !insideGitRepo(root)) {
    return regressions.map((r) => ({ ...r }));
  }
  return regressions.map((r) => {
    const info: RegressionGitInfo = {};
    if (r.lastPassCommit && SHA_RE.test(r.lastPassCommit)) {
      info.lastPassReachable = commitReachable(root, r.lastPassCommit);
    }
    if (SHA_RE.test(r.regressedAtCommit)) {
      info.regressedAtReachable = commitReachable(root, r.regressedAtCommit);
    }
    if (info.lastPassReachable && info.regressedAtReachable) {
      info.rangeCommitCount = revListCount(root, r.lastPassCommit!, r.regressedAtCommit);
    }
    return { ...r, ...info };
  });
}
