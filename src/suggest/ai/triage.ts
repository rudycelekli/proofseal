/**
 * Triage — AI failure-explanation layer. Build 3 of 3.
 *
 * THE IRON RULE (Build 3 edition):
 *   The AI explains; it never decides. `triageVerify` is a PURE POST-PROCESSOR
 *   over an already-computed VerifyResult. It cannot — by construction —
 *   change the verdict, the exit code, or any field on results[].
 *
 * Mechanical guarantees:
 *   1. This module lives under src/suggest/ai/* — the static import-graph BFS
 *      test (tests/unit/ai-import-isolation.test.mjs) already forbids
 *      manifest/seal.ts, manifest/verify.ts, harness/run.ts, harness/normalize.ts
 *      from reaching it. New file, same boundary, no new plumbing.
 *   2. We deep-freeze the incoming VerifyResult before any AI call.
 *   3. We never call seal(), never read/write PROOFSEAL_ALLOW_RESEAL.
 *      A "justify-and-reseal" recommendation is a STRING — the human gate
 *      still owns the actual reseal.
 *   4. Malformed AI response → triageError on the result, verdict + forensics
 *      still printed unchanged.
 */
import { z } from 'zod';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { callProposeTool, MissingApiKeyError, NetworkError, MalformedResponseError } from './client.js';
import type { VerifyResult, ClaimResult } from '../../manifest/verify.js';
import type { ClaimStatus, Witness } from '../../manifest/schema.js';

// ────────────────────────────────────────────────────────────────────────────
// Public types — the agent-consumable triage shape.
// ────────────────────────────────────────────────────────────────────────────

export type TriageClassification = 'looks-intentional' | 'looks-silent' | 'cant-tell';
export type TriageRecommendation = 'revert' | 'justify-and-reseal' | 'investigate';
export type TriageConfidence = 'low' | 'medium' | 'high';

/**
 * The fixed disclaimer that rides on every reseal recommendation. Carries the
 * "this is a suggestion only; the human gate is still the gate" message in
 * one line so it cannot get visually detached from the recommendation.
 */
export const RESEAL_GATE_NOTICE =
  'SUGGESTION ONLY. Resealing requires a human-owned shell running `proofseal seal` ' +
  '(or PROOFSEAL_ALLOW_RESEAL=1 over MCP). Triage cannot unlock the gate.';

export interface TriageAnnotation {
  /** Cross-reference back to the verdict's results[].id. */
  claimId: string;
  /** Pinned to the verdict's status — proves the annotation matches the verdict it annotates. */
  status: ClaimStatus;
  classification: TriageClassification;
  recommendation: TriageRecommendation;
  confidence: TriageConfidence;
  /** Plain-language, ≤500 chars — capped in the zod schema below. */
  explanation: string;
  /** Present only when recommendation === 'justify-and-reseal'. Always === RESEAL_GATE_NOTICE. */
  resealGate?: string;
}

/**
 * The post-processed result. The original `verdict` is the SAME REFERENCE
 * passed in (and is deep-frozen) — printers always show it first, unchanged.
 */
export interface TriagedVerifyResult {
  verdict: VerifyResult;
  annotations: TriageAnnotation[];
  /** Set when triage was unavailable or failed. The verdict is still fully usable. */
  triageError?: string;
}

// ────────────────────────────────────────────────────────────────────────────
// AI response schema — what the tool MUST return.
// ────────────────────────────────────────────────────────────────────────────

const AiTriageItemSchema = z.object({
  claimId: z.string().min(1).max(64),
  classification: z.enum(['looks-intentional', 'looks-silent', 'cant-tell']),
  recommendation: z.enum(['revert', 'justify-and-reseal', 'investigate']),
  confidence: z.enum(['low', 'medium', 'high']),
  explanation: z.string().min(1).max(500),
});

const AiTriageResponseSchema = z.object({
  triage: z.array(AiTriageItemSchema).max(50),
});

/** Strict JSON Schema mirror for forced tool-use. Keep in sync with the zod above. */
const TRIAGE_TOOL_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['triage'],
  properties: {
    triage: {
      type: 'array',
      maxItems: 50,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['claimId', 'classification', 'recommendation', 'confidence', 'explanation'],
        properties: {
          claimId: { type: 'string', minLength: 1, maxLength: 64 },
          classification: { enum: ['looks-intentional', 'looks-silent', 'cant-tell'] },
          recommendation: { enum: ['revert', 'justify-and-reseal', 'investigate'] },
          confidence: { enum: ['low', 'medium', 'high'] },
          explanation: { type: 'string', minLength: 1, maxLength: 500 },
        },
      },
    },
  },
} as const;

// ────────────────────────────────────────────────────────────────────────────
// Options + entrypoint.
// ────────────────────────────────────────────────────────────────────────────

export interface TriageOptions {
  /** Repo root — used to read the witness for the sealed gitCommit and to run `git diff`. */
  root: string;
  /** Witness override (tests). When absent, read from `<root>/proofs/manifest.json` (default config path). */
  witness?: Witness;
  /** Cap the number of claims sent to the model. Default 10. */
  maxItems?: number;
  /**
   * Override the AI call entirely. Tests inject a function that returns the
   * structured response WITHOUT going through fetch — bypasses the network,
   * exercises the validation + projection pipeline in isolation.
   *
   * When provided, this is called INSTEAD of `callProposeTool`. The override
   * receives the same diff context the real call would have built so tests
   * can assert on the prompt if they want.
   */
  callOverride?: (ctx: TriageCallContext) => Promise<unknown>;
  /** Override fetch (forwarded to callProposeTool). */
  fetchImpl?: typeof fetch;
}

export interface TriageCallContext {
  systemPrompt: string;
  userPrompt: string;
  failingClaims: ClaimResult[];
}

/**
 * Read the project's manifest in the standard location. Returns undefined if
 * absent or unparseable — triage just downgrades to a clean error in that case.
 */
function tryReadWitness(root: string): Witness | undefined {
  try {
    const txt = readFileSync(join(root, 'proofs', 'manifest.json'), 'utf8');
    const parsed = JSON.parse(txt) as Witness;
    if (parsed?.manifest && parsed?.integrity) return parsed;
  } catch {
    /* fall through */
  }
  return undefined;
}

/**
 * Capture the git diff from the sealed commit → working tree. Bounded to
 * 8KB to keep prompts reasonable; truncation is tagged so the model knows.
 */
function captureDiff(root: string, sealedCommit: string): string {
  try {
    const raw = execFileSync('git', ['diff', sealedCommit, '--unified=3'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
    const MAX = 8192;
    if (raw.length <= MAX) return raw || '(no diff)';
    return raw.slice(0, MAX) + '\n…(diff truncated)';
  } catch (e) {
    return `(could not produce diff: ${(e as Error).message})`;
  }
}

/**
 * Deep-freeze a VerifyResult so triage code path CAN'T accidentally mutate it.
 * Defensive — the printers also re-print from the same reference. Belt + suspenders.
 */
function deepFreeze<T>(o: T): T {
  if (o === null || typeof o !== 'object') return o;
  Object.freeze(o);
  for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
  return o;
}

const SYSTEM_PROMPT = [
  'You are a triage analyst for ProofSeal failures. The deterministic core has already',
  'decided a claim REGRESSED/DRIFTED/MISSING — you do NOT change that verdict.',
  'You annotate it with a plain-language explanation and a recommendation an agent or human can act on.',
  '',
  'For each failing claim, decide:',
  '  classification:',
  '    looks-intentional → the diff between sealed commit and current obviously explains',
  '                         the value/marker change (e.g. the formula or marker was deliberately rewritten,',
  '                         the commit message names the change).',
  '    looks-silent      → the value/marker moved but the diff does NOT explain why,',
  '                         OR the change appears to contradict the claim\'s intent-note.',
  '    cant-tell         → the diff is ambiguous, too large, or you do not have',
  '                         enough information to decide. DO NOT GUESS — use cant-tell freely.',
  '',
  '  recommendation:',
  '    revert            → looks-silent regression of load-bearing behavior. The change should be backed out.',
  '    justify-and-reseal→ looks-intentional change. The claim should be re-sealed AFTER human review.',
  '                         (You are advisory; the actual reseal goes through a separate human gate.)',
  '    investigate       → cant-tell. Hand it to a human.',
  '',
  '  confidence: low | medium | high. Be honest. Prefer low/medium over false high.',
  '',
  '  explanation: ≤500 chars, plain language. Name the diff fragment if relevant.',
  '',
  'You MUST return one entry per claim you were given, identified by claimId.',
  'You MUST use the propose_triage tool. Do not free-text.',
].join('\n');

function buildUserPrompt(opts: { failing: ClaimResult[]; witness: Witness; diff: string }): string {
  const { failing, witness, diff } = opts;
  const parts: string[] = [];
  parts.push(`Sealed commit: ${witness.manifest.gitCommit}`);
  parts.push(`Sealed at:     ${witness.manifest.issuedAt}`);
  parts.push('');
  parts.push('FAILING CLAIMS:');
  for (const r of failing) {
    const sealed = witness.manifest.claims.find((c) => c.id === r.id);
    const intent = sealed?.desc ?? '(no intent-note recorded)';
    parts.push(`- claimId: ${r.id}`);
    parts.push(`  type: ${r.type}`);
    parts.push(`  status: ${r.status}`);
    if (r.file) parts.push(`  file: ${r.file}`);
    parts.push(`  intent-note: ${intent}`);
    if (r.detail) parts.push(`  detail: ${r.detail}`);
    parts.push('');
  }
  parts.push('GIT DIFF (sealed commit → working tree):');
  parts.push('```diff');
  parts.push(diff);
  parts.push('```');
  return parts.join('\n');
}

/**
 * The entrypoint. PURE POST-PROCESSOR: it only ever READS from `verifyResult`
 * and returns a new wrapper object. The verdict reference inside is untouched.
 */
export async function triageVerify(
  verifyResult: VerifyResult,
  opts: TriageOptions,
): Promise<TriagedVerifyResult> {
  // (1) Belt: freeze the verdict before doing ANYTHING that could see it.
  //     Suspenders: we also never write to it. Both guarantees hold.
  deepFreeze(verifyResult);

  const failing = verifyResult.results.filter(
    (r) => r.status === 'regressed' || r.status === 'drift' || r.status === 'missing',
  );

  // Nothing to triage — clean pass-through, no AI call, no error.
  if (failing.length === 0) {
    return { verdict: verifyResult, annotations: [] };
  }

  const witness = opts.witness ?? tryReadWitness(opts.root);
  if (!witness) {
    return {
      verdict: verifyResult,
      annotations: [],
      triageError: 'triage skipped: no sealed manifest available to read',
    };
  }

  const capped = failing.slice(0, opts.maxItems ?? 10);
  const diff = captureDiff(opts.root, witness.manifest.gitCommit);
  const userPrompt = buildUserPrompt({ failing: capped, witness, diff });
  const ctx: TriageCallContext = {
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    failingClaims: capped,
  };

  let raw: unknown;
  try {
    raw = opts.callOverride
      ? await opts.callOverride(ctx)
      : await callTriageTool(ctx, opts.fetchImpl);
  } catch (e) {
    if (e instanceof MissingApiKeyError) {
      return {
        verdict: verifyResult,
        annotations: [],
        triageError: 'triage skipped: ANTHROPIC_API_KEY is not set (verdict above stands as-is)',
      };
    }
    if (e instanceof NetworkError) {
      return {
        verdict: verifyResult,
        annotations: [],
        triageError: `triage unavailable: ${e.message} (verdict above stands as-is)`,
      };
    }
    if (e instanceof MalformedResponseError) {
      return {
        verdict: verifyResult,
        annotations: [],
        triageError: `triage response malformed: ${e.message} (verdict above stands as-is)`,
      };
    }
    return {
      verdict: verifyResult,
      annotations: [],
      triageError: `triage failed: ${(e as Error).message} (verdict above stands as-is)`,
    };
  }

  const parsed = AiTriageResponseSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      verdict: verifyResult,
      annotations: [],
      triageError: `triage response did not match schema: ${parsed.error.issues[0]?.message ?? 'unknown'} (verdict above stands as-is)`,
    };
  }

  // Project from AI items → TriageAnnotation, pinning each to the verdict's
  // result so the annotation can never claim a status the verdict didn't.
  const annotations: TriageAnnotation[] = [];
  for (const item of parsed.data.triage) {
    const verdictResult = capped.find((r) => r.id === item.claimId);
    if (!verdictResult) continue; // AI invented a claimId — drop it, keep going
    const a: TriageAnnotation = {
      claimId: item.claimId,
      status: verdictResult.status,
      classification: item.classification,
      recommendation: item.recommendation,
      confidence: item.confidence,
      explanation: item.explanation,
    };
    if (item.recommendation === 'justify-and-reseal') {
      a.resealGate = RESEAL_GATE_NOTICE;
    }
    annotations.push(a);
  }

  return { verdict: verifyResult, annotations };
}

// ────────────────────────────────────────────────────────────────────────────
// Network plumbing — mirrors propose.ts but the system+user prompt and the
// tool schema are triage-specific.
// ────────────────────────────────────────────────────────────────────────────

async function callTriageTool(ctx: TriageCallContext, fetchImpl?: typeof fetch): Promise<unknown> {
  // We reuse the low-level fetch wrapper for the API + key handling, but the
  // tool name + input_schema have to be triage-specific. Easiest path: a small
  // local copy of the messages call. Keeps client.ts a single-purpose primitive
  // (proposing claims) and lets triage have its own tool schema.
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new MissingApiKeyError();
  const f = fetchImpl ?? globalThis.fetch;
  if (typeof f !== 'function') throw new NetworkError('fetch is not available in this runtime');

  const body = {
    model: process.env.AI_TRIAGE_MODEL ?? process.env.AI_PROPOSE_MODEL ?? 'claude-sonnet-4-5',
    max_tokens: 2048,
    system: ctx.systemPrompt,
    messages: [{ role: 'user', content: ctx.userPrompt }],
    tools: [
      {
        name: 'propose_triage',
        description:
          'Annotate already-verdicted failing claims with a classification, recommendation, confidence, and explanation. ' +
          'You do NOT change the verdict — it has already been computed deterministically.',
        input_schema: TRIAGE_TOOL_INPUT_SCHEMA,
      },
    ],
    tool_choice: { type: 'tool', name: 'propose_triage' },
  };

  let res: Response;
  try {
    res = await f('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new NetworkError(`fetch failed: ${(e as Error).message}`);
  }
  if (!res.ok) {
    let snippet = '';
    try { snippet = (await res.text()).slice(0, 300); } catch { /* nothing */ }
    throw new NetworkError(`Anthropic API ${res.status}`, res.status, snippet);
  }
  let json: any;
  try {
    json = await res.json();
  } catch (e) {
    throw new MalformedResponseError(`response was not JSON: ${(e as Error).message}`);
  }
  const blocks: any[] = Array.isArray(json?.content) ? json.content : [];
  const toolUse = blocks.find((b) => b && b.type === 'tool_use' && b.name === 'propose_triage');
  if (!toolUse) throw new MalformedResponseError('no propose_triage tool_use block in response');
  if (typeof toolUse.input !== 'object' || toolUse.input === null) {
    throw new MalformedResponseError('tool_use.input was not an object');
  }
  return toolUse.input;
}

// ────────────────────────────────────────────────────────────────────────────
// Rendering — verdict-primary, AI-secondary. Both human + JSON shapes.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Human-readable triage block. The "[AI opinion]" tag rides on EVERY
 * recommendation line so even a wrapped terminal cannot detach the
 * disclaimer from the recommendation it qualifies.
 *
 * Always called AFTER the verdict has been printed. Never replaces it.
 */
export function renderTriageHuman(triaged: TriagedVerifyResult): string {
  if (triaged.triageError) {
    return `\nTRIAGE: ${triaged.triageError}\n`;
  }
  if (triaged.annotations.length === 0) return '';
  const lines: string[] = [];
  lines.push('');
  lines.push('─────── TRIAGE ANNOTATION (AI opinion; NOT a verdict) ───────');
  for (const a of triaged.annotations) {
    lines.push(`${a.claimId}  [${a.status.toUpperCase()}]`);
    lines.push(`  [AI opinion] classification: ${a.classification} (confidence: ${a.confidence})`);
    lines.push(`  [AI opinion] recommendation: ${a.recommendation}`);
    // Wrap explanation at 72 cols so narrow terminals stay readable.
    for (const ln of wrap(a.explanation, 72)) lines.push(`    ${ln}`);
    if (a.resealGate) {
      lines.push(`  [reseal gate] ${a.resealGate}`);
    }
    lines.push('');
  }
  lines.push('─────────────────────────────────────────────────────────────');
  return lines.join('\n');
}

function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const out: string[] = [];
  let line = '';
  for (const w of words) {
    if (!line) { line = w; continue; }
    if (line.length + 1 + w.length > width) { out.push(line); line = w; }
    else line += ' ' + w;
  }
  if (line) out.push(line);
  return out;
}

/**
 * Project the triage block onto the v1 JSON schema as a SIBLING field.
 * Never folded into results[].detail — agents branch on results[].status
 * (deterministic) before triage.annotations[].recommendation (advisory).
 */
export interface TriageJsonBlock {
  annotations: TriageAnnotation[];
  error: string | null;
}

export function toTriageJson(triaged: TriagedVerifyResult): TriageJsonBlock {
  return {
    annotations: triaged.annotations,
    error: triaged.triageError ?? null,
  };
}
