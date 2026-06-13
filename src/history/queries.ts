/**
 * Temporal history queries — ported from ruflo witness lib.mjs
 * (fixTimeline, diffLatest, findRegressionIntroductions), generalized
 * from fixes to claims.
 */
import type { HistoryEntry } from './jsonl.js';

/**
 * Chronological order = `issuedAt` (ISO 8601 → lexicographic compare), with
 * file order as the tie-break. Raw file-line order is NOT chronology: two
 * branches sealing concurrently and union-merging proofs/history.jsonl can
 * interleave lines arbitrarily. Stable sort keeps same-timestamp entries in
 * file order.
 */
export function sortByIssuedAt(history: HistoryEntry[]): HistoryEntry[] {
  return history
    .map((entry, fileIndex) => ({ entry, fileIndex }))
    .sort((a, b) => {
      if (a.entry.issuedAt < b.entry.issuedAt) return -1;
      if (a.entry.issuedAt > b.entry.issuedAt) return 1;
      return a.fileIndex - b.fileIndex;
    })
    .map((x) => x.entry);
}

export interface RegressionIntroduction {
  id: string;
  lastPassCommit: string | null;
  lastPassIssuedAt: string | null;
  regressedAtCommit: string;
  regressedAtIssuedAt: string;
}

/**
 * For each claim currently regressed (verified=false in the latest entry),
 * walk backwards to the most recent pass; the entry after it localizes
 * the regression-introducing commit range. "Latest" = max issuedAt, not
 * last file line (see sortByIssuedAt).
 */
export function findRegressionIntroductions(unordered: HistoryEntry[]): RegressionIntroduction[] {
  if (unordered.length === 0) return [];
  const history = sortByIssuedAt(unordered);
  const latest = history[history.length - 1];
  const out: RegressionIntroduction[] = [];
  for (const [id, state] of Object.entries(latest.claims)) {
    if (state.verified) continue;
    let lastPass: HistoryEntry | null = null;
    let regressedAt: HistoryEntry = latest;
    for (let i = history.length - 2; i >= 0; i--) {
      const e = history[i];
      const s = e.claims[id];
      if (s && s.verified) {
        lastPass = e;
        break;
      }
      regressedAt = e;
    }
    out.push({
      id,
      lastPassCommit: lastPass?.commit ?? null,
      lastPassIssuedAt: lastPass?.issuedAt ?? null,
      regressedAtCommit: regressedAt.commit,
      regressedAtIssuedAt: regressedAt.issuedAt,
    });
  }
  return out;
}

export interface TimelinePoint {
  commit: string;
  issuedAt: string;
  status: 'pass' | 'regressed' | 'absent';
}

/** Status timeline for a single claim across all history entries (issuedAt order). */
export function fixTimeline(unordered: HistoryEntry[], claimId: string): TimelinePoint[] {
  return sortByIssuedAt(unordered).map((e) => ({
    commit: e.commit,
    issuedAt: e.issuedAt,
    status: e.claims[claimId] ? (e.claims[claimId].verified ? 'pass' : 'regressed') : 'absent',
  }));
}

/**
 * Default staleness thresholds. Exported so the CLI's --help text reads from
 * the same source as the function's defaults — the documented value can never
 * drift from the implemented one.
 */
export const DEFAULT_STALE_COMMITS = 10;
export const DEFAULT_STALE_DAYS = 90;

export interface StaleClaim {
  claimId: string;
  lastVerifiedCommit: string | null;
  lastVerifiedAt: string | null;
  commitsSinceVerified: number | null;
  daysSinceVerified: number | null;
  reason: 'dormant' | 'never-verified';
}

export interface FindStaleClaimsOptions {
  staleAfterCommits?: number;
  staleAfterDays?: number;
  /** Anchor the staleness picture at this commit instead of the latest seal. */
  asOfCommit?: string;
  /**
   * "Now" as an ISO 8601 string. Passed in (not read from the wall clock) so
   * the function stays pure: same inputs → same output, tests can pin time.
   * The CLI always supplies this. Ignored when asOfCommit is set (the anchor
   * entry's issuedAt is used instead).
   */
  now?: string;
}

/**
 * Flag claims that have gone dormant (no recent verified=true) or were never
 * once verified. Read-only over the history log — no schema changes.
 *
 * Universe: claims present in the anchor entry (latest by issuedAt, or the
 * asOfCommit entry). Claims absent from the anchor are removed-not-stale and
 * silently ignored. A claim with no verified=true entry at-or-before the
 * anchor is reported as 'never-verified'. Otherwise, its lastPass is the
 * max-issuedAt entry (at-or-before the anchor) where it was verified=true,
 * and it is reported as 'dormant' iff commitsSinceVerified >=
 * staleAfterCommits OR daysSinceVerified >= staleAfterDays.
 *
 * commitsSinceVerified counts DISTINCT commit SHAs in entries strictly after
 * lastPass and at-or-before the anchor — by issuedAt order, never file order
 * (union-merge can interleave lines). Distinct because the same commit can be
 * resealed across branches.
 *
 * Sort: never-verified first (claimId asc), then dormant by daysSinceVerified
 * DESC, commitsSinceVerified DESC, claimId asc.
 *
 * Empty history returns []. asOfCommit not found throws.
 */
export function findStaleClaims(unordered: HistoryEntry[], opts: FindStaleClaimsOptions = {}): StaleClaim[] {
  if (unordered.length === 0) return [];
  const staleAfterCommits = opts.staleAfterCommits ?? DEFAULT_STALE_COMMITS;
  const staleAfterDays = opts.staleAfterDays ?? DEFAULT_STALE_DAYS;
  const history = sortByIssuedAt(unordered);

  // Anchor entry. If asOfCommit is supplied, find its latest-by-issuedAt
  // occurrence (resealings of the same commit pick the most recent one).
  let anchorIdx = history.length - 1;
  if (opts.asOfCommit) {
    anchorIdx = -1;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].commit === opts.asOfCommit) {
        anchorIdx = i;
        break;
      }
    }
    if (anchorIdx === -1) {
      throw new Error(`asOfCommit '${opts.asOfCommit}' not found in history`);
    }
  }
  const anchor = history[anchorIdx];

  // "Now" for days math. asOfCommit anchors days to the anchor entry's seal
  // time (deterministic). Otherwise we trust opts.now (the CLI always passes
  // it); only fall back to wall-clock when nothing was supplied, so a fully
  // specified call is pure.
  const nowMs = opts.asOfCommit
    ? Date.parse(anchor.issuedAt)
    : Date.parse(opts.now ?? new Date().toISOString());

  const scan = history.slice(0, anchorIdx + 1);
  const out: StaleClaim[] = [];

  for (const claimId of Object.keys(anchor.claims)) {
    // lastPass = max-issuedAt entry in scan where this claim was verified=true.
    let lastPass: HistoryEntry | null = null;
    let lastPassIdx = -1;
    for (let i = scan.length - 1; i >= 0; i--) {
      const s = scan[i].claims[claimId];
      if (s && s.verified) {
        lastPass = scan[i];
        lastPassIdx = i;
        break;
      }
    }

    if (!lastPass) {
      out.push({
        claimId,
        lastVerifiedCommit: null,
        lastVerifiedAt: null,
        commitsSinceVerified: null,
        daysSinceVerified: null,
        reason: 'never-verified',
      });
      continue;
    }

    // Distinct commits in (lastPass, anchor] — issuedAt-ordered, bounded at
    // the anchor BEFORE the distinct-count so an --as-of in the past never
    // counts later commits.
    const distinctCommits = new Set<string>();
    for (let i = lastPassIdx + 1; i < scan.length; i++) {
      distinctCommits.add(scan[i].commit);
    }
    const commitsSinceVerified = distinctCommits.size;
    const daysSinceVerified = Math.floor((nowMs - Date.parse(lastPass.issuedAt)) / 86_400_000);

    if (commitsSinceVerified >= staleAfterCommits || daysSinceVerified >= staleAfterDays) {
      out.push({
        claimId,
        lastVerifiedCommit: lastPass.commit,
        lastVerifiedAt: lastPass.issuedAt,
        commitsSinceVerified,
        daysSinceVerified,
        reason: 'dormant',
      });
    }
  }

  out.sort((a, b) => {
    if (a.reason !== b.reason) return a.reason === 'never-verified' ? -1 : 1;
    if (a.reason === 'dormant') {
      const dd = (b.daysSinceVerified ?? 0) - (a.daysSinceVerified ?? 0);
      if (dd !== 0) return dd;
      const dc = (b.commitsSinceVerified ?? 0) - (a.commitsSinceVerified ?? 0);
      if (dc !== 0) return dc;
    }
    return a.claimId < b.claimId ? -1 : a.claimId > b.claimId ? 1 : 0;
  });

  return out;
}

export interface LatestDiff {
  newlyRegressed: string[];
  newlyPassing: string[];
  added: string[];
  removed: string[];
}

/** Compare the latest entry to the previous (by issuedAt) and report transitions. */
export function diffLatest(unordered: HistoryEntry[]): LatestDiff {
  if (unordered.length < 2) return { newlyRegressed: [], newlyPassing: [], added: [], removed: [] };
  const history = sortByIssuedAt(unordered);
  const prev = history[history.length - 2];
  const curr = history[history.length - 1];
  const diff: LatestDiff = { newlyRegressed: [], newlyPassing: [], added: [], removed: [] };
  for (const id of Object.keys(curr.claims)) {
    if (!(id in prev.claims)) diff.added.push(id);
    else if (prev.claims[id].verified && !curr.claims[id].verified) diff.newlyRegressed.push(id);
    else if (!prev.claims[id].verified && curr.claims[id].verified) diff.newlyPassing.push(id);
  }
  for (const id of Object.keys(prev.claims)) {
    if (!(id in curr.claims)) diff.removed.push(id);
  }
  return diff;
}
