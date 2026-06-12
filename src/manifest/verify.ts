/**
 * Verify — the stranger command. Integrity-seal triple-check (recompute
 * hash, re-derive pubkey from embedded commit+salt, verify the seal) plus
 * per-claim pass/drift/regressed/missing classification and the 0/1/2
 * exit-code contract (D7, ported from ruflo verify.mjs / issue #1880).
 */
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { canonicalize } from '../core/canonical.js';
import { normalizeClaimPath } from '../core/paths.js';
import {
  sha256Hex,
  fileSha256,
  fileSha256CrlfNormalized,
  markerPresent as markerPresentIn,
} from '../core/hash.js';
import { deriveKey, verifyBytes } from '../keys/derive.js';
import { runHarness } from '../harness/run.js';
import { loadConfig, DEFAULT_MANIFEST_PATH } from '../config.js';
import type { Claim, ClaimStatus, Witness } from './schema.js';

export const THREAT_MODEL_NOTE =
  'commit-bound tamper-evidence, not third-party authentication';

/** Detail attached to a regressed file-hash claim caused by git autocrlf. */
export const CRLF_DETAIL =
  'content identical after line-ending normalization — likely git autocrlf; pin with .gitattributes (* text=auto eol=lf)';

/** Named precondition hint for an uncommitted reference vector (premortem #5). */
export const REFERENCE_VECTOR_HINT =
  'reference vector not found — did you commit the seal outputs? (run `proofseal seal` then commit the listed files)';

/** Build-output path pattern: a missing file here usually means "not built". */
const BUILD_OUTPUT_RE = /(^|\/)(dist|build|out)\//;

export interface SignatureCheck {
  manifestHashOk: boolean;
  publicKeyReproducible: boolean;
  signatureValid: boolean;
  /** Hex public key from the witness ('' when no manifest is present). */
  publicKey: string;
}

export interface ClaimResult {
  id: string;
  type: Claim['type'];
  desc?: string;
  file?: string;
  status: ClaimStatus;
  sha256Match?: boolean;
  markerPresent?: boolean;
  localSha256?: string;
  hashMatch?: boolean;
  toleranceMatch?: boolean;
  detail?: string;
  /**
   * The failure looks like an unmet environment precondition (build output
   * not built, harness command not installed) rather than a regression.
   * When EVERY failing claim is precondition-suspect, verify exits 2.
   */
  preconditionSuspect?: boolean;
  /** Harness claim whose committed reference vector file is absent. */
  referenceVectorMissing?: boolean;
}

export interface VerifySummary {
  pass: number;
  drift: number;
  regressed: number;
  missing: number;
}

export interface VerifyResult {
  ok: boolean;
  /** 0 ok/drift · 1 regressed/missing/seal-mismatch · 2 precondition. API contract (D7). */
  exitCode: 0 | 1 | 2;
  precondition?: string;
  /** Human hint when a precondition fails (e.g. "run npm ci && npm run build"). */
  hint?: string;
  signature: SignatureCheck;
  summary: VerifySummary;
  results: ClaimResult[];
  note: string;
  /**
   * Set when the verifying OS differs from the sealing OS (premortem #3:
   * platform honesty). Advisory only — never changes exit-code semantics.
   */
  platformWarning?: string;
}

/** Pinned `verify --json` schema, v1 (CONTRACT-RESOLUTIONS §4). */
export interface VerifyJson {
  ok: boolean;
  signature: { valid: boolean; publicKey: string; publicKeyReproducible: boolean };
  summary: { totalClaims: number; pass: number; drift: number; regressed: number; missing: number };
  results: Array<{ id: string; type: string; status: ClaimStatus; file: string; detail: string }>;
  precondition: { reason: string; hint: string } | null;
  /** Additive (v1-compatible): present only on a sealing/verifying OS mismatch. */
  platformWarning?: string;
}

/** Map a VerifyResult onto the pinned v1 JSON schema. */
export function toVerifyJson(r: VerifyResult): VerifyJson {
  return {
    ok: r.ok,
    signature: {
      valid: r.signature.manifestHashOk && r.signature.publicKeyReproducible && r.signature.signatureValid,
      publicKey: r.signature.publicKey,
      publicKeyReproducible: r.signature.publicKeyReproducible,
    },
    summary: { totalClaims: r.results.length, ...r.summary },
    results: r.results.map((c) => ({
      id: c.id,
      type: c.type,
      status: c.status,
      file: c.file ?? '',
      detail: c.detail ?? '',
    })),
    precondition: r.precondition ? { reason: r.precondition, hint: r.hint ?? '' } : null,
    ...(r.platformWarning ? { platformWarning: r.platformWarning } : {}),
  };
}

export interface VerifyOptions {
  root?: string;
  manifestPath?: string;
  /** Execute harness claims (default true). */
  runHarnesses?: boolean;
  /** Current OS for platform-mismatch detection; injectable for tests. */
  currentPlatform?: string;
}

/** Integrity-seal triple-check (ADR §5.4). */
export function checkSignature(witness: Witness): SignatureCheck {
  const recomputed = sha256Hex(canonicalize(witness.manifest));
  const manifestHashOk = recomputed === witness.integrity.manifestHash;
  const key = deriveKey(witness.manifest.gitCommit, witness.manifest.salt);
  const publicKeyReproducible = key.publicKeyHex === witness.integrity.publicKey;
  const signatureValid = verifyBytes(
    witness.integrity.publicKey,
    Buffer.from(witness.integrity.manifestHash, 'hex'),
    witness.integrity.signature,
  );
  return { manifestHashOk, publicKeyReproducible, signatureValid, publicKey: witness.integrity.publicKey };
}

/** Classify a file-backed (file-hash | marker) claim against the live tree. */
export function classifyFileClaim(root: string, claim: Claim): ClaimResult {
  if (claim.type === 'harness') {
    throw new Error('classifyFileClaim called with a harness claim');
  }
  // Windows insurance: tolerate manifests sealed with backslash paths.
  const file = normalizeClaimPath(claim.file);
  const base = { id: claim.id, type: claim.type, desc: claim.desc, file };
  const abs = join(root, file);
  if (!existsSync(abs)) {
    return { ...base, status: 'missing', sha256Match: false, markerPresent: false };
  }
  const localSha256 = fileSha256(abs);
  const sha256Match = localSha256 === claim.sha256;
  if (claim.type === 'file-hash') {
    // The hash IS the expectation: mismatch = regressed (no drift slot).
    if (sha256Match) return { ...base, status: 'pass', sha256Match, localSha256 };
    // CRLF-aware detail (premortem #7): bytes are the contract, so the
    // classification STAYS regressed — but when the CRLF→LF-normalized
    // content matches the sealed hash, the detail names git autocrlf.
    const crlfDetail = fileSha256CrlfNormalized(abs) === claim.sha256 ? CRLF_DETAIL : undefined;
    return { ...base, status: 'regressed', sha256Match, localSha256, ...(crlfDetail ? { detail: crlfDetail } : {}) };
  }
  // Whitespace-normalized (premortem #7): re-indents/line-wraps of the
  // marker's surroundings are drift, not a false regression.
  const markerPresent = markerPresentIn(readFileSync(abs, 'utf8'), claim.marker);
  const status: ClaimStatus =
    sha256Match && markerPresent ? 'pass' : markerPresent ? 'drift' : 'regressed';
  return { ...base, status, sha256Match, markerPresent, localSha256 };
}

async function classifyHarnessClaim(root: string, claim: Claim): Promise<ClaimResult> {
  if (claim.type !== 'harness') throw new Error('expected harness claim');
  const base = { id: claim.id, type: claim.type, desc: claim.desc };
  const result = await runHarness({
    name: claim.harness,
    cmd: claim.cmd,
    cwd: root,
    seed: claim.seed,
    quantizeDecimals: claim.quantizeDecimals,
    exclude: claim.exclude,
    expectedSha256: claim.expectedSha256,
    referenceVector: claim.referenceVector ? normalizeClaimPath(claim.referenceVector) : undefined,
    tolerance: claim.tolerance,
  });
  const status: ClaimStatus =
    result.status === 'error' || result.status === 'missing' ? 'missing' : result.status;
  return {
    ...base,
    status,
    hashMatch: result.hashMatch,
    toleranceMatch: result.toleranceMatch,
    detail: result.commandNotFound
      ? `precondition-suspect: harness command not found (${claim.cmd}) — is the environment set up?`
      : result.error,
    ...(result.commandNotFound ? { preconditionSuspect: true } : {}),
    ...(result.referenceVectorMissing ? { referenceVectorMissing: true } : {}),
  };
}

function summarize(results: ClaimResult[]): VerifySummary {
  return {
    pass: results.filter((r) => r.status === 'pass').length,
    drift: results.filter((r) => r.status === 'drift').length,
    regressed: results.filter((r) => r.status === 'regressed').length,
    missing: results.filter((r) => r.status === 'missing').length,
  };
}

const EMPTY_SIG: SignatureCheck = {
  manifestHashOk: false,
  publicKeyReproducible: false,
  signatureValid: false,
  publicKey: '',
};

function precondition(reason: string, hint: string, summary?: VerifySummary, signature?: SignatureCheck, results?: ClaimResult[]): VerifyResult {
  return {
    ok: false,
    exitCode: 2,
    precondition: reason,
    hint,
    signature: signature ?? EMPTY_SIG,
    summary: summary ?? { pass: 0, drift: 0, regressed: 0, missing: 0 },
    results: results ?? [],
    note: THREAT_MODEL_NOTE,
  };
}

function resolveManifestPath(opts: VerifyOptions): { root: string; manifestPath: string } {
  const root = resolve(opts.root ?? process.cwd());
  if (opts.manifestPath) return { root, manifestPath: resolve(opts.manifestPath) };
  try {
    const cfg = loadConfig(root);
    return { root, manifestPath: cfg.manifestPath };
  } catch {
    return { root, manifestPath: join(root, DEFAULT_MANIFEST_PATH) };
  }
}

/** Verify a sealed manifest against the live tree. Never throws on bad repos. */
export async function verify(opts: VerifyOptions = {}): Promise<VerifyResult> {
  const { root, manifestPath } = resolveManifestPath(opts);
  if (!existsSync(manifestPath)) {
    return precondition(
      'manifest-not-found',
      `no sealed manifest at ${manifestPath} — run \`proofseal seal\` first`,
    );
  }
  let witness: Witness;
  try {
    witness = JSON.parse(readFileSync(manifestPath, 'utf8')) as Witness;
    if (!witness?.manifest || !witness?.integrity) throw new Error('not a proofseal witness document');
  } catch (e) {
    return precondition('manifest-unparseable', `could not parse ${manifestPath}: ${(e as Error).message}`);
  }

  const signature = checkSignature(witness);

  // Platform honesty (premortem #3): warn — never fail — when the verifying
  // OS differs from the (sealed) sealing OS. Manifests sealed before the
  // platform field existed are tolerated silently.
  const currentPlatform = opts.currentPlatform ?? process.platform;
  const sealedOs = witness.manifest.platform?.os;
  const platformWarning =
    sealedOs && sealedOs !== currentPlatform
      ? `sealed on ${sealedOs}, verifying on ${currentPlatform} — file-hash mismatches on built/binary artifacts may be platform drift, not tampering`
      : undefined;

  const results: ClaimResult[] = [];
  for (const claim of witness.manifest.claims) {
    if (claim.type === 'harness') {
      if (opts.runHarnesses === false) continue;
      results.push(await classifyHarnessClaim(root, claim));
    } else {
      results.push(classifyFileClaim(root, claim));
    }
  }

  // Per-claim precondition awareness (premortem #5): a MISSING file claim
  // whose path is a build output (dist/, build/, out/) looks like "you did
  // not build" — but ONLY when the build-output directory itself is absent.
  // If dist/ exists and one sealed file inside it is gone, that is a real
  // MISSING (deleted artifact), not an unbuilt checkout (bench finding
  // 2026-06-12: the directory-blind heuristic misclassified 3/45 deletions).
  for (const r of results) {
    if (r.status === 'missing' && r.file && !r.preconditionSuspect) {
      const m = r.file.match(BUILD_OUTPUT_RE);
      if (m) {
        const buildDir = r.file.slice(0, r.file.indexOf(m[2]!) + m[2]!.length);
        if (!existsSync(join(root, buildDir))) {
          r.preconditionSuspect = true;
          r.detail = r.detail ?? `precondition-suspect: build output ${r.file} is absent — was the project built?`;
        }
      }
    }
  }
  const summary = summarize(results);

  // Named precondition (premortem #5): a harness hash mismatch cannot be
  // classified as drift-vs-regressed without its committed reference vector.
  // The overwhelmingly likely cause is seal outputs that were never
  // committed — surface that by name instead of crying "regressed".
  if (results.some((r) => r.referenceVectorMissing)) {
    return {
      ...precondition('reference-vector-not-found', REFERENCE_VECTOR_HINT, summary, signature, results),
      ...(platformWarning ? { platformWarning } : {}),
    };
  }

  // Exit-2 heuristics (issue #1880, relaxed per premortem round 2):
  //  (a) EVERY failing claim is precondition-suspect (missing build output
  //      and/or harness command not found) ⇒ environment, not regression;
  //  (b) legacy net: every claim missing AND the manifest references a
  //      build-output path ⇒ source-only checkout.
  const failing = results.filter((r) => r.status === 'regressed' || r.status === 'missing');
  const allFailingSuspect = failing.length > 0 && failing.every((r) => r.preconditionSuspect);
  const fileClaims = witness.manifest.claims.filter((c) => c.type !== 'harness');
  const allMissing = results.length > 0 && summary.missing === results.length;
  const referencesBuildOutput = fileClaims.some((c) => BUILD_OUTPUT_RE.test(normalizeClaimPath(c.file)));
  if (allFailingSuspect || (allMissing && referencesBuildOutput)) {
    const onlyCommandsMissing =
      allFailingSuspect && failing.every((r) => r.detail?.includes('harness command not found'));
    const reason = onlyCommandsMissing ? 'harness-command-not-found' : 'dist-not-built';
    const hint = onlyCommandsMissing
      ? 'install the harness command(s) listed in the claim details, then re-run verify'
      : 'run npm ci && npm run build';
    return {
      ...precondition(reason, hint, summary, signature, results),
      ...(platformWarning ? { platformWarning } : {}),
    };
  }

  const sigOk = signature.manifestHashOk && signature.publicKeyReproducible && signature.signatureValid;
  const ok = sigOk && summary.regressed === 0 && summary.missing === 0;
  return {
    ok,
    exitCode: ok ? 0 : 1,
    signature,
    summary,
    results,
    note: THREAT_MODEL_NOTE,
    ...(platformWarning ? { platformWarning } : {}),
  };
}
