/**
 * Deterministic, commit-bound Ed25519 keys — zero key management.
 *
 *   seed      = sha256(gitCommit + ':' + salt + ':proofseal/v1')
 *   privKey   = PKCS#8(seed)        (node:crypto raw-seed import)
 *   publicKey = SPKI DER last 32 bytes, lowercase hex
 *
 * IMPORTANT (threat model): anyone at the same commit can re-derive the
 * private key. This is tamper-EVIDENCE bound to a git commit, NOT
 * third-party authentication. The salt prevents cross-repo manifest
 * splicing between forks at identical commits.
 */
import {
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  createHash,
  type KeyObject,
} from 'node:crypto';

/** PKCS#8 DER prefix for a raw 32-byte Ed25519 seed. */
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
/** SPKI DER prefix for a raw 32-byte Ed25519 public key. */
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export const SEED_DERIVATION = "sha256(gitCommit + ':' + salt + ':proofseal/v1')";

export interface DerivedKey {
  /** 32-byte raw seed. */
  seed: Buffer;
  /** Raw Ed25519 public key, lowercase hex (64 chars). */
  publicKeyHex: string;
  /** node:crypto private key object, ready for sign(). */
  privateKey: KeyObject;
}

/** Derive the commit-bound Ed25519 keypair for a repo. */
export function deriveKey(gitCommit: string, salt: string): DerivedKey {
  const seed = createHash('sha256')
    .update(`${gitCommit}:${salt}:proofseal/v1`)
    .digest();
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const publicKey = createPublicKey(privateKey);
  const der = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  return {
    seed,
    publicKeyHex: der.subarray(der.length - 32).toString('hex'),
    privateKey,
  };
}

/** Ed25519-sign raw message bytes; returns lowercase hex (128 chars). */
export function signBytes(privateKey: KeyObject, message: Buffer): string {
  return cryptoSign(null, message, privateKey).toString('hex');
}

/** Verify an Ed25519 signature (hex) over raw message bytes with a raw hex pubkey. */
export function verifyBytes(publicKeyHex: string, message: Buffer, signatureHex: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(publicKeyHex)) return false;
  if (!/^[0-9a-f]{128}$/.test(signatureHex)) return false;
  try {
    const publicKey = createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, Buffer.from(publicKeyHex, 'hex')]),
      format: 'der',
      type: 'spki',
    });
    return cryptoVerify(null, message, publicKey, Buffer.from(signatureHex, 'hex'));
  } catch {
    return false;
  }
}
