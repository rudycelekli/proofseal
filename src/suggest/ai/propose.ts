/**
 * AI proposal orchestrator. Builds the prompt from a diff or path list,
 * calls client.ts, validates the response, runs each sealable proposal
 * through the same gates a hand-authored claim must clear (zod ClaimSchema,
 * lintMarker, file-existence check), and returns the survivors + a skipped
 * list with reasons.
 *
 * This file does NOT touch the API key (client.ts does). It does NOT write
 * to disk (pending.ts does). It does NOT touch the sealed manifest, ever.
 *
 * Iron-rule prompt discipline (this is what makes (i) honest at proposal-time
 * rather than discovery-time): the system prompt explicitly states that
 * harness claims must be NUMERIC-deterministic, and that behaviors whose
 * natural output is JSON/text/non-numeric MUST be returned as needs-human
 * with a reason — never dressed up as a harness claim that won't seal.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClaimSchema, type Claim } from '../../manifest/schema.js';
import { lintMarker } from '../../core/marker-lint.js';
import { makeId } from '../core.js';
import { changedFiles, insideGitRepo, type DiffOptions } from '../diff.js';
import {
  callProposeTool,
  MissingApiKeyError,
  MalformedResponseError,
  NetworkError,
} from './client.js';
import { AiResponseSchema, type AiProposal, type NeedsHumanProposal } from './schema.js';

export { MissingApiKeyError, MalformedResponseError, NetworkError };

export interface AcceptedProposal {
  /** Claim shape that survives ClaimSchema validation. */
  claim: Claim;
  confidence: 'low' | 'medium' | 'high';
  reason: string;
}

export interface SkippedProposal {
  /** Best-effort identifier for the human — id, file, or "(unknown)". */
  ref: string;
  reason: string;
}

export interface ProposeResult {
  accepted: AcceptedProposal[];
  needsHuman: NeedsHumanProposal[];
  skipped: SkippedProposal[];
}

export type ProposeOptions = DiffOptions & {
  /** Repo root (default: cwd). */
  root?: string;
  /** Cap on accepted proposals shown to the user (default: 20). */
  showLimit?: number;
  /** Test hook — inject the same fetch the client uses. */
  fetchImpl?: typeof fetch;
  /** Test hook — bypass the network and feed parsed tool input directly. */
  rawToolInputOverride?: unknown;
};

const SYSTEM_PROMPT = [
  'You propose ProofSeal claims for behaviors that look load-bearing but are unsealed.',
  '',
  'ProofSeal has three claim types:',
  '  • harness    — runs a shell command and hashes its NUMERIC stdout (quantized).',
  '                  ONLY propose harness if the natural output is a deterministic',
  '                  vector of numbers. If the behavior naturally emits JSON, text,',
  '                  logs, timestamps, paths, or anything non-numeric — DO NOT propose',
  '                  it as harness. Return needs-human with a reason instead.',
  '  • marker     — pins a distinctive line in a file. Markers must be 10–120 chars,',
  '                  unique in the file, look like code (not a comment/log string),',
  '                  and survive reformatting.',
  '  • file-hash  — pins a whole file. Use sparingly — trips on any edit.',
  '',
  'Iron rule: if you cannot propose a deterministic check for a load-bearing',
  'behavior, return needs-human with a reason. Do not guess a fragile claim.',
  '',
  'Conservatism beats coverage. A small number of high-confidence proposals is',
  'better than many low-confidence ones. The human is the gate.',
].join('\n');

function buildUserPrompt(diffSummary: string, fileSamples: Map<string, string>): string {
  const samples = [...fileSamples.entries()]
    .map(([f, t]) => `--- ${f}\n${t}`)
    .join('\n\n');
  return [
    'Review the following changed code and propose ProofSeal claims for any',
    'load-bearing behaviors that look unsealed. Focus on deterministic',
    'computations whose silent output change would pass tests (financial',
    'totals, transforms, serializers, parsers, formatters).',
    '',
    'Diff summary:',
    diffSummary || '(none — fall back to file samples below)',
    '',
    'File samples (truncated for length):',
    samples || '(none)',
    '',
    'Call the propose_claims tool with your proposals. If nothing looks safely',
    'sealable, return an empty proposals array — do not guess.',
  ].join('\n');
}

/** Truncate a file sample to keep prompt size bounded. */
const SAMPLE_MAX_CHARS = 4000;
const MAX_FILES = 12;
function readSamples(root: string, files: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of files.slice(0, MAX_FILES)) {
    const abs = join(root, f);
    if (!existsSync(abs)) continue;
    try {
      const text = readFileSync(abs, 'utf8');
      if (text.includes('\u0000')) continue; // binary
      out.set(f, text.length > SAMPLE_MAX_CHARS ? text.slice(0, SAMPLE_MAX_CHARS) + '\n…(truncated)' : text);
    } catch {
      /* skip unreadable */
    }
  }
  return out;
}

/**
 * Validate one parsed AI proposal and convert it to an AcceptedProposal,
 * OR return a skip reason. Pure — no fs, no network. Mirrors the discipline
 * the regex source uses (ClaimSchema parse, lintMarker for markers).
 */
function acceptOrSkip(
  p: AiProposal,
  candidateFiles: Set<string>,
  fileSamples: Map<string, string>,
  existingIds: Set<string>,
): { ok: true; item: AcceptedProposal } | { ok: false; ref: string; reason: string } {
  if (p.verdict === 'needs-human') {
    // handled separately by caller
    return { ok: false, ref: p.target, reason: 'needs-human (caller surfaces)' };
  }

  // 1. Build the on-disk claim shape (no `source` field — that's a research
  // harness annotation only; ClaimSchema rejects extras).
  let candidate: Claim;
  if (p.type === 'harness') {
    candidate = {
      type: 'harness',
      id: p.id,
      desc: p.desc,
      harness: p.id,
      cmd: p.cmd,
    };
  } else if (p.type === 'marker') {
    candidate = {
      type: 'marker',
      id: p.id,
      desc: p.desc,
      file: p.file,
      marker: p.marker,
    };
  } else {
    candidate = {
      type: 'file-hash',
      id: p.id,
      desc: p.desc,
      file: p.file,
    };
  }

  // 2. Re-validate through ClaimSchema. If this fails, the AI emitted a
  // shape we lied to ourselves about accepting in schema.ts.
  const parsed = ClaimSchema.safeParse(candidate);
  if (!parsed.success) {
    return { ok: false, ref: p.id, reason: 'failed ClaimSchema validation' };
  }

  // 3. For file-bound proposals: file must exist in candidate set AND on disk.
  if (p.type === 'marker' || p.type === 'file-hash') {
    if (!candidateFiles.has(p.file)) {
      return { ok: false, ref: p.id, reason: `file "${p.file}" not in diff/paths considered` };
    }
    if (!fileSamples.has(p.file)) {
      return { ok: false, ref: p.id, reason: `file "${p.file}" not readable in working tree` };
    }
  }

  // 4. Markers must pass lintMarker against the file text — same bar as
  // hand-authored and regex-source markers.
  if (p.type === 'marker') {
    const warnings = lintMarker(p.marker, fileSamples.get(p.file)!);
    if (warnings.length > 0) {
      return { ok: false, ref: p.id, reason: `marker failed lint: ${warnings[0]}` };
    }
  }

  // 5. Dedupe id against existing claims + earlier accepted proposals.
  if (existingIds.has(p.id)) {
    // Re-id with the same collision logic the regex source uses.
    const newId = makeId(p.id, existingIds);
    parsed.data.id = newId;
    if ('harness' in parsed.data) parsed.data.harness = newId;
  }
  existingIds.add(parsed.data.id);

  return {
    ok: true,
    item: { claim: parsed.data, confidence: p.confidence, reason: p.reason },
  };
}

/**
 * Top-level entry point. Optional API-key path for tests / research harness
 * to consume directly. Returns a structured ProposeResult; throws only on
 * MissingApiKeyError / NetworkError / MalformedResponseError so callers can
 * decide whether to surface or degrade.
 */
export async function proposeAiClaims(opts: ProposeOptions = {}): Promise<ProposeResult> {
  const root = opts.root ?? process.cwd();
  if (!insideGitRepo(root)) {
    throw new Error('not a git repository (ai propose reads a git diff) — run inside a repo or pass --root');
  }

  // Files to consider: the diff selection (or staged, or vs base). When
  // nothing changed (clean tree), the result is "no proposals" — same as
  // the regex source.
  const files = changedFiles(root, opts);
  const candidateFiles = new Set(files);
  const fileSamples = readSamples(root, files);

  const diffSummary = files.length ? files.join('\n') : '';

  // Call the model (or use the test override).
  let toolInput: unknown;
  if (opts.rawToolInputOverride !== undefined) {
    toolInput = opts.rawToolInputOverride;
  } else {
    toolInput = await callProposeTool({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: buildUserPrompt(diffSummary, fileSamples),
      fetchImpl: opts.fetchImpl,
    });
  }

  // Validate the wire shape. A wholly-malformed response is not a partial
  // success — it's an error the caller should see.
  const parsed = AiResponseSchema.safeParse(toolInput);
  if (!parsed.success) {
    throw new MalformedResponseError(
      `AI response failed schema validation: ${parsed.error.issues
        .slice(0, 3)
        .map((i) => i.message)
        .join('; ')}`,
    );
  }

  const proposals = parsed.data.proposals;
  const accepted: AcceptedProposal[] = [];
  const needsHuman: NeedsHumanProposal[] = [];
  const skipped: SkippedProposal[] = [];
  const existingIds = new Set<string>();

  for (const p of proposals) {
    if (p.verdict === 'needs-human') {
      needsHuman.push(p);
      continue;
    }
    const r = acceptOrSkip(p, candidateFiles, fileSamples, existingIds);
    if (r.ok) accepted.push(r.item);
    else skipped.push({ ref: r.ref, reason: r.reason });
  }

  // Hard cap on what's shown — over-cap items go to skipped with reason so
  // the reader can tell a 30-proposal flood happened.
  const limit = opts.showLimit ?? 20;
  if (accepted.length > limit) {
    const overflow = accepted.splice(limit);
    for (const o of overflow) {
      skipped.push({ ref: o.claim.id, reason: 'over show-limit cap' });
    }
  }

  return { accepted, needsHuman, skipped };
}
