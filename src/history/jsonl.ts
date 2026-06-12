/**
 * Append-only JSONL history (proofs/history.jsonl) — ADR-0001 §5.5.
 *
 * JSONL hygiene (extraction-map pitfall 9): reads tolerate blank lines
 * and a missing trailing newline; writes emit exactly one '\n' per line;
 * parse errors surface 1-indexed line numbers.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import type { Manifest } from '../manifest/schema.js';

export interface HistoryClaimState {
  sha256: string;
  verified: boolean;
}

export interface HistoryEntry {
  v: 1;
  commit: string;
  issuedAt: string;
  branch: string;
  manifestHash: string;
  summary: { totalClaims: number; verified: number; missing: number };
  claims: Record<string, HistoryClaimState>;
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

/** Append a compact snapshot of a sealed manifest. Exactly one '\n' per line. */
export function appendHistory(historyPath: string, manifest: Manifest, manifestHash: string): HistoryEntry {
  const claims: Record<string, HistoryClaimState> = {};
  for (const c of manifest.claims) {
    claims[c.id] = { sha256: claimSnapshotHash(c), verified: claimVerified(c) };
  }
  const entry: HistoryEntry = {
    v: 1,
    commit: manifest.gitCommit,
    issuedAt: manifest.issuedAt,
    branch: manifest.branch,
    manifestHash,
    summary: manifest.summary,
    claims,
  };
  const line = JSON.stringify(entry);
  if (/[\r\n]/.test(line)) {
    throw new Error('history entry serialized with embedded newline — refusing to corrupt JSONL');
  }
  appendFileSync(historyPath, line + '\n');
  return entry;
}

/**
 * Load JSONL history in FILE order. File order is not chronology (union
 * merges can interleave branches) — queries sort by issuedAt via
 * sortByIssuedAt(). Tolerates blank lines / no trailing newline.
 */
export function loadHistory(historyPath: string): HistoryEntry[] {
  if (!existsSync(historyPath)) return [];
  const raw = readFileSync(historyPath, 'utf8');
  const out: HistoryEntry[] = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '').trim();
    if (!line) continue; // blank lines tolerated
    try {
      out.push(JSON.parse(line) as HistoryEntry);
    } catch (e) {
      throw new Error(`history parse error at line ${i + 1}: ${(e as Error).message}`);
    }
  }
  return out;
}
