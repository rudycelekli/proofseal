/**
 * proofseal/v1 manifest schema — types + zod validation (ADR-0001 §5.3).
 */
import { z } from 'zod';

export const SCHEMA_ID = 'proofseal/v1';

const Hex64 = z.string().regex(/^[0-9a-f]{64}$/, 'expected 64 lowercase hex chars');
const Hex128 = z.string().regex(/^[0-9a-f]{128}$/, 'expected 128 lowercase hex chars');

export const ToleranceSchema = z.object({
  rtol: z.number().nonnegative(),
  atol: z.number().nonnegative(),
});
export type Tolerance = z.infer<typeof ToleranceSchema>;

const claimBase = {
  id: z.string().min(1),
  desc: z.string().optional(),
};

export const FileHashClaimSchema = z.object({
  ...claimBase,
  type: z.literal('file-hash'),
  file: z.string().min(1),
  /** Computed at seal time; optional in config. */
  sha256: z.string().optional(),
});
export type FileHashClaim = z.infer<typeof FileHashClaimSchema>;

export const MarkerClaimSchema = z.object({
  ...claimBase,
  type: z.literal('marker'),
  file: z.string().min(1),
  marker: z.string().min(1),
  /** Computed at seal time; optional in config. */
  sha256: z.string().optional(),
  markerVerified: z.boolean().optional(),
});
export type MarkerClaim = z.infer<typeof MarkerClaimSchema>;

export const HarnessClaimSchema = z.object({
  ...claimBase,
  type: z.literal('harness'),
  /** Harness name (defaults to claim id when omitted in config). */
  harness: z.string().min(1),
  /** Command spawned with PROOFSEAL_SEED in env. */
  cmd: z.string().min(1),
  seed: z.number().int().optional(),
  quantizeDecimals: z.number().int().min(0).max(15).optional(),
  /** Named output blocks to exclude from hashing (pitfall 6: un-hashable features). */
  exclude: z.array(z.string()).optional(),
  /** Committed expectation — set by `proofseal harness run --update`. */
  expectedSha256: z.string().optional(),
  /** Path (relative to root) to a committed JSON array of reference numbers. */
  referenceVector: z.string().optional(),
  tolerance: ToleranceSchema.optional(),
});
export type HarnessClaim = z.infer<typeof HarnessClaimSchema>;

export const ClaimSchema = z.discriminatedUnion('type', [
  FileHashClaimSchema,
  MarkerClaimSchema,
  HarnessClaimSchema,
]);
export type Claim = z.infer<typeof ClaimSchema>;

export const SummarySchema = z.object({
  totalClaims: z.number().int().nonnegative(),
  verified: z.number().int().nonnegative(),
  missing: z.number().int().nonnegative(),
});
export type ManifestSummary = z.infer<typeof SummarySchema>;

/**
 * Sealing environment (premortem #3: platform honesty). Recorded — and
 * therefore signed — at seal time so verify can warn when the verifying OS
 * differs (built/binary artifact hashes legitimately diverge across OSes).
 */
export const PlatformSchema = z.object({
  os: z.string(),
  arch: z.string(),
  node: z.string(),
});
export type ManifestPlatform = z.infer<typeof PlatformSchema>;

export const ManifestSchema = z.object({
  schema: z.literal(SCHEMA_ID),
  issuedAt: z.string(),
  gitCommit: z.string().regex(/^[0-9a-f]{40}$/),
  branch: z.string(),
  salt: z.string(),
  releases: z.record(z.string()),
  summary: SummarySchema,
  claims: z.array(ClaimSchema),
  /** Optional for backward compat: pre-platform manifests still validate. */
  platform: PlatformSchema.optional(),
});
export type Manifest = z.infer<typeof ManifestSchema>;

export const IntegritySchema = z.object({
  manifestHashAlgo: z.literal('sha256'),
  manifestHash: Hex64,
  signatureAlgo: z.literal('ed25519'),
  publicKey: Hex64,
  signature: Hex128,
  seedDerivation: z.string(),
});
export type Integrity = z.infer<typeof IntegritySchema>;

export const WitnessSchema = z.object({
  manifest: ManifestSchema,
  integrity: IntegritySchema,
});
export type Witness = z.infer<typeof WitnessSchema>;

/** proofseal.json config file shape. */
export const ConfigSchema = z.object({
  schema: z.literal(SCHEMA_ID),
  salt: z.string().optional(),
  manifest: z.string().optional(),
  history: z.string().optional(),
  releases: z.record(z.string()).optional(),
  claims: z.array(ClaimSchema),
});
export type ProofSealConfig = z.infer<typeof ConfigSchema>;

/** Per-claim verification status (ADR §5.6, ported from ruflo verify.mjs). */
export type ClaimStatus = 'pass' | 'drift' | 'regressed' | 'missing';

/** Result of refreshing a claim against the live tree at seal time. */
export type ClaimState = Claim & { missing: boolean };
