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
