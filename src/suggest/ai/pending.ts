/**
 * Pending-proposal quarantine. The single mechanism by which `--write`
 * persists AI proposals — and it never touches the sealed manifest.
 *
 * Invariants this file enforces by construction:
 *   1. Writes go ONLY to <root>/proofs/pending.json (never proofseal.json,
 *      never proofs/manifest.json, never proofs/history.jsonl).
 *   2. The file carries a top-level `warning` so anyone opening it sees
 *      the unverified status without reading docs.
 *   3. Each entry is keyed by claim id; appending dedupes against existing
 *      pending + the sealed config so the same proposal doesn't accumulate.
 *
 * Promoting pending → sealed is an explicit human action. The CLI prints
 * the exact `proofseal claim add ...` command for each entry next to it.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Claim } from '../../manifest/schema.js';
import type { AcceptedProposal } from './propose.js';

export const PENDING_SCHEMA = 'proofseal-pending/v1';
export const PENDING_REL_PATH = 'proofs/pending.json';

export interface PendingProposal {
  /** Always 'ai-suggest' in this build; other sources may add their own pending later. */
  source: 'ai-suggest';
  /** ISO timestamp the proposal was emitted. */
  generatedAt: string;
  /** Confidence as reported by the AI. */
  confidence: 'low' | 'medium' | 'high';
  /** One-line rationale. */
  reason: string;
  /** The claim shape (passed ClaimSchema, has not been sealed). */
  claim: Claim;
}

export interface PendingFile {
  schema: typeof PENDING_SCHEMA;
  warning: string;
  proposals: PendingProposal[];
}

const PENDING_WARNING =
  'proposals here are UNVERIFIED. They are not part of the sealed manifest. ' +
  'To make a proposal real, run the printed `proofseal claim add ...` command.';

function blankFile(): PendingFile {
  return { schema: PENDING_SCHEMA, warning: PENDING_WARNING, proposals: [] };
}

export function pendingPath(root: string): string {
  return join(root, PENDING_REL_PATH);
}

/** Read pending.json, or return a blank shape. Tolerates a missing file. */
export function readPending(root: string): PendingFile {
  const p = pendingPath(root);
  if (!existsSync(p)) return blankFile();
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    if (raw && raw.schema === PENDING_SCHEMA && Array.isArray(raw.proposals)) {
      return { schema: PENDING_SCHEMA, warning: raw.warning ?? PENDING_WARNING, proposals: raw.proposals };
    }
  } catch {
    /* fall through */
  }
  return blankFile();
}

/**
 * Append accepted proposals to pending.json. Dedupes by id against current
 * pending + a caller-supplied set of sealed claim ids. Returns the ids
 * actually written. Pure-ish: only writes to PENDING_REL_PATH.
 */
export function appendPending(
  root: string,
  accepted: AcceptedProposal[],
  sealedClaimIds: Iterable<string>,
): { written: string[]; skipped: string[] } {
  const file = readPending(root);
  const existing = new Set<string>(file.proposals.map((p) => p.claim.id));
  for (const id of sealedClaimIds) existing.add(id);

  const written: string[] = [];
  const skipped: string[] = [];
  const now = new Date().toISOString();

  for (const a of accepted) {
    if (existing.has(a.claim.id)) {
      skipped.push(a.claim.id);
      continue;
    }
    file.proposals.push({
      source: 'ai-suggest',
      generatedAt: now,
      confidence: a.confidence,
      reason: a.reason,
      claim: a.claim,
    });
    existing.add(a.claim.id);
    written.push(a.claim.id);
  }

  // Re-stamp the warning every write (in case a user blanked it).
  file.warning = PENDING_WARNING;

  writeFileSync(pendingPath(root), JSON.stringify(file, null, 2) + '\n', 'utf8');
  return { written, skipped };
}

/** Build the human-runnable `proofseal claim add` command for one proposal. */
export function claimAddCommandFor(p: AcceptedProposal): string {
  const c = p.claim;
  const q = (s: string) => `"${s.replace(/"/g, '\\"')}"`;
  if (c.type === 'harness') {
    return `proofseal claim add --type harness --id ${q(c.id)} --cmd ${q(c.cmd)}`;
  }
  if (c.type === 'marker') {
    return `proofseal claim add --type marker --id ${q(c.id)} --file ${q(c.file)} --marker ${q(c.marker)}`;
  }
  return `proofseal claim add --type file-hash --id ${q(c.id)} --file ${q(c.file)}`;
}
