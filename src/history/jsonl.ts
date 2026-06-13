/**
 * Append-only JSONL history (proofs/history.jsonl) — ADR-0001 §5.5.
 *
 * Schema v:2 (additive, fully back-compat). Discriminated union:
 *  - kind:'seal'   — snapshot of a sealed manifest (the v:1 shape, plus kind).
 *  - kind:'verify' — outcome of a `proofseal verify` run, recorded so a later
 *                    silent reseal can be checked for "resealed-over-break"
 *                    laundering. Logged by default; opt out per-run with
 *                    `proofseal verify --no-log-outcome`.
 *
 * v:1 entries on disk are upgraded in-memory to {v:2, kind:'seal', ...} by
 * loadHistory — the file on disk is never rewritten. Mixed v:1 + v:2 files
 * load cleanly. Writers emit v:2 going forward.
 *
 * JSONL hygiene: reads tolerate blank lines and a missing trailing newline;
 * writes emit exactly one '\n' per line; parse errors surface 1-indexed line
 * numbers.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import type { Manifest, ClaimStatus } from '../manifest/schema.js';

export interface HistoryClaimState {
  sha256: string;
  verified: boolean;
}

/** Snapshot of a sealed manifest — written by `proofseal seal`. */
export interface SealHistoryEntry {
  v: 2;
  kind: 'seal';
  commit: string;
  issuedAt: string;
  branch: string;
  manifestHash: string;
  summary: { totalClaims: number; verified: number; missing: number };
  claims: Record<string, HistoryClaimState>;
}

/** Per-claim verify-time outcome — written by `proofseal verify` (default on). */
export interface VerifyHistoryEntry {
  v: 2;
  kind: 'verify';
  commit: string; // git HEAD at verify time (not the manifest's sealed commit)
  issuedAt: string;
  branch: string;
  manifestHash: string; // hash of the manifest that was verified
  /** Per-claim verdict + the file's actual sha at verify time. */
  results: Record<string, { sha256: string; status: ClaimStatus }>;
}

export type HistoryEntry = SealHistoryEntry | VerifyHistoryEntry;

/** v:1 wire shape — documented here so the upgrade path lives in one file. */
interface HistoryEntryV1 {
  v: 1;
  commit: string;
  issuedAt: string;
  branch: string;
  manifestHash: string;
  summary: { totalClaims: number; verified: number; missing: number };
  claims: Record<string, HistoryClaimState>;
}

function upgradeV1(raw: HistoryEntryV1): SealHistoryEntry {
  return {
    v: 2,
    kind: 'seal',
    commit: raw.commit,
    issuedAt: raw.issuedAt,
    branch: raw.branch,
    manifestHash: raw.manifestHash,
    summary: raw.summary,
    claims: raw.claims,
  };
}

/** Was this claim verified at seal time? (per-type semantics) */
export function claimVerified(claim: Manifest['claims'][number]): boolean {
  switch (claim.type) {
    case 'file-hash':
      return !!claim.sha256;
    case 'marker':
      return claim.markerVerified === true;
    case 'harness':
      return !!claim.expectedSha256;
  }
}

function claimSnapshotHash(claim: Manifest['claims'][number]): string {
  if (claim.type === 'harness') return claim.expectedSha256 ?? '';
  return claim.sha256 ?? '';
}

function writeLine(historyPath: string, obj: unknown): void {
  const line = JSON.stringify(obj);
  if (/[\r\n]/.test(line)) {
    throw new Error('history entry serialized with embedded newline — refusing to corrupt JSONL');
  }
  appendFileSync(historyPath, line + '\n');
}

/** Append a compact snapshot of a sealed manifest. Exactly one '\n' per line. */
export function appendHistory(historyPath: string, manifest: Manifest, manifestHash: string): SealHistoryEntry {
  const claims: Record<string, HistoryClaimState> = {};
  for (const c of manifest.claims) {
    claims[c.id] = { sha256: claimSnapshotHash(c), verified: claimVerified(c) };
  }
  const entry: SealHistoryEntry = {
    v: 2,
    kind: 'seal',
    commit: manifest.gitCommit,
    issuedAt: manifest.issuedAt,
    branch: manifest.branch,
    manifestHash,
    summary: manifest.summary,
    claims,
  };
  writeLine(historyPath, entry);
  return entry;
}

export interface AppendVerifyOptions {
  commit: string;
  issuedAt: string;
  branch: string;
  manifestHash: string;
  results: Record<string, { sha256: string; status: ClaimStatus }>;
}

/**
 * Append a verify-outcome entry. Called by `proofseal verify` by default.
 * Append errors are the caller's problem to swallow — verify's exit code is
 * per-claim semantics, not per-side-effect, so a read-only filesystem must
 * not fail the verify itself (mirror seal's best-effort append).
 */
export function appendVerifyEntry(historyPath: string, opts: AppendVerifyOptions): VerifyHistoryEntry {
  const entry: VerifyHistoryEntry = {
    v: 2,
    kind: 'verify',
    commit: opts.commit,
    issuedAt: opts.issuedAt,
    branch: opts.branch,
    manifestHash: opts.manifestHash,
    results: opts.results,
  };
  writeLine(historyPath, entry);
  return entry;
}

/**
 * Load JSONL history in FILE order. File order is not chronology (union
 * merges can interleave branches) — queries sort by issuedAt via
 * sortByIssuedAt(). Tolerates blank lines / no trailing newline.
 *
 * v:1 entries are upgraded in-memory to {v:2, kind:'seal'} — the file on
 * disk is untouched. Mixed v:1 + v:2 files load identically.
 */
export function loadHistory(historyPath: string): HistoryEntry[] {
  if (!existsSync(historyPath)) return [];
  const raw = readFileSync(historyPath, 'utf8');
  const out: HistoryEntry[] = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '').trim();
    if (!line) continue; // blank lines tolerated
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (e) {
      throw new Error(`history parse error at line ${i + 1}: ${(e as Error).message}`);
    }
    const obj = parsed as { v?: number; kind?: string };
    if (obj.v === 1) {
      out.push(upgradeV1(parsed as HistoryEntryV1));
    } else if (obj.v === 2 && (obj.kind === 'seal' || obj.kind === 'verify')) {
      out.push(parsed as HistoryEntry);
    } else {
      throw new Error(
        `history parse error at line ${i + 1}: unsupported entry (v=${obj.v ?? '<unset>'}, kind=${obj.kind ?? '<unset>'})`,
      );
    }
  }
  return out;
}

/** True for seal entries — small narrowing helper for query code. */
export function isSealEntry(entry: HistoryEntry): entry is SealHistoryEntry {
  return entry.kind === 'seal';
}

/** True for verify entries — small narrowing helper for query code. */
export function isVerifyEntry(entry: HistoryEntry): entry is VerifyHistoryEntry {
  return entry.kind === 'verify';
}
