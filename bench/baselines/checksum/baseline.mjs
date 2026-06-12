// bench/baselines/checksum/baseline.mjs — B1: the folk solution.
// sha256sum -c SHA256SUMS plus a hand-rolled grep loop for markers (ADR §3.1).
//
// Expressiveness mapping for the 100-claim workload:
//   file-hash → SHA256SUMS covers it (see coverage note below)
//   marker    → one markers.tsv line per marker + grep -F loop in verify.sh
//   harness   → nearest equivalent: hash the harness script file itself
//               (B1 cannot execute-and-compare deterministic output)
//
// Coverage (practitioner-grade): SHA256SUMS is generated over ALL git-tracked
// fixture files (`git ls-files` at the seal point), not just claim-referenced
// files. That is what a practitioner's `sha256sum $(git ls-files) > SHA256SUMS`
// produces, and it is the fair byte-integrity baseline: any byte-level edit or
// deletion of a tracked file is signaled.
//
// Recorded per ADR §3.2: setup step count, setup wall-clock (timed by the
// orchestrator), config LOC (lines the maintainer authors: verify.sh +
// markers.tsv), secrets count (0 — but note: SHA256SUMS is NOT tamper-evident).
import fs from 'node:fs';
import path from 'node:path';
import { run, which, countConfigLoc } from '../../lib/util.mjs';

export const name = 'checksum script';
export const id = 'checksum';

export const capabilities = {
  driftDistinction: false, // any byte change fails; no marker-survives semantics
  history: false,
  bisection: false,
  tamperEvidentManifest: false, // SHA256SUMS can be silently regenerated
};

let shaTool = null;

export async function detect() {
  if (await which('sha256sum')) shaTool = { cmd: 'sha256sum', args: [] };
  else if (await which('shasum')) shaTool = { cmd: 'shasum', args: ['-a', '256'] };
  if (!shaTool) return { available: false, reason: 'neither sha256sum nor shasum on PATH' };
  const v = await run(shaTool.cmd, ['--version']);
  return { available: true, version: v.stdout.split('\n')[0] || shaTool.cmd };
}

export async function setup(workDir, claims) {
  // Step 1 (maintainer authors): markers.tsv — file<TAB>marker per marker claim.
  const markerLines = claims
    .filter((c) => c.type === 'marker')
    .map((c) => `${c.file}\t${c.marker}`);
  fs.writeFileSync(path.join(workDir, 'markers.tsv'), markerLines.join('\n') + '\n');

  // Step 2 (maintainer authors): verify.sh — the folk script.
  const shaLine = `${shaTool.cmd} ${shaTool.args.join(' ')}`.trim();
  const verifySh = [
    '#!/bin/sh',
    '# Folk verification script (bench baseline B1).',
    'set -u',
    'status=0',
    `${shaLine} -c SHA256SUMS >sha.out 2>&1 || status=1`,
    'while IFS="$(printf \'\\t\')" read -r file marker; do',
    '  [ -n "$file" ] || continue',
    '  if [ ! -f "$file" ]; then',
    '    echo "MISSING $file"',
    '    status=1',
    '  elif ! grep -Fq -- "$marker" "$file"; then',
    '    echo "MARKER-GONE $file"',
    '    status=1',
    '  fi',
    'done < markers.tsv',
    'exit $status',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(workDir, 'verify.sh'), verifySh, { mode: 0o755 });

  // Step 3 (command): generate SHA256SUMS over ALL git-tracked fixture files
  // at the seal point (practitioner-grade coverage — the workdir was committed
  // before setup ran, so ls-files returns exactly the fixture tree, never the
  // tool-authored artifacts written above).
  const ls = await run('git', ['ls-files'], { cwd: workDir });
  if (!ls.ok) throw new Error(`git ls-files failed: ${ls.error}`);
  const hashedFiles = ls.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .sort();
  const gen = await run(shaTool.cmd, [...shaTool.args, ...hashedFiles], { cwd: workDir });
  if (!gen.ok) throw new Error(`SHA256SUMS generation failed: ${gen.error}`);
  fs.writeFileSync(path.join(workDir, 'SHA256SUMS'), gen.stdout);

  const configLoc =
    countConfigLoc(verifySh) + markerLines.length; // authored lines (SHA256SUMS is generated)
  return { steps: 3, configLoc, secretsCount: 0 };
}

export async function verify(workDir) {
  const r = await run('sh', ['verify.sh'], { cwd: workDir });
  return { ok: r.ok, code: r.code, ms: r.ms, output: (r.stdout + r.stderr).slice(0, 500) };
}

// B1 has no drift/missing semantics: any problem is a flat failure.
export function classify(verifyResult) {
  return verifyResult.code === 0 ? 'pass' : 'fail';
}

// Class (a) trust-artifact mutation target: SHA256SUMS (flip one hex nibble).
export function trustArtifactPath() {
  return 'SHA256SUMS';
}
