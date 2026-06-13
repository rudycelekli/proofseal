/**
 * ProofSeal public library API (ADR-0001 §4.3 — published contract).
 * CLI and MCP server are thin wrappers over these exports.
 */
export { canonicalize } from './core/canonical.js';
export { sha256Hex, sha256Bytes, fileSha256, fileSha256CrlfNormalized, fileContains, markerPresent, markerOccurrences } from './core/hash.js';
export { normalizeClaimPath } from './core/paths.js';
export { lintMarker } from './core/marker-lint.js';
export { deriveKey, signBytes, verifyBytes, signingMessage, loadExternalSigningKey, SEED_DERIVATION, type DerivedKey, type ExternalKey } from './keys/derive.js';

export { seal, refreshClaim, type SealOptions, type SealResult, type SealWarning } from './manifest/seal.js';
export {
  verify,
  checkSignature,
  classifyFileClaim,
  toVerifyJson,
  THREAT_MODEL_NOTE,
  CRLF_DETAIL,
  REFERENCE_VECTOR_HINT,
  type VerifyOptions,
  type VerifyResult,
  type VerifyJson,
  type ClaimResult,
  type VerifySummary,
  type SignatureCheck,
} from './manifest/verify.js';
export {
  SCHEMA_ID,
  ClaimSchema,
  ManifestSchema,
  PlatformSchema,
  WitnessSchema,
  ConfigSchema,
  type ManifestPlatform,
  type Claim,
  type ClaimState,
  type ClaimStatus,
  type FileHashClaim,
  type MarkerClaim,
  type HarnessClaim,
  type Manifest,
  type ManifestSummary,
  type Witness,
  type Integrity,
  type Tolerance,
  type ProofSealConfig,
  type SignerMode,
} from './manifest/schema.js';

export {
  loadHistory,
  appendHistory,
  appendVerifyEntry,
  claimVerified,
  isSealEntry,
  isVerifyEntry,
  type HistoryEntry,
  type SealHistoryEntry,
  type VerifyHistoryEntry,
  type HistoryClaimState,
  type AppendVerifyOptions,
} from './history/jsonl.js';
export {
  fixTimeline,
  diffLatest,
  findRegressionIntroductions,
  findStaleClaims,
  findResealedOverBreaks,
  sortByIssuedAt,
  DEFAULT_STALE_COMMITS,
  DEFAULT_STALE_DAYS,
  type TimelinePoint,
  type LatestDiff,
  type RegressionIntroduction,
  type StaleClaim,
  type FindStaleClaimsOptions,
  type ResealedBreak,
  type FindResealedOverBreaksOptions,
} from './history/queries.js';
export {
  enrichRegressionsWithGit,
  UNREACHABLE_TAG,
  type RegressionGitInfo,
  type EnrichedRegression,
} from './history/gitinfo.js';

export {
  runHarness,
  parseNumericOutput,
  type HarnessDef,
  type HarnessResult,
  type HarnessStatus,
} from './harness/run.js';
export {
  roundHalfEven,
  quantizeValues,
  packLEFloat64,
  hashQuantized,
  allClose,
  DEFAULT_DECIMALS,
  DEFAULT_TOLERANCE,
  type AllCloseResult,
} from './harness/quantize.js';

export {
  loadConfig,
  saveConfig,
  defaultConfig,
  CONFIG_FILENAME,
  type ResolvedConfig,
} from './config.js';

export {
  pickMarker,
  makeId,
  suggestForFile,
  type SuggestedClaim,
  type Confidence,
} from './suggest/core.js';
export {
  changedFiles,
  addedLines,
  insideGitRepo,
  type DiffOptions,
} from './suggest/diff.js';
export {
  suggestClaims,
  type SuggestResult,
  type SkippedFile,
} from './suggest/suggest.js';
