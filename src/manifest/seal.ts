/**
 * Seal — refresh claims against the live tree, build the proofseal/v1
 * manifest, derive the commit-bound key, seal, write, append history.
 * (Port of ruflo lib.mjs regenerate(), adapted to sorted-key
 * canonicalization and the three-claim-type model.)
 */
import { existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { execSync, execFileSync } from 'node:child_process';
import { canonicalize } from '../core/canonical.js';
import { normalizeClaimPath } from '../core/paths.js';
import { sha256Hex, fileSha256, markerPresent, markerOccurrences } from '../core/hash.js';
import { deriveKey, signBytes, SEED_DERIVATION } from '../keys/derive.js';
import { appendHistory, claimVerified, type HistoryEntry } from '../history/jsonl.js';
import { runHarness } from '../harness/run.js';
import { DEFAULT_TOLERANCE } from '../harness/quantize.js';
import { loadConfig, saveConfig, CONFIG_FILENAME } from '../config.js';
import { SCHEMA_ID, type Claim, type ClaimState, type Manifest, type Witness } from './schema.js';

/** Refresh a single claim against the live tree (synchronous, seal-time). */
export function refreshClaim(root: string, claim: Claim): ClaimState {
  if (claim.type === 'harness') {
    // Existing expectations are carried through unchanged (regeneration only
    // via reviewed `proofseal harness run --update`). First-seal minting of a
    // brand-new expectation happens in seal() itself.
    return {
      ...claim,
      harness: claim.harness || claim.id,
      seed: claim.seed ?? 42,
      quantizeDecimals: claim.quantizeDecimals ?? 6,
      ...(claim.referenceVector
        ? { referenceVector: normalizeClaimPath(claim.referenceVector) }
        : {}),
      missing: false,
    };
  }
  // Windows insurance: claim paths are sealed with forward slashes so a
  // claim authored on Windows matches on POSIX and vice versa.
  const file = normalizeClaimPath(claim.file);
  const abs = join(root, file);
  if (!existsSync(abs)) {
    if (claim.type === 'marker') {
      return { ...claim, file, sha256: claim.sha256 ?? '', markerVerified: false, missing: true };
    }
    return { ...claim, file, sha256: claim.sha256 ?? '', missing: true };
  }
  const sha256 = fileSha256(abs);
  if (claim.type === 'marker') {
    // Whitespace-normalized check (premortem #7): a Prettier line-wrap or
    // re-indent of the marker's surroundings must not break the claim.
    const verified = markerPresent(readFileSync(abs, 'utf8'), claim.marker);
    return { ...claim, file, sha256, markerVerified: verified, missing: false };
  }
  return { ...claim, file, sha256, missing: false };
}

/** Warn-worthy issues found while sealing (R5: marker fragility). */
export interface SealWarning {
  id: string;
  message: string;
}

export interface SealOptions {
  root?: string;
  /** Override the git commit (40-hex). Defaults to `git rev-parse HEAD`. */
  gitCommit?: string;
  /** Override the branch. Defaults to `git rev-parse --abbrev-ref HEAD`. */
  branch?: string;
  /** Override issuedAt (ISO 8601). Defaults to now. */
  issuedAt?: string;
  /** Extra releases map merged over the config's. */
  releases?: Record<string, string>;
}

export interface SealResult {
  ok: boolean;
  witness: Witness;
  manifestPath: string;
  historyPath: string;
  historyEntry: HistoryEntry;
  summary: Manifest['summary'];
  warnings: SealWarning[];
  /**
   * Repo-relative (forward-slash) paths of every file `verify` needs
   * committed: whatever this seal wrote (reference vectors, a rewritten
   * proofseal.json, the manifest, the history log) PLUS any pre-existing
   * verify-required file (proofseal.json, reference vectors) that git
   * reports as untracked or dirty. CI footgun pack (premortem #5) +
   * R4 quickstart finding: verify on a clean clone only works if ALL of
   * these are committed — the CLI prints them as a checklist.
   */
  filesWritten: string[];
}

function gitMeta(root: string, opts: SealOptions): { gitCommit: string; branch: string } {
  const gitCommit =
    opts.gitCommit ?? execSync('git rev-parse HEAD', { cwd: root }).toString().trim();
  const branch =
    opts.branch ?? execSync('git rev-parse --abbrev-ref HEAD', { cwd: root }).toString().trim();
  return { gitCommit, branch };
}

/** Seal the repo: manifest + integrity block + history snapshot. */
export async function seal(opts: SealOptions = {}): Promise<SealResult> {
  const { root, salt, manifestPath, historyPath, config } = loadConfig(opts.root ?? process.cwd());
  const { gitCommit, branch } = gitMeta(root, opts);
  const issuedAt = opts.issuedAt ?? new Date().toISOString();

  const filesWritten: string[] = [];

  // First-seal mint: a harness claim with no committed expectation gets one
  // now (run once, record hash + full-precision reference vector, persist to
  // proofseal.json). Regenerating an EXISTING expectation stays explicit via
  // `proofseal harness run --update`.
  let configDirty = false;
  for (const c of config.claims) {
    if (c.type !== 'harness' || c.expectedSha256) continue;
    const r = await runHarness({
      name: c.harness || c.id,
      cmd: c.cmd,
      cwd: root,
      seed: c.seed,
      quantizeDecimals: c.quantizeDecimals,
      exclude: c.exclude,
    });
    if (r.hash && r.values) {
      const refRel = normalizeClaimPath(c.referenceVector ?? `proofs/${c.harness || c.id}.reference.json`);
      const refAbs = join(root, refRel);
      mkdirSync(dirname(refAbs), { recursive: true });
      writeFileSync(refAbs, JSON.stringify(r.values) + '\n');
      c.expectedSha256 = r.hash;
      c.referenceVector = refRel;
      c.tolerance = c.tolerance ?? { ...DEFAULT_TOLERANCE };
      configDirty = true;
      filesWritten.push(refRel);
    }
  }
  if (configDirty) {
    saveConfig(root, config);
    filesWritten.push(CONFIG_FILENAME);
  }

  const refreshed = config.claims.map((c) => refreshClaim(root, c));
  const warnings: SealWarning[] = [];
  for (const c of refreshed) {
    if (c.type === 'marker' && !c.missing) {
      const text = readFileSync(join(root, c.file), 'utf8');
      // Whitespace-normalized count, consistent with markerPresent matching.
      const occurrences = markerOccurrences(text, c.marker);
      if (occurrences > 1) {
        warnings.push({ id: c.id, message: `marker appears ${occurrences} times in ${c.file} — choose a more distinctive substring` });
      }
    }
  }

  const claims: Claim[] = refreshed.map((c) => {
    const { missing: _missing, ...clean } = c;
    return clean as Claim;
  });
  const verified = claims.filter((c) => claimVerified(c)).length;
  const missing = refreshed.filter((c) => c.missing).length;

  const manifest: Manifest = {
    schema: SCHEMA_ID,
    issuedAt,
    gitCommit,
    branch,
    salt,
    releases: { ...(config.releases ?? {}), ...(opts.releases ?? {}) },
    summary: { totalClaims: claims.length, verified, missing },
    claims,
    // Sealing environment (premortem #3) — signed with the rest of the
    // manifest so verify can warn about cross-OS hash drift honestly.
    platform: { os: process.platform, arch: process.arch, node: process.versions.node },
  };

  const manifestHash = sha256Hex(canonicalize(manifest));
  const key = deriveKey(gitCommit, salt);
  const signature = signBytes(key.privateKey, Buffer.from(manifestHash, 'hex'));

  const witness: Witness = {
    manifest,
    integrity: {
      manifestHashAlgo: 'sha256',
      manifestHash,
      signatureAlgo: 'ed25519',
      publicKey: key.publicKeyHex,
      signature,
      seedDerivation: SEED_DERIVATION,
    },
  };

  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(witness, null, 2) + '\n');
  filesWritten.push(normalizeClaimPath(relative(root, manifestPath)));
  mkdirSync(dirname(historyPath), { recursive: true });
  const historyEntry = appendHistory(historyPath, manifest, manifestHash);
  filesWritten.push(normalizeClaimPath(relative(root, historyPath)));

  // Premortem R4 (quickstart-verbatim): the checklist must list every file
  // `verify` NEEDS, not just files written THIS run. proofseal.json usually
  // pre-exists (written by init / claim add) yet is often still untracked —
  // following the printed list verbatim then cloning gives verify exit 1
  // MISSING. Check git status for the config + reference vectors; fail-open
  // (no git / odd state → over-list rather than under-list).
  const neededByVerify = new Set<string>([CONFIG_FILENAME]);
  for (const c of config.claims) {
    if (c.type === 'harness' && c.referenceVector) neededByVerify.add(normalizeClaimPath(c.referenceVector));
  }
  for (const rel of neededByVerify) {
    if (filesWritten.includes(rel) || !existsSync(join(root, rel))) continue;
    try {
      const status = execFileSync('git', ['status', '--porcelain', '--', rel], { cwd: root })
        .toString()
        .trim();
      if (status !== '') filesWritten.push(rel);
    } catch {
      filesWritten.push(rel);
    }
  }

  return {
    ok: missing === 0 && verified === claims.length,
    witness,
    manifestPath,
    historyPath,
    historyEntry,
    summary: manifest.summary,
    warnings,
    filesWritten,
  };
}
