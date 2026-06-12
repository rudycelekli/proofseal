// Platform honesty (premortem #3): seal records the environment; verify
// warns (never fails) on an OS mismatch; pre-platform manifests stay silent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  seal,
  verify,
  toVerifyJson,
  saveConfig,
  canonicalize,
  sha256Hex,
  deriveKey,
  signBytes,
  SCHEMA_ID,
} from '../../dist/index.js';

const COMMIT = 'b'.repeat(40);

async function sealedRepo() {
  const root = mkdtempSync(join(tmpdir(), 'pk-platform-'));
  writeFileSync(join(root, 'target.txt'), 'hello\nFIX-MARKER-42\n');
  saveConfig(root, {
    schema: SCHEMA_ID,
    salt: 'test-salt',
    manifest: 'proofs/manifest.json',
    history: 'proofs/history.jsonl',
    releases: {},
    claims: [{ id: 'm1', type: 'marker', file: 'target.txt', marker: 'FIX-MARKER-42' }],
  });
  await seal({ root, gitCommit: COMMIT, branch: 'test' });
  return root;
}

test('seal records the sealing environment (signed platform block)', async () => {
  const root = await sealedRepo();
  const witness = JSON.parse(readFileSync(join(root, 'proofs/manifest.json'), 'utf8'));
  assert.deepEqual(witness.manifest.platform, {
    os: process.platform,
    arch: process.arch,
    node: process.versions.node,
  });
  // ...and it is covered by the signature: verify is fully green.
  const r = await verify({ root });
  assert.equal(r.ok, true);
  assert.equal(r.signature.manifestHashOk, true);
});

test('verify: same platform ⇒ no platformWarning (in result or pinned JSON)', async () => {
  const root = await sealedRepo();
  const r = await verify({ root });
  assert.equal(r.platformWarning, undefined);
  assert.equal('platformWarning' in toVerifyJson(r), false);
});

test('verify: simulated OS mismatch ⇒ platformWarning, exit code unchanged', async () => {
  const root = await sealedRepo();
  const other = process.platform === 'linux' ? 'darwin' : 'linux';
  const r = await verify({ root, currentPlatform: other });
  assert.equal(r.ok, true, 'warning must not flip ok');
  assert.equal(r.exitCode, 0, 'warning must not change exit-code semantics');
  assert.match(r.platformWarning, new RegExp(`sealed on ${process.platform}, verifying on ${other}`));
  assert.match(r.platformWarning, /platform drift, not tampering/);
  // Pinned JSON gains the additive field, all v1 fields intact.
  const j = toVerifyJson(r);
  assert.equal(j.platformWarning, r.platformWarning);
  for (const k of ['ok', 'signature', 'summary', 'results', 'precondition']) {
    assert.ok(k in j, `pinned v1 field '${k}' must survive`);
  }
});

test('verify: mismatch with a real regression keeps exit 1 + warning', async () => {
  const root = await sealedRepo();
  writeFileSync(join(root, 'target.txt'), 'fix reverted\n');
  const other = process.platform === 'linux' ? 'darwin' : 'linux';
  const r = await verify({ root, currentPlatform: other });
  assert.equal(r.exitCode, 1);
  assert.ok(r.platformWarning);
});

test('backward compat: manifest without platform ⇒ no warning, even cross-OS', async () => {
  const root = await sealedRepo();
  // Strip the platform block and RE-SIGN (a stranger could not do this, but
  // it faithfully reproduces a manifest sealed by a pre-platform ProofKit).
  const mPath = join(root, 'proofs/manifest.json');
  const doc = JSON.parse(readFileSync(mPath, 'utf8'));
  delete doc.manifest.platform;
  const manifestHash = sha256Hex(canonicalize(doc.manifest));
  const key = deriveKey(doc.manifest.gitCommit, doc.manifest.salt);
  doc.integrity.manifestHash = manifestHash;
  doc.integrity.publicKey = key.publicKeyHex;
  doc.integrity.signature = signBytes(key.privateKey, Buffer.from(manifestHash, 'hex'));
  writeFileSync(mPath, JSON.stringify(doc, null, 2) + '\n');

  const r = await verify({ root, currentPlatform: 'definitely-not-this-os' });
  assert.equal(r.ok, true);
  assert.equal(r.platformWarning, undefined);
});
