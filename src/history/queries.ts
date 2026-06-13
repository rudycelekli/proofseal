/**
 * Temporal history queries — ported from ruflo witness lib.mjs
 * (fixTimeline, diffLatest, findRegressionIntroductions), generalized
 * from fixes to claims.
 *
 * v:2 schema awareness: the history log is now a discriminated union of
 * seal and verify entries. fixTimeline/diffLatest/findRegressionIntroductions/
 * findStaleClaims operate on SEAL entries only (their semantics are "what
 * did the manifest claim at this commit"). findResealedOverBreaks reads BOTH
 * kinds — that is the whole point of recording verify outcomes.
 */
import { isSealEntry, isVerifyEntry } from './jsonl.js';
import type { HistoryEntry, SealHistoryEntry, VerifyHistoryEntry } from './jsonl.js';

/**
 * Chronological order = `issuedAt` (ISO 8601 → lexicographic compare), with
 * file order as the tie-break. Raw file-line order is NOT chronology: two
 * branches sealing concurrently and union-merging proofs/history.jsonl can
 * interleave lines arbitrarily. Stable sort keeps same-timestamp entries in
 * file order. Works for both seal and verify entries (both carry issuedAt).
 */
export function sortByIssuedAt<T extends { issuedAt: string }>(history: T[]): T[] {
  return history
    .map((entry, fileIndex) => ({ entry, fileIndex }))
    .sort((a, b) => {
      if (a.entry.issuedAt < b.entry.issuedAt) return -1;
      if (a.entry.issuedAt > b.entry.issuedAt) return 1;
      return a.fileIndex - b.fileIndex;
    })
    .map((x) => x.entry);
}

/** Filter to seals only — the universe for the four legacy queries. */
function seals(unordered: HistoryEntry[]): SealHistoryEntry[] {
  return unordered.filter(isSealEntry);
}

export interface RegressionIntroduction {
  id: string;
  lastPassCommit: string | null;
  lastPassIssuedAt: string | null;
  regressedAtCommit: string;
  regressedAtIssuedAt: string;
}

/**
 * For each claim currently regressed (verified=false in the latest seal),
 * walk backwards to the most recent pass; the entry after it localizes
 * the regression-introducing commit range. "Latest" = max issuedAt among
 * seals (verify entries are ignored — they're outcomes, not snapshots).
 */
export function findRegressionIntroductions(unordered: HistoryEntry[]): RegressionIntroduction[] {
  const sealOnly = seals(unordered);
  if (sealOnly.length === 0) return [];
  const history = sortByIssuedAt(sealOnly);
  const latest = history[history.length - 1];
  const out: RegressionIntroduction[] = [];
  for (const [id, state] of Object.entries(latest.claims)) {
    if (state.verified) continue;
    let lastPass: SealHistoryEntry | null = null;
    let regressedAt: SealHistoryEntry = latest;
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

/** Status timeline for a single claim across all seals (issuedAt order). */
export function fixTimeline(unordered: HistoryEntry[], claimId: string): TimelinePoint[] {
  return sortByIssuedAt(seals(unordered)).map((e) => ({
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
 * once verified. Reads SEAL entries only — staleness is a property of seal
 * cadence, not verify cadence (a stream of verify-passes without a refresh
 * seal is still legitimate evidence the claim holds).
 *
 * Universe: claims present in the anchor entry (latest seal by issuedAt, or
 * the asOfCommit seal). Claims absent from the anchor are removed-not-stale
 * and silently ignored. A claim with no verified=true seal at-or-before the
 * anchor is reported as 'never-verified'. Otherwise its lastPass is the
 * max-issuedAt seal (at-or-before the anchor) where it was verified=true,
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
  const sealOnly = seals(unordered);
  if (sealOnly.length === 0) return [];
  const staleAfterCommits = opts.staleAfterCommits ?? DEFAULT_STALE_COMMITS;
  const staleAfterDays = opts.staleAfterDays ?? DEFAULT_STALE_DAYS;
  const history = sortByIssuedAt(sealOnly);

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
    let lastPass: SealHistoryEntry | null = null;
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

/** Compare the latest seal to the previous (by issuedAt) and report transitions. */
export function diffLatest(unordered: HistoryEntry[]): LatestDiff {
  const sealOnly = seals(unordered);
  if (sealOnly.length < 2) return { newlyRegressed: [], newlyPassing: [], added: [], removed: [] };
  const history = sortByIssuedAt(sealOnly);
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

/**
 * "Reseal-over-break" — the audit-trail query that distinguishes a properly
 * fixed claim from one that broke and was silently resealed over.
 *
 * Operational definition: per claim, walk history in issuedAt order. Track
 * `lastGoodSha` (set by a seal-verified-true OR a verify-pass) and an open
 * `break` (set by a verify-status regressed/missing OR a seal-self-failed
 * verified:false). A claim can only enter the BROKEN state from a KNOWN-GOOD
 * state (rule #1: lastGoodSha must be set). Once BROKEN, only an independent
 * `verify` with status:'pass' clears it — a seal-verified-true does NOT,
 * because sealing is the laundering move. A seal entry that arrives while
 * BROKEN and changes the sha to anything other than `brokenSha` (the
 * pre-break good sha) is a resealed-over-break event.
 *
 * A reseal whose sha equals brokenSha is a revert: no event, but the break
 * stays open until a real verify-pass clears it.
 *
 * Drift verdicts do not break and do not clear.
 *
 * After an event fires, the state resets — a subsequent event requires a
 * fresh break (a new regressed/missing verify, or a new seal-self-failed).
 *
 * Sort: brokeAtIssuedAt asc, then claimId asc — deterministic.
 *
 * Empty/no-seals history returns []. asOfCommit not found throws.
 */
export interface ResealedBreak {
  claimId: string;
  brokeAtCommit: string;
  brokeAtIssuedAt: string;
  brokeKind: 'verify-regressed' | 'verify-missing' | 'seal-self-failed';
  /**
   * The sha that was last-known-good at the moment of break — i.e. the value
   * that should have been restored (revert) or verified (real fix). Under the
   * prior-good-state rule, this is essentially always non-null; the nullable
   * type is defensive against schema oddities and future evolution.
   */
  brokenSha: string | null;
  resealedAtCommit: string;
  resealedAtIssuedAt: string;
  resealedSha: string;
}

export interface FindResealedOverBreaksOptions {
  /** Anchor the scan at this commit (a seal entry) — events after it are ignored. */
  asOfCommit?: string;
}

export function findResealedOverBreaks(
  unordered: HistoryEntry[],
  opts: FindResealedOverBreaksOptions = {},
): ResealedBreak[] {
  if (unordered.length === 0) return [];
  const history = sortByIssuedAt(unordered);

  // Anchor index — by default, the last entry. If asOfCommit is given, find
  // its latest-by-issuedAt seal occurrence. Verify entries are not addressable
  // by --as-of; the contract is "anchor at a sealed commit."
  let anchorIdx = history.length - 1;
  if (opts.asOfCommit) {
    anchorIdx = -1;
    for (let i = history.length - 1; i >= 0; i--) {
      const e = history[i];
      if (isSealEntry(e) && e.commit === opts.asOfCommit) {
        anchorIdx = i;
        break;
      }
    }
    if (anchorIdx === -1) {
      throw new Error(`asOfCommit '${opts.asOfCommit}' not found in history`);
    }
  }
  const scan = history.slice(0, anchorIdx + 1);

  // Collect the universe of claim ids that have ever appeared in scan.
  const claimIds = new Set<string>();
  for (const e of scan) {
    if (isSealEntry(e)) for (const id of Object.keys(e.claims)) claimIds.add(id);
    else for (const id of Object.keys(e.results)) claimIds.add(id);
  }

  const out: ResealedBreak[] = [];

  for (const claimId of claimIds) {
    let lastGoodSha: string | null = null;
    let openBreak:
      | { atCommit: string; atIssuedAt: string; kind: ResealedBreak['brokeKind']; brokenSha: string | null }
      | null = null;

    for (const entry of scan) {
      if (isSealEntry(entry)) {
        const claim = entry.claims[claimId];
        if (!claim) continue;

        if (openBreak) {
          if (claim.sha256 !== openBreak.brokenSha) {
            // Reseal-over-break — emit event.
            out.push({
              claimId,
              brokeAtCommit: openBreak.atCommit,
              brokeAtIssuedAt: openBreak.atIssuedAt,
              brokeKind: openBreak.kind,
              brokenSha: openBreak.brokenSha,
              resealedAtCommit: entry.commit,
              resealedAtIssuedAt: entry.issuedAt,
              resealedSha: claim.sha256,
            });
            openBreak = null;
            // After clearing, this same seal may itself be a new break or a
            // new known-good — handled by falling through to the no-break
            // branch below.
          } else {
            // Revert (sha matches the pre-break good value). Break stays open
            // until an independent verify-pass clears it. A seal-verified-true
            // at the broken sha is NOT proof — we did not run the verify.
            continue;
          }
        }

        // No break open at this point (either never was, or we just emitted).
        if (claim.verified) {
          lastGoodSha = claim.sha256;
        } else if (lastGoodSha !== null) {
          // Rule #1: only an established (previously-good) claim can break.
          openBreak = {
            atCommit: entry.commit,
            atIssuedAt: entry.issuedAt,
            kind: 'seal-self-failed',
            brokenSha: lastGoodSha,
          };
        }
        // else: first seal verified:false with no prior good — claim was
        // never whole, so it cannot be "broken" yet (rule #1).
      } else if (isVerifyEntry(entry)) {
        const result = entry.results[claimId];
        if (!result) continue;

        if (result.status === 'pass') {
          lastGoodSha = result.sha256;
          openBreak = null;
        } else if (result.status === 'regressed' || result.status === 'missing') {
          if (!openBreak && lastGoodSha !== null) {
            openBreak = {
              atCommit: entry.commit,
              atIssuedAt: entry.issuedAt,
              kind: result.status === 'regressed' ? 'verify-regressed' : 'verify-missing',
              brokenSha: lastGoodSha,
            };
          }
          // else if already broken: stays broken (no double-counting)
          // else if no prior good: rule #1 prevents entering BROKEN
        }
        // drift: no state change (matches documented marker drift semantics)
      }
    }
  }

  out.sort((a, b) => {
    if (a.brokeAtIssuedAt < b.brokeAtIssuedAt) return -1;
    if (a.brokeAtIssuedAt > b.brokeAtIssuedAt) return 1;
    return a.claimId < b.claimId ? -1 : a.claimId > b.claimId ? 1 : 0;
  });

  return out;
}
