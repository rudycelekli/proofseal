/**
 * Zod schema for AI proposal output.
 *
 * The model is forced (via Anthropic tool-use) to call a single tool whose
 * input schema mirrors this. We still re-validate here because:
 *   1. The wire is untrusted — a malformed tool call must not reach the
 *      claim-building path, ever.
 *   2. Field-level caps (id length, marker length) are easier expressed in
 *      zod than in the tool's JSON Schema.
 *
 * Validation pipeline (in propose.ts): malformed items are dropped into a
 * `skipped` array with a reason; nothing is silently swallowed.
 */
import { z } from 'zod';

const ID = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'id must be 1–40 chars, lowercase a-z0-9-, leading alnum');
const DESC = z.string().min(1).max(240);
const REASON = z.string().min(1).max(240);
const CONFIDENCE = z.enum(['low', 'medium', 'high']);
const FILE = z.string().min(1).max(400);

export const HarnessAiProposalSchema = z.object({
  verdict: z.literal('sealable'),
  type: z.literal('harness'),
  id: ID,
  desc: DESC,
  cmd: z.string().min(1).max(600),
  confidence: CONFIDENCE,
  reason: REASON,
});
export type HarnessAiProposal = z.infer<typeof HarnessAiProposalSchema>;

export const MarkerAiProposalSchema = z.object({
  verdict: z.literal('sealable'),
  type: z.literal('marker'),
  id: ID,
  desc: DESC,
  file: FILE,
  marker: z.string().min(10).max(120),
  confidence: CONFIDENCE,
  reason: REASON,
});
export type MarkerAiProposal = z.infer<typeof MarkerAiProposalSchema>;

export const FileHashAiProposalSchema = z.object({
  verdict: z.literal('sealable'),
  type: z.literal('file-hash'),
  id: ID,
  desc: DESC,
  file: FILE,
  confidence: CONFIDENCE,
  reason: REASON,
});
export type FileHashAiProposal = z.infer<typeof FileHashAiProposalSchema>;

export const NeedsHumanProposalSchema = z.object({
  verdict: z.literal('needs-human'),
  target: z.string().min(1).max(400),
  reason: REASON,
});
export type NeedsHumanProposal = z.infer<typeof NeedsHumanProposalSchema>;

export const AiProposalSchema = z.union([
  HarnessAiProposalSchema,
  MarkerAiProposalSchema,
  FileHashAiProposalSchema,
  NeedsHumanProposalSchema,
]);
export type AiProposal = z.infer<typeof AiProposalSchema>;

export const AiResponseSchema = z.object({
  proposals: z.array(AiProposalSchema).max(50), // hard cap; over-cap rows go to skipped
});
export type AiResponse = z.infer<typeof AiResponseSchema>;

/**
 * The JSON Schema given to Anthropic for the forced `propose_claims` tool.
 * Kept in lockstep with the zod schemas above. The model is instructed to
 * emit numeric-deterministic harness commands only; non-numeric behaviors
 * MUST be returned as needs-human, never dressed up as harness.
 */
export const PROPOSE_TOOL_INPUT_SCHEMA = {
  type: 'object',
  required: ['proposals'],
  additionalProperties: false,
  properties: {
    proposals: {
      type: 'array',
      maxItems: 50,
      items: {
        oneOf: [
          {
            type: 'object',
            required: ['verdict', 'type', 'id', 'desc', 'cmd', 'confidence', 'reason'],
            additionalProperties: false,
            properties: {
              verdict: { const: 'sealable' },
              type: { const: 'harness' },
              id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,39}$' },
              desc: { type: 'string', minLength: 1, maxLength: 240 },
              cmd: { type: 'string', minLength: 1, maxLength: 600 },
              confidence: { enum: ['low', 'medium', 'high'] },
              reason: { type: 'string', minLength: 1, maxLength: 240 },
            },
          },
          {
            type: 'object',
            required: ['verdict', 'type', 'id', 'desc', 'file', 'marker', 'confidence', 'reason'],
            additionalProperties: false,
            properties: {
              verdict: { const: 'sealable' },
              type: { const: 'marker' },
              id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,39}$' },
              desc: { type: 'string', minLength: 1, maxLength: 240 },
              file: { type: 'string', minLength: 1, maxLength: 400 },
              marker: { type: 'string', minLength: 10, maxLength: 120 },
              confidence: { enum: ['low', 'medium', 'high'] },
              reason: { type: 'string', minLength: 1, maxLength: 240 },
            },
          },
          {
            type: 'object',
            required: ['verdict', 'type', 'id', 'desc', 'file', 'confidence', 'reason'],
            additionalProperties: false,
            properties: {
              verdict: { const: 'sealable' },
              type: { const: 'file-hash' },
              id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,39}$' },
              desc: { type: 'string', minLength: 1, maxLength: 240 },
              file: { type: 'string', minLength: 1, maxLength: 400 },
              confidence: { enum: ['low', 'medium', 'high'] },
              reason: { type: 'string', minLength: 1, maxLength: 240 },
            },
          },
          {
            type: 'object',
            required: ['verdict', 'target', 'reason'],
            additionalProperties: false,
            properties: {
              verdict: { const: 'needs-human' },
              target: { type: 'string', minLength: 1, maxLength: 400 },
              reason: { type: 'string', minLength: 1, maxLength: 240 },
            },
          },
        ],
      },
    },
  },
} as const;
