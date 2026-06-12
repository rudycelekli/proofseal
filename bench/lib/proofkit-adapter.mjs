// bench/lib/proofkit-adapter.mjs — drives ProofKit through its REAL CLI
// endpoints only (Playbook rule 2c; ADR §4.1), never internals.
//
// ProofKit may not be built yet (it is developed in parallel). detect()
// degrades gracefully: when dist/cli/index.js is absent, the orchestrator
// emits a report marked INCOMPLETE with the ProofKit column pending.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, countConfigLoc } from './util.mjs';

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));
const BENCH_DIR = path.dirname(LIB_DIR);

export const name = 'ProofSeal'; // display string only; internal id stays 'proofkit'
export const id = 'proofkit';

export const capabilities = {
  driftDistinction: true, // pass/drift/regressed/missing (ADR §5.6)
  history: true, // proofs/history.jsonl + `proofkit history`
  bisection: true, // `proofkit history --bisect`
  tamperEvidentManifest: true, // commit-bound Ed25519 (ADR §5.4)
};

function cliCandidates() {
  return [
    path.resolve(BENCH_DIR, '..', 'dist', 'cli', 'index.js'), // proofkit/dist/cli/index.js
    path.resolve(BENCH_DIR, '..', '..', 'dist', 'cli', 'index.js'), // ../../dist fallback
  ];
}

let cliPath = null;

export async function detect() {
  cliPath = cliCandidates().find((p) => fs.existsSync(p)) || null;
  if (!cliPath) {
    return {
      available: false,
      reason: `ProofKit not built — none of [${cliCandidates().join(', ')}] exists. Run \`npm run build\` in the project root, then re-run the bench.`,
    };
  }
  const v = await run('node', [cliPath, '--version']);
  return { available: true, version: `proofkit ${v.ok ? v.stdout.trim() : '(version unknown)'}` };
}

function cli(args, workDir, extraEnv = {}) {
  return run('node', [cliPath, ...args], { cwd: workDir, env: extraEnv, timeoutMs: 120000 });
}

// The CLI is developed in parallel with this bench; probe the real help text
// once per run for the decimals flag spelling instead of hardcoding it.
let decimalsFlag = null;
async function detectDecimalsFlag(workDir) {
  if (decimalsFlag) return decimalsFlag;
  const help = await run('node', [cliPath, 'claim', 'add', '--help'], { cwd: workDir });
  const text = help.stdout + help.stderr;
  decimalsFlag = text.includes('--quantize-decimals') ? '--quantize-decimals' : '--decimals';
  return decimalsFlag;
}

export async function setup(workDir, claims) {
  let steps = 0;

  // Step 1: scaffold (ADR §4.1: `proofkit init` — idempotent).
  const init = await cli(['init'], workDir);
  if (init.code === 2 || (!init.ok && init.code !== 0)) {
    throw new Error(`proofkit init failed (exit ${init.code}): ${(init.stderr || init.stdout).slice(0, 400)}`);
  }
  steps += 1;

  // init plants a sample claim; remove it so the sealed manifest carries
  // exactly the 100 bench claims (tolerated if the id ever changes).
  await cli(['claim', 'rm', 'sample-config-schema'], workDir);

  // Step 2: register the 100 claims via the real `claim add` endpoint.
  for (const c of claims) {
    const args = ['claim', 'add', '--type', c.type, '--id', c.id, '--desc', c.desc];
    if (c.file) args.push('--file', c.file);
    if (c.type === 'marker') args.push('--marker', c.marker);
    if (c.type === 'harness') {
      args.push('--cmd', c.cmd, '--seed', String(c.seed), await detectDecimalsFlag(workDir), String(c.quantizeDecimals));
    }
    const r = await cli(args, workDir);
    if (!r.ok) {
      throw new Error(`proofkit claim add ${c.id} failed (exit ${r.code}): ${(r.stderr || r.stdout).slice(0, 400)}`);
    }
  }
  steps += 1; // one scripted step from the maintainer's perspective

  // Harness claims need a reviewed expectation recorded before sealing
  // (`harness run <id> --update` — ADR §4.1). One step if any harness claims.
  const harnessClaims = claims.filter((c) => c.type === 'harness');
  for (const c of harnessClaims) {
    const hr = await cli(['harness', 'run', c.id, '--update'], workDir);
    if (!hr.ok) {
      throw new Error(`proofkit harness run ${c.id} --update failed (exit ${hr.code}): ${(hr.stderr || hr.stdout).slice(0, 400)}`);
    }
  }
  if (harnessClaims.length) steps += 1;

  // Commit the authored config so the seal point (HEAD) covers it — keys are
  // commit-bound (ADR §5.4). Failure tolerated: seal may allow a dirty tree.
  const cfgArgs = ['-c', 'user.email=bench@proofkit.invalid', '-c', 'user.name=proofkit-bench', '-c', 'commit.gpgsign=false'];
  await run('git', [...cfgArgs, 'add', '-A'], { cwd: workDir });
  await run('git', [...cfgArgs, 'commit', '-q', '-m', 'proofkit config'], { cwd: workDir });

  // Step 3: seal (refresh claims, derive commit-bound key, sign, history).
  const seal = await cli(['seal'], workDir);
  if (!seal.ok) {
    throw new Error(`proofkit seal failed (exit ${seal.code}): ${(seal.stderr || seal.stdout).slice(0, 400)}`);
  }
  steps += 1;

  // Config LOC: lines the maintainer must AUTHOR (ADR §3.2.3) — the claims
  // array is CLI-managed (`claim add`), counted as setup steps, not authored
  // LOC, exactly as checksum's generated SHA256SUMS is excluded there.
  // Sub-claim C1 budget: <= 15 authored LOC. Secrets: by design 0 — verified
  // statically (sub-claim C2): no key-material files may exist in the tree.
  let configLoc = 0;
  // Config file name changed during the ProofKit→ProofSeal rename; accept both.
  const cfgPath = ['proofseal.json', 'proofkit.json']
    .map((f) => path.join(workDir, f))
    .find((p) => fs.existsSync(p));
  if (cfgPath) {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    delete cfg.claims;
    configLoc = countConfigLoc(JSON.stringify(cfg, null, 2));
  }

  const secretPatterns = /(\.key|\.pem|cosign\.key|id_ed25519|secret)/i;
  const secretFiles = fs.readdirSync(workDir).filter((f) => secretPatterns.test(f));
  return { steps, configLoc, secretsCount: secretFiles.length, secretFiles };
}

export async function verify(workDir) {
  const r = await cli(['verify', '--json'], workDir);
  // Full stdout is kept: classify() must parse the complete JSON envelope.
  // The orchestrator truncates for report display, not here.
  return { ok: r.ok, code: r.code, ms: r.ms, output: r.stdout, stderr: r.stderr.slice(0, 400) };
}

// Map the verify exit-code contract + JSON to the observed classification
// (ADR §5.6): 0 = pass/drift (drift reported in JSON), 1 = regressed/missing/
// bad-signature, 2 = precondition.
export function classify(verifyResult) {
  let parsed = null;
  try {
    parsed = JSON.parse(verifyResult.output);
  } catch { /* non-JSON output tolerated */ }
  const summary = parsed?.summary || parsed?.manifest?.summary || {};
  const results = Array.isArray(parsed?.results) ? parsed.results : [];
  const statuses = new Set(results.map((r) => r.status));

  if (verifyResult.code === 0) {
    if ((summary.drift && summary.drift > 0) || statuses.has('drift')) return 'drift';
    return 'pass';
  }
  if (verifyResult.code === 1) {
    const sig = parsed?.signature;
    if (sig && (sig.signatureValid === false || sig.manifestHashOk === false || sig.publicKeyReproducible === false || sig.valid === false)) {
      return 'fail'; // tampered manifest / bad signature
    }
    if ((summary.missing && summary.missing > 0) || statuses.has('missing')) {
      // missing only, no regression → 'missing'; regression present → 'fail'
      if (!statuses.has('regressed') && !(summary.regressed > 0)) return 'missing';
    }
    return 'fail';
  }
  return 'precondition';
}

// Class (a) trust-artifact: the sealed manifest, mutated per-field by the
// orchestrator (signature hex / claim sha256 / summary counts / manifestHash).
export function trustArtifactPath() {
  return path.join('proofs', 'manifest.json');
}
