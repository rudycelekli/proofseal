// bench/baselines/intoto/baseline.mjs — B3: in-toto attestation (ADR §3.1).
// Minimal single-step layout: in-toto-run records the tree as products of a
// "seal" step; in-toto-verify checks the layout + link metadata.
//
// Requires the in-toto Python reference implementation (in-toto-run,
// in-toto-verify, in-toto-keygen on PATH, python3 with the in_toto module for
// layout authoring). When absent the orchestrator records an explicit
// "SKIPPED (not installed)" cell — never a silent omission.
//
// Expressiveness mapping: every claimed file becomes an artifact rule
// (ALLOW + MATCH via recorded products). Marker and harness semantics are
// not expressible; recorded as N/A capability cells (ADR D12).
import fs from 'node:fs';
import path from 'node:path';
import { run, which, countConfigLoc } from '../../lib/util.mjs';

export const name = 'in-toto';
export const id = 'intoto';

export const capabilities = {
  driftDistinction: false,
  history: false,
  bisection: false,
  tamperEvidentManifest: true, // layout + links are signed
};

export async function detect() {
  for (const tool of ['in-toto-run', 'in-toto-verify', 'in-toto-keygen']) {
    if (!(await which(tool))) return { available: false, reason: `${tool} not installed` };
  }
  const py = await run('python3', ['-c', 'import in_toto, sys; sys.stdout.write(in_toto.__version__)']);
  if (!py.ok) return { available: false, reason: 'python3 in_toto module not importable (needed for layout authoring)' };
  return { available: true, version: `in-toto ${py.stdout.trim()}` };
}

// Layout authoring helper — written to the workdir and executed via execFile
// (no shell-string interpolation). This is maintainer-authored config.
// Targets the in-toto 1.x reference implementation (Metablock signing,
// in-toto-verify --layout-keys).
//
// Verification design note: in-toto-verify checks recorded link metadata
// against the layout — it does NOT re-hash the live tree by itself. To make
// in-toto actually verify the working tree (the job this bench measures),
// the layout needs an *inspection*: at verify time in-toto re-records the
// cwd as the inspection's materials and applies artifact rules. Rule order
// per claimed file: REQUIRE (deletion detected) → MATCH against the seal
// step's recorded products (consumes only byte-identical files) → DISALLOW
// (a modified file survives MATCH and trips here) → ALLOW * for
// infrastructure files (.git internals, layout, links, keys, scripts).
const LAYOUT_PY = `
from in_toto.models.layout import Layout, Step, Inspection
from in_toto.models.metadata import Metablock
import securesystemslib.interface as interface

key = interface.import_rsa_privatekey_from_file("owner_key")
pub = interface.import_rsa_publickey_from_file("owner_key.pub")
files = [l.strip() for l in open("intoto-files.txt") if l.strip()]
step = Step(name="seal")
step.pubkeys = [pub["keyid"]]
step.expected_products = [["ALLOW", f] for f in files] + [["DISALLOW", "*"]]
insp = Inspection(name="check")
insp.run = ["true"]
insp.expected_materials = (
    [["REQUIRE", f] for f in files]
    + [["MATCH", f, "WITH", "PRODUCTS", "FROM", "seal"] for f in files]
    + [["DISALLOW", f] for f in files]
    + [["ALLOW", "*"]]
)
layout = Layout()
layout.keys = {pub["keyid"]: pub}
layout.steps = [step]
layout.inspect = [insp]
layout.set_relative_expiration(months=12)
mb = Metablock(signed=layout)
mb.sign(key)
mb.dump("root.layout")
print("layout written")
`;

export async function setup(workDir, claims) {
  const files = [...new Set(claims.map((c) => c.file))].sort();
  fs.writeFileSync(path.join(workDir, 'intoto-files.txt'), files.join('\n') + '\n');
  fs.writeFileSync(path.join(workDir, 'make_layout.py'), LAYOUT_PY);

  let steps = 0;
  // Step 1: functionary/owner key generation (key-management ceremony).
  // in-toto 1.x: bare invocation generates an unencrypted RSA key without
  // prompting (-p is a password *prompt* flag there, not a value option).
  const kg = await run('in-toto-keygen', ['owner_key'], { cwd: workDir, timeoutMs: 60000 });
  if (!kg.ok) throw new Error(`in-toto-keygen failed: ${kg.error} ${kg.stderr.slice(0, 200)}`);
  steps += 1;

  // Step 2: author + sign the layout.
  const ly = await run('python3', ['make_layout.py'], { cwd: workDir, timeoutMs: 60000 });
  if (!ly.ok) throw new Error(`layout authoring failed: ${ly.stderr.slice(0, 400)}`);
  steps += 1;

  // Step 3: record the seal step (products = the claimed tree).
  const rec = await run(
    'in-toto-run',
    ['--step-name', 'seal', '--key', 'owner_key', '--products', ...files, '--', 'true'],
    { cwd: workDir, timeoutMs: 300000 },
  );
  if (!rec.ok) throw new Error(`in-toto-run failed: ${rec.stderr.slice(0, 400)}`);
  steps += 1;

  // Step 4: author verify script.
  const verifySh = [
    '#!/bin/sh',
    'set -u',
    'in-toto-verify --layout root.layout --layout-keys owner_key.pub >intoto.out 2>&1',
    'exit $?',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(workDir, 'intoto-verify.sh'), verifySh, { mode: 0o755 });
  steps += 1;

  const configLoc = countConfigLoc(LAYOUT_PY) + files.length + countConfigLoc(verifySh);
  return { steps, configLoc, secretsCount: 1 }; // owner_key private key
}

export async function verify(workDir) {
  const r = await run('sh', ['intoto-verify.sh'], { cwd: workDir, timeoutMs: 300000 });
  let output = (r.stdout + r.stderr).slice(0, 300);
  try {
    output += fs.readFileSync(path.join(workDir, 'intoto.out'), 'utf8').slice(0, 300);
  } catch { /* no capture file */ }
  return { ok: r.ok, code: r.code, ms: r.ms, output };
}

// in-toto has no drift semantics: rule violations are flat failures.
export function classify(verifyResult) {
  return verifyResult.code === 0 ? 'pass' : 'fail';
}

// Class (a) trust-artifact mutation target: the signed link metadata.
export function trustArtifactPath(workDir) {
  const link = fs.readdirSync(workDir).find((f) => f.startsWith('seal.') && f.endsWith('.link'));
  return link || 'root.layout';
}
