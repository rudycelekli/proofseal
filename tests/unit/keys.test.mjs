import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveKey, signBytes, verifyBytes, SEED_DERIVATION } from '../../dist/index.js';

const COMMIT = 'a'.repeat(40);
const SALT = 'proofseal-test';

test('deriveKey: golden vector (fixed commit+salt → fixed seed + pubkey)', () => {
  const key = deriveKey(COMMIT, SALT);
  assert.equal(
    key.seed.toString('hex'),
    '11b86ba51c9b944971be1ecb0940d06be6b5c09ade9dbc27e9598019a0655b05',
  );
  assert.equal(
    key.publicKeyHex,
    '860a67af454675ec4b2adaebfb053ed4d9b6f5b6b0bd57e99b9a0bdcf93b5ebd',
  );
  assert.equal(SEED_DERIVATION, "sha256(gitCommit + ':' + salt + ':proofseal/v1')");
});

test('deriveKey: deterministic, salt-sensitive (fork-splice prevention)', () => {
  assert.equal(deriveKey(COMMIT, SALT).publicKeyHex, deriveKey(COMMIT, SALT).publicKeyHex);
  assert.notEqual(deriveKey(COMMIT, SALT).publicKeyHex, deriveKey(COMMIT, 'other-repo').publicKeyHex);
  assert.notEqual(deriveKey('b'.repeat(40), SALT).publicKeyHex, deriveKey(COMMIT, SALT).publicKeyHex);
});

test('sign/verify round trip', () => {
  const key = deriveKey(COMMIT, SALT);
  const msg = Buffer.from('deadbeef'.repeat(8), 'hex');
  const sig = signBytes(key.privateKey, msg);
  assert.match(sig, /^[0-9a-f]{128}$/);
  assert.equal(verifyBytes(key.publicKeyHex, msg, sig), true);
  // Ed25519 signatures are deterministic
  assert.equal(signBytes(key.privateKey, msg), sig);
});

test('tamper detection: message, signature, or pubkey mutation fails', () => {
  const key = deriveKey(COMMIT, SALT);
  const msg = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
  const sig = signBytes(key.privateKey, msg);

  const tamperedMsg = Buffer.from(msg);
  tamperedMsg[0] ^= 0x01;
  assert.equal(verifyBytes(key.publicKeyHex, tamperedMsg, sig), false);

  const flip = (hex, i) =>
    hex.slice(0, i) + (hex[i] === '0' ? '1' : '0') + hex.slice(i + 1);
  assert.equal(verifyBytes(key.publicKeyHex, msg, flip(sig, 3)), false);
  assert.equal(verifyBytes(flip(key.publicKeyHex, 3), msg, sig), false);

  // malformed inputs fail closed, never throw
  assert.equal(verifyBytes('zz', msg, sig), false);
  assert.equal(verifyBytes(key.publicKeyHex, msg, 'nothex'), false);
});
