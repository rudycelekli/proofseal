// bench/baselines/cosign/baseline.mjs — B2: sigstore cosign (ADR §3.1).
// Two variants, both measured when possible:
//   cosign (keypair) — generate-key-pair + sign-blob/verify-blob per file
//   cosign (keyless) — OIDC mode, gated behind COSIGN_EXPERIMENTAL; requires
//                      an interactive/ambient OIDC identity, so in headless
//                      bench runs it records SKIPPED with the reason unless
//                      the operator exports PROOFKIT_BENCH_COSIGN_KEYLESS=1.
//
// Expressiveness mapping for the 100-claim workload (ADR §3.1: "as closely
// as its model allows"): every claim's file becomes a signed blob. Marker
// and harness semantics are NOT expressible — cosign signs bytes; that gap
// is recorded as N/A capability cells, not hidden (ADR D12).
import fs from 'node:fs';
import path from 'node:path';
import { run, which, countConfigLoc } from '../../lib/util.mjs';

export const capabilities = {
  driftDistinction: false,
  history: false,
  bisection: false,
  tamperEvidentManifest: true, // signatures are tamper-evident vs the public key
};

async function detectCosign() {
  const bin = await which('cosign');
  if (!bin) return { available: false, reason: 'cosign not installed' };
  const v = await run('cosign', ['version']);
  const line = (v.stdout + v.stderr).split('\n').find((l) => /GitVersion|v\d/.test(l)) || 'cosign (version unknown)';
  return { available: true, version: line.trim() };
}

function claimFiles(claims) {
  return [...new Set(claims.map((c) => c.file))].sort();
}

// Pure script-text builder so config LOC is countable with or without
// actually executing cosign (the keyless variant measures statically).
// Offline flags (cosign >= 3.x): --use-signing-config=false,
// --new-bundle-format=false, --tlog-upload=false on sign;
// --insecure-ignore-tlog on keypair verify (no Rekor in the loop — the
// bench is hermetic; the keypair trust model is the local key pair).
function buildScripts(files, keyless) {
  const offlineSign = '--use-signing-config=false --new-bundle-format=false --tlog-upload=false';
  const keyArgsSign = keyless ? '' : `${offlineSign} --key cosign.key`;
  const keyArgsVerify = keyless
    ? '--certificate-identity-regexp .* --certificate-oidc-issuer-regexp .*'
    : '--key cosign.pub --insecure-ignore-tlog';
  const env = keyless ? 'export COSIGN_EXPERIMENTAL=1' : 'export COSIGN_PASSWORD=""';
  const sign = [
    '#!/bin/sh',
    '# cosign sign script (bench baseline B2).',
    'set -eu',
    env,
    'mkdir -p .sigs',
    'while read -r f; do',
    '  sig=".sigs/$(echo "$f" | tr / _).sig"',
    `  cosign sign-blob --yes ${keyArgsSign} --output-signature "$sig" "$f" >/dev/null 2>&1`,
    'done < cosign-files.txt',
    '',
  ].join('\n');
  const verify = [
    '#!/bin/sh',
    '# cosign verify script (bench baseline B2).',
    'set -u',
    env,
    'status=0',
    'while read -r f; do',
    '  sig=".sigs/$(echo "$f" | tr / _).sig"',
    `  if ! cosign verify-blob ${keyArgsVerify} --signature "$sig" "$f" >/dev/null 2>&1; then`,
    '    echo "VERIFY-FAILED $f"',
    '    status=1',
    '  fi',
    'done < cosign-files.txt',
    'exit $status',
    '',
  ].join('\n');
  return { sign, verify, loc: countConfigLoc(sign) + countConfigLoc(verify) };
}

function writeScripts(workDir, files, keyless) {
  // The maintainer-authored artifacts: a files list + sign/verify scripts.
  fs.writeFileSync(path.join(workDir, 'cosign-files.txt'), files.join('\n') + '\n');
  const { sign, verify, loc } = buildScripts(files, keyless);
  fs.writeFileSync(path.join(workDir, 'cosign-sign.sh'), sign, { mode: 0o755 });
  fs.writeFileSync(path.join(workDir, 'cosign-verify.sh'), verify, { mode: 0o755 });
  return loc;
}

function makeVariant(variantId, displayName, keyless) {
  return {
    id: variantId,
    name: displayName,
    capabilities,

    async detect() {
      const base = await detectCosign();
      if (!base.available) return base;
      if (keyless && process.env.PROOFKIT_BENCH_COSIGN_KEYLESS !== '1') {
        // cosign is installed, but keyless signing needs an OIDC identity
        // (interactive browser flow or ambient CI token) — not runnable
        // headless. Setup steps / config LOC / secrets count are still
        // measurable from the procedure itself (static-only column);
        // wall-clock cells become N/A with this reason.
        return {
          available: false,
          staticOnly: true,
          version: base.version,
          naReason: 'requires interactive OIDC',
          reason:
            'keyless signing needs an OIDC identity (interactive browser or ambient CI token); headless run measures setup steps / config LOC / secrets only — set PROOFKIT_BENCH_COSIGN_KEYLESS=1 to opt in to the interactive flow',
        };
      }
      return base;
    },

    // Static-only measurement for the keyless variant (no cosign execution):
    // counts the discrete commands and authored lines of the keyless
    // procedure exactly as setup() would report them after a real run.
    staticSetup(claims) {
      const files = claimFiles(claims);
      const { loc } = buildScripts(files, true);
      // Steps: 1 OIDC login/identity acquisition + 1 sign-blob loop +
      // 1 authoring step (files list + scripts) — same accounting as setup().
      // Secrets: 0 — no long-lived private key; that is keyless's trade:
      // zero secret storage in exchange for an interactive identity ceremony.
      return { steps: 3, configLoc: loc + files.length, secretsCount: 0 };
    },

    async setup(workDir, claims) {
      const files = claimFiles(claims);
      const scriptLoc = writeScripts(workDir, files, keyless);
      let steps = 0;
      let secretsCount = 0;
      if (!keyless) {
        // Step: generate-key-pair (the key-management ceremony being measured).
        const kg = await run('cosign', ['generate-key-pair'], {
          cwd: workDir,
          env: { COSIGN_PASSWORD: '' },
          timeoutMs: 60000,
        });
        if (!kg.ok) throw new Error(`cosign generate-key-pair failed: ${kg.error}`);
        steps += 1;
        secretsCount = 1; // cosign.key (private key + its password are secrets to store/rotate)
      } else {
        steps += 1; // OIDC login / identity acquisition step
      }
      // Step: sign all blobs.
      const sg = await run('sh', ['cosign-sign.sh'], { cwd: workDir, timeoutMs: 600000 });
      if (!sg.ok) throw new Error(`cosign sign-blob loop failed: ${sg.error} ${sg.stderr.slice(0, 300)}`);
      steps += 1;
      // Steps: author files list + scripts (counted as one authoring step).
      steps += 1;
      return { steps, configLoc: scriptLoc + files.length, secretsCount };
    },

    async verify(workDir) {
      const r = await run('sh', ['cosign-verify.sh'], { cwd: workDir, timeoutMs: 600000 });
      return { ok: r.ok, code: r.code, ms: r.ms, output: (r.stdout + r.stderr).slice(0, 500) };
    },

    // cosign has no drift/missing semantics: any problem is a flat failure.
    classify(verifyResult) {
      return verifyResult.code === 0 ? 'pass' : 'fail';
    },

    // Class (a) trust-artifact mutation target: the first signature blob.
    trustArtifactPath(workDir) {
      const sigDir = path.join(workDir, '.sigs');
      if (!fs.existsSync(sigDir)) return null;
      const sigs = fs.readdirSync(sigDir).sort();
      return sigs.length ? path.join('.sigs', sigs[0]) : null;
    },
  };
}

export const keypair = makeVariant('cosign-keypair', 'cosign (keypair)', false);
export const keyless = makeVariant('cosign-keyless', 'cosign (keyless)', true);
