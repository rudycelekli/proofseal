// Real-key (key-mode) crypto: optional out-of-band Ed25519 signing key turns
// the ornamental derived seal into genuine authentication — but only when the
// verifier pins the pubkey (TOFU). These tests prove: key-mode round-trips,
// tamper is caught, the derived downgrade is detected by both pins, the
// no-pin key-mode warning fires, and malformed keys fail loudly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, createPublicKey } from 'node:crypto';
import {
  seal,
  verify,
  saveConfig,
  loadExternalSigningKey,
  SCHEMA_ID,
} from '../../dist/index.js';

const COMMIT = 'c'.repeat(40);

function freshRepo() {
  const root = mkdtempSync(join(tmpdir(), 'pk-signer-'));
  writeFileSync(join(root, 'target.txt'), 'hello\nFIX-MARKER-42\n');
  saveConfig(root, {
    schema: SCHEMA_ID,
    salt: 'test-salt',
    manifest: 'proofs/manifest.json',
    history: 'proofs/history.jsonl',
    releases: {},
    claims: [{ id: 'm1', type: 'marker', file: 'target.txt', marker: 'FIX-MARKER-42' }],
  });
  return root;
}

/** A real out-of-band Ed25519 seed (64-hex) plus its raw pubkey hex. */
function realKey() {
  const { privateKey } = generateKeyPairSync('ed25519');
  // 32-byte raw seed sits at the tail of the PKCS#8 DER.
  const der = privateKey.export({ format: 'der', type: 'pkcs8' });
  const seedHex = der.subarray(der.length - 32).toString('hex');
  const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  const pubHex = spki.subarray(spki.length - 32).toString('hex');
  return { seedHex, pubHex };
}

async function sealWith(root, env) {
  const saved = {};
  for (const k of ['PROOFSEAL_SIGNING_KEY', 'PROOFSEAL_SIGNING_KEY_FILE']) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try {
    return await seal({ root, gitCommit: COMMIT, branch: 'test' });
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('key-mode: seal with real key → signerMode=key, pubkey is NOT re-derivable', async () => {
  const root = freshRepo();
  const { seedHex, pubHex } = realKey();
  await sealWith(root, { PROOFSEAL_SIGNING_KEY: seedHex });

  const witness = JSON.parse(readFileSync(join(root, 'proofs/manifest.json'), 'utf8'));
  assert.equal(witness.integrity.signerMode, 'key');
  assert.equal(witness.integrity.publicKey, pubHex);

  // verify is green; the seal is valid and the key cannot be re-derived from
  // the manifest (no hybrid-confusion warning).
  const r = await verify({ root });
  assert.equal(r.ok, true);
  assert.equal(r.signature.signerMode, 'key');
  assert.equal(r.signature.signatureValid, true);
  assert.equal(r.signature.manifestHashOk, true);
});

test('key-mode + --pubkey pin: matching pin passes, wrong pin → exit 1', async () => {
  const root = freshRepo();
  const { seedHex, pubHex } = realKey();
  await sealWith(root, { PROOFSEAL_SIGNING_KEY: seedHex });

  const good = await verify({ root, pinnedPublicKey: pubHex });
  assert.equal(good.ok, true);
  assert.equal(good.exitCode, 0);

  const wrong = 'd'.repeat(64);
  const bad = await verify({ root, pinnedPublicKey: wrong });
  assert.equal(bad.ok, false);
  assert.equal(bad.exitCode, 1);
});

test('key-mode: single-byte manifest tamper → invalid', async () => {
  const root = freshRepo();
  const { seedHex } = realKey();
  await sealWith(root, { PROOFSEAL_SIGNING_KEY: seedHex });

  const mPath = join(root, 'proofs/manifest.json');
  const doc = JSON.parse(readFileSync(mPath, 'utf8'));
  doc.manifest.claims[0].marker = 'FIX-MARKER-43';
  writeFileSync(mPath, JSON.stringify(doc, null, 2) + '\n');

  const r = await verify({ root });
  assert.equal(r.ok, false);
  assert.equal(r.signature.manifestHashOk, false);
});

test('downgrade defense: derived seal fails --require-signed AND --pubkey', async () => {
  const root = freshRepo();
  // No env key → derived mode (the ornamental default).
  await sealWith(root, {});
  const witness = JSON.parse(readFileSync(join(root, 'proofs/manifest.json'), 'utf8'));
  assert.equal(witness.integrity.signerMode, 'derived');

  // Plain verify is still ok (derived is the documented default).
  assert.equal((await verify({ root })).ok, true);

  // --require-signed refuses the derived seal.
  const rs = await verify({ root, requireSigned: true });
  assert.equal(rs.ok, false);
  assert.equal(rs.exitCode, 1);

  // --pubkey (pinning ANY real key) also refuses it: the derived pubkey can
  // never equal a pinned external key.
  const pin = await verify({ root, pinnedPublicKey: 'e'.repeat(64) });
  assert.equal(pin.ok, false);
  assert.equal(pin.exitCode, 1);
});

test('hybrid-confusion: key-mode but pubkey re-derivable → warning', async () => {
  const root = freshRepo();
  await sealWith(root, {});
  // Forge a manifest that CLAIMS key-mode but keeps the re-derivable derived
  // pubkey. We do not re-sign correctly; we only assert the warning fires so a
  // verifier is told this is NOT externally authenticated.
  const mPath = join(root, 'proofs/manifest.json');
  const doc = JSON.parse(readFileSync(mPath, 'utf8'));
  doc.integrity.signerMode = 'key';
  writeFileSync(mPath, JSON.stringify(doc, null, 2) + '\n');

  const r = await verify({ root });
  assert.match(r.signature.warning ?? '', /re-deriv|not.*authenticat/i);
});

test('loadExternalSigningKey: absent → null; malformed seed → throws', () => {
  assert.equal(loadExternalSigningKey({}), null);
  assert.throws(
    () => loadExternalSigningKey({ PROOFSEAL_SIGNING_KEY: 'not-64-hex' }),
    /32-byte Ed25519 seed/,
  );
});

test('loadExternalSigningKey: non-Ed25519 key file → throws', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' });
  const dir = mkdtempSync(join(tmpdir(), 'pk-rsa-'));
  const file = join(dir, 'rsa.pem');
  writeFileSync(file, pem);
  assert.throws(
    () => loadExternalSigningKey({ PROOFSEAL_SIGNING_KEY_FILE: file }),
    /must be an Ed25519 key/,
  );
});

test('loadExternalSigningKey: valid Ed25519 PEM file → loads, pubkey matches', () => {
  const { privateKey } = generateKeyPairSync('ed25519');
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' });
  const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  const pubHex = spki.subarray(spki.length - 32).toString('hex');
  const dir = mkdtempSync(join(tmpdir(), 'pk-ed-'));
  const file = join(dir, 'ed.pem');
  writeFileSync(file, pem);
  const loaded = loadExternalSigningKey({ PROOFSEAL_SIGNING_KEY_FILE: file });
  assert.equal(loaded.publicKeyHex, pubHex);
});
