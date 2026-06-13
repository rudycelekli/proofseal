/**
 * Deterministic, commit-bound Ed25519 keys — zero key management.
 *
 *   seed      = sha256(gitCommit + ':' + salt + ':proofseal/v1')
 *   privKey   = PKCS#8(seed)        (node:crypto raw-seed import)
 *   publicKey = SPKI DER last 32 bytes, lowercase hex
 *
 * IMPORTANT (threat model): by DEFAULT the signing key is derived entirely
 * from values stored IN the manifest (gitCommit + salt). Anyone holding the
 * manifest can re-derive the private key and re-sign in one line, so the
 * default signature is commit-bound tamper-evidence — it adds no
 * authentication over the sha256 hash it signs, and that hash adds nothing
 * over git (the manifest is a committed file). The real anchor is the git
 * commit. The derived signature buys exactly one thing: the manifest stays
 * self-describing OUTSIDE a git context (tarball, release artifact,
 * fetch-depth:1 clone) while pinned to the commit it sealed. The salt only
 * prevents cross-repo manifest splicing between forks at identical commits.
 *
 * OPTIONAL real authentication: set PROOFSEAL_SIGNING_KEY (a 32-byte Ed25519
 * seed, 64-hex) or PROOFSEAL_SIGNING_KEY_FILE (a PEM/DER private key) at
 * SEAL time. The key is NEVER written to the repo; integrity.signerMode is
 * recorded as 'key'. A key-mode signature is genuine authentication — BUT
 * only if the verifier pins the expected pubkey (`verify --pubkey <hex>`),
 * which is trust-on-first-use, exactly as strong as the channel that
 * delivered the pubkey. Without a pin, an attacker can substitute their own
 * real key; `--require-signed` alone only rules out the naive derived
 * downgrade. See verify.ts for the per-mode guarantee table.
 */
import {
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  createHash,
  type KeyObject,
} from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { SignerMode } from '../manifest/schema.js';

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

/**
 * The bytes that actually get signed. v2 binds signerMode + publicKey INTO
 * the message (not just the manifestHash) so an attacker cannot flip the
 * mode or swap the pubkey field and reuse a signature across modes
 * (adversarial review finding #1). For a derived-mode attacker who controls
 * the whole chain this is defense-in-depth, not a cure — the cure is the
 * verify-time pin (--require-signed / --pubkey). For a key-mode signature it
 * genuinely prevents cross-mode reuse and pubkey-field substitution.
 */
export function signingMessage(manifestHash: string, signerMode: SignerMode, publicKeyHex: string): Buffer {
  return createHash('sha256')
    .update(`proofseal-sig/v2:${manifestHash}:${signerMode}:${publicKeyHex}`)
    .digest();
}

/** An external (real) signing key supplied out-of-band; never stored in the repo. */
export interface ExternalKey {
  publicKeyHex: string;
  privateKey: KeyObject;
}

/**
 * Load a real Ed25519 signing key from the environment, if present:
 *   PROOFSEAL_SIGNING_KEY       — raw 32-byte seed as 64 lowercase-hex chars
 *   PROOFSEAL_SIGNING_KEY_FILE  — path to a PEM or DER PKCS#8 private key
 * Returns null when neither is set (caller falls back to the derived key).
 * Throws on a present-but-malformed key (a misconfigured real key must fail
 * loudly, never silently downgrade to the ornamental derived key).
 */
export function loadExternalSigningKey(env: NodeJS.ProcessEnv = process.env): ExternalKey | null {
  const rawSeed = env.PROOFSEAL_SIGNING_KEY?.trim();
  const keyFile = env.PROOFSEAL_SIGNING_KEY_FILE?.trim();
  if (!rawSeed && !keyFile) return null;

  let privateKey: KeyObject;
  if (rawSeed) {
    if (!/^[0-9a-f]{64}$/i.test(rawSeed)) {
      throw new Error('PROOFSEAL_SIGNING_KEY must be a 32-byte Ed25519 seed as 64 hex chars');
    }
    privateKey = createPrivateKey({
      key: Buffer.concat([PKCS8_PREFIX, Buffer.from(rawSeed, 'hex')]),
      format: 'der',
      type: 'pkcs8',
    });
  } else {
    const buf = readFileSync(keyFile!);
    // Scan the whole buffer, not just the first 32 bytes: a leading comment,
    // BOM, or CRLF must not misclassify a real PEM as DER.
    const text = buf.toString('utf8');
    const isPem = text.includes('-----BEGIN');
    try {
      privateKey = createPrivateKey(
        isPem ? { key: text, format: 'pem' } : { key: buf, format: 'der', type: 'pkcs8' },
      );
    } catch (err) {
      // Convert a raw OpenSSL throw into an actionable, typed error — a tool
      // that sells trust must not greet a standard key with a stack trace.
      throw new Error(
        'PROOFSEAL_SIGNING_KEY_FILE could not be parsed as an unencrypted Ed25519 private key ' +
          `(PEM or DER PKCS#8). Encrypted keys are not supported — decrypt first. (${(err as Error).message})`,
      );
    }
    if (privateKey.asymmetricKeyType !== 'ed25519') {
      throw new Error(`PROOFSEAL_SIGNING_KEY_FILE must be an Ed25519 key, got ${privateKey.asymmetricKeyType}`);
    }
  }
  const der = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }) as Buffer;
  return { publicKeyHex: der.subarray(der.length - 32).toString('hex'), privateKey };
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
