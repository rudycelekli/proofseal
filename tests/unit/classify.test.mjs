import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyFileClaim,
  refreshClaim,
  seal,
  verify,
  saveConfig,
  fileSha256,
  SCHEMA_ID,
} from '../../dist/index.js';

const COMMIT = 'a'.repeat(40);

function freshRepo(claims) {
  const root = mkdtempSync(join(tmpdir(), 'pk-classify-'));
  writeFileSync(join(root, 'target.txt'), 'hello world\nFIX-MARKER-42 applied\n');
  saveConfig(root, {
    schema: SCHEMA_ID,
    salt: 'test-salt',
    manifest: 'proofs/manifest.json',
    history: 'proofs/history.jsonl',
    releases: {},
    claims,
  });
  return root;
}

test('drift classifier truth table: marker claims (all 4 statuses)', () => {
  const root = freshRepo([]);
  const abs = join(root, 'target.txt');
  const sealed = {
    id: 'm1',
    type: 'marker',
    file: 'target.txt',
    marker: 'FIX-MARKER-42',
    sha256: fileSha256(abs),
    markerVerified: true,
  };

  // pass: hash matches AND marker present
  assert.equal(classifyFileClaim(root, sealed).status, 'pass');

  // drift: marker present, hash changed
  writeFileSync(abs, 'edited\nFIX-MARKER-42 applied\nmore\n');
  const drift = classifyFileClaim(root, sealed);
  assert.equal(drift.status, 'drift');
  assert.equal(drift.markerPresent, true);
  assert.equal(drift.sha256Match, false);

  // regressed: marker gone
  writeFileSync(abs, 'marker removed entirely\n');
  assert.equal(classifyFileClaim(root, sealed).status, 'regressed');

  // missing: file gone
  rmSync(abs);
  assert.equal(classifyFileClaim(root, sealed).status, 'missing');
});

test('drift classifier: file-hash claims (hash IS the expectation)', () => {
  const root = freshRepo([]);
  const abs = join(root, 'target.txt');
  const sealed = { id: 'f1', type: 'file-hash', file: 'target.txt', sha256: fileSha256(abs) };
  assert.equal(classifyFileClaim(root, sealed).status, 'pass');
  writeFileSync(abs, 'mutated\n');
  assert.equal(classifyFileClaim(root, sealed).status, 'regressed');
  rmSync(abs);
  assert.equal(classifyFileClaim(root, sealed).status, 'missing');
});

test('refreshClaim: computes sha256 + markerVerified; flags missing', () => {
  const root = freshRepo([]);
  const ok = refreshClaim(root, { id: 'm', type: 'marker', file: 'target.txt', marker: 'FIX-MARKER-42' });
  assert.equal(ok.missing, false);
  assert.equal(ok.markerVerified, true);
  assert.match(ok.sha256, /^[0-9a-f]{64}$/);
  const gone = refreshClaim(root, { id: 'g', type: 'marker', file: 'nope.txt', marker: 'x' });
  assert.equal(gone.missing, true);
  assert.equal(gone.markerVerified, false);
  const h = refreshClaim(root, { id: 'h', type: 'harness', harness: 'h', cmd: 'node x' });
  assert.equal(h.missing, false);
  assert.equal(h.seed, 42);
  assert.equal(h.quantizeDecimals, 6);
});

test('end-to-end: seal → verify ok; single-byte manifest tamper → exit 1', async () => {
  const root = freshRepo([
    { id: 'm1', type: 'marker', file: 'target.txt', marker: 'FIX-MARKER-42', desc: 'fix present' },
    { id: 'f1', type: 'file-hash', file: 'target.txt' },
  ]);
  const sealed = await seal({ root, gitCommit: COMMIT, branch: 'test' });
  assert.equal(sealed.ok, true);
  assert.equal(sealed.summary.totalClaims, 2);
  assert.equal(sealed.summary.verified, 2);

  const good = await verify({ root });
  assert.equal(good.ok, true);
  assert.equal(good.exitCode, 0);
  assert.deepEqual(good.signature, {
    manifestHashOk: true,
    publicKeyReproducible: true,
    signatureValid: true,
    publicKey: good.signature.publicKey,
    signerMode: 'derived',
    guarantee: good.signature.guarantee,
  });
  assert.match(good.signature.publicKey, /^[0-9a-f]{64}$/);
  assert.equal(good.summary.pass, 2);

  // tamper one byte inside the manifest's claims (C4: total tamper detection)
  const mPath = join(root, 'proofs/manifest.json');
  const doc = JSON.parse(readFileSync(mPath, 'utf8'));
  doc.manifest.claims[0].desc = 'fix presenT';
  writeFileSync(mPath, JSON.stringify(doc, null, 2) + '\n');
  const bad = await verify({ root });
  assert.equal(bad.ok, false);
  assert.equal(bad.exitCode, 1);
  assert.equal(bad.signature.manifestHashOk, false);
});

test('end-to-end: drift is non-fatal (exit 0), regression is fatal (exit 1)', async () => {
  const root = freshRepo([{ id: 'm1', type: 'marker', file: 'target.txt', marker: 'FIX-MARKER-42' }]);
  await seal({ root, gitCommit: COMMIT, branch: 'test' });

  writeFileSync(join(root, 'target.txt'), 'rebuilt file, FIX-MARKER-42 survives\n');
  const drifted = await verify({ root });
  assert.equal(drifted.ok, true);
  assert.equal(drifted.exitCode, 0);
  assert.equal(drifted.summary.drift, 1);

  writeFileSync(join(root, 'target.txt'), 'fix reverted\n');
  const regressed = await verify({ root });
  assert.equal(regressed.ok, false);
  assert.equal(regressed.exitCode, 1);
  assert.equal(regressed.summary.regressed, 1);
});

test('precondition (exit 2): all claims missing + manifest references dist/', async () => {
  const root = freshRepo([]);
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(join(root, 'dist/index.js'), 'export {};\n');
  saveConfig(root, {
    schema: SCHEMA_ID,
    salt: 'test-salt',
    claims: [{ id: 'd1', type: 'file-hash', file: 'dist/index.js' }],
  });
  await seal({ root, gitCommit: COMMIT, branch: 'test' });

  rmSync(join(root, 'dist'), { recursive: true });
  const result = await verify({ root });
  assert.equal(result.exitCode, 2);
  assert.equal(result.precondition, 'dist-not-built');
  assert.match(result.hint, /npm ci && npm run build/);
});

test('precondition (exit 2): manifest not found', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pk-empty-'));
  const result = await verify({ root });
  assert.equal(result.exitCode, 2);
  assert.equal(result.precondition, 'manifest-not-found');
});
