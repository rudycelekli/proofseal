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
  NormalizerSpecSchema,
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
  type NormalizerSpec,
  type NormalizerName,
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
  applyNormalizers,
  canonicalizeNormalizers,
  classifySpan,
  type AppliedNormalizer,
  type NormalizeResult,
} from './harness/normalize.js';
export {
  diagnose,
  type DiagnoseOptions,
  type DiagnoseResult,
  type VaryingSpan,
} from './harness/diagnose.js';

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

// ── AI-assisted suggest (Build 2). Opt-in: nothing here is ever invoked by
// seal / verify / harness paths. Iron rule enforced by
// tests/unit/ai/import-isolation.test.mjs.
export {
  proposeAiClaims,
  MissingApiKeyError,
  NetworkError,
  MalformedResponseError,
  type AcceptedProposal,
  type SkippedProposal,
  type ProposeResult,
  type ProposeOptions,
} from './suggest/ai/propose.js';
export {
  appendPending,
  readPending,
  pendingPath,
  claimAddCommandFor,
  PENDING_SCHEMA,
  PENDING_REL_PATH,
  type PendingFile,
  type PendingProposal,
} from './suggest/ai/pending.js';
export {
  AiResponseSchema,
  AiProposalSchema,
  type AiProposal,
  type AiResponse,
  type NeedsHumanProposal,
} from './suggest/ai/schema.js';

// ── AI failure triage (Build 3). Strict post-processor over an already-
// computed VerifyResult — cannot mutate the verdict. Iron rule enforced by
// the same import-graph BFS test (manifest/verify.ts → suggest/ai/* is forbidden).
export {
  triageVerify,
  renderTriageHuman,
  toTriageJson,
  RESEAL_GATE_NOTICE,
  type TriageAnnotation,
  type TriagedVerifyResult,
  type TriageOptions,
  type TriageCallContext,
  type TriageClassification,
  type TriageRecommendation,
  type TriageConfidence,
  type TriageJsonBlock,
} from './suggest/ai/triage.js';
