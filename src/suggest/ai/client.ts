/**
 * Anthropic API client — the ONLY file in ProofSeal that touches the network
 * or the API key. Every other AI module asks this one for a structured
 * response; nothing else ever sees `process.env.ANTHROPIC_API_KEY`.
 *
 * Iron rule (enforced by tests/unit/ai/import-isolation.test.mjs):
 *   No path from src/manifest/seal.ts, src/manifest/verify.ts,
 *   src/harness/run.ts, or src/harness/normalize.ts may transitively import
 *   this file. If a future PR breaks that, the test fails the build.
 *
 * Honest degradation:
 *   - Missing key            → throws MissingApiKeyError (typed, sentinel).
 *   - Network/HTTP failure   → throws NetworkError with status + body snippet.
 *   - Bad tool_use payload   → throws MalformedResponseError.
 * Callers (propose.ts, ai-suggest source) decide whether to surface the
 * error or downgrade to "0 proposals" — this layer never silently swallows.
 *
 * No SDK dependency on purpose: plain `fetch` keeps the import graph tiny
 * and the boundary obvious.
 */
import { PROPOSE_TOOL_INPUT_SCHEMA } from './schema.js';

export class MissingApiKeyError extends Error {
  constructor() {
    super('ANTHROPIC_API_KEY is not set');
    this.name = 'MissingApiKeyError';
  }
}

export class NetworkError extends Error {
  constructor(message: string, public readonly status?: number, public readonly bodySnippet?: string) {
    super(message);
    this.name = 'NetworkError';
  }
}

export class MalformedResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedResponseError';
  }
}

/** Default Anthropic chat model. Override with AI_PROPOSE_MODEL if needed. */
const DEFAULT_MODEL = 'claude-sonnet-4-5';
const API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

export interface ProposeRequest {
  /** System + user content. The user prompt is built in propose.ts. */
  systemPrompt: string;
  userPrompt: string;
  /** Override default model for tests/experiments. */
  model?: string;
  /** Override max_tokens. Defaults to 4096 (caps runaway responses). */
  maxTokens?: number;
  /**
   * Override fetch — tests inject a stub here so we never need to monkey-patch
   * globalThis. The default is `globalThis.fetch`.
   */
  fetchImpl?: typeof fetch;
}

/** Raw parsed input of the `propose_claims` tool-use call. */
export type RawToolInput = unknown;

/**
 * Issues a forced tool-use call to Anthropic and returns the tool's `input`.
 * Validation against the AiResponseSchema happens in propose.ts — this layer
 * only guarantees we extracted *a* `tool_use.input` object.
 */
export async function callProposeTool(req: ProposeRequest): Promise<RawToolInput> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new MissingApiKeyError();

  const fetchImpl = req.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new NetworkError('fetch is not available in this runtime');
  }

  const body = {
    model: req.model ?? process.env.AI_PROPOSE_MODEL ?? DEFAULT_MODEL,
    max_tokens: req.maxTokens ?? 4096,
    system: req.systemPrompt,
    messages: [{ role: 'user', content: req.userPrompt }],
    tools: [
      {
        name: 'propose_claims',
        description:
          'Propose ProofSeal claims for behaviors that look load-bearing but are not yet sealed. ' +
          'Use needs-human for behaviors whose natural output is not numeric-deterministic.',
        input_schema: PROPOSE_TOOL_INPUT_SCHEMA,
      },
    ],
    tool_choice: { type: 'tool', name: 'propose_claims' },
  };

  let res: Response;
  try {
    res = await fetchImpl(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    // Network unreachable, DNS failure, fetch throwing for any reason.
    throw new NetworkError(`fetch failed: ${(e as Error).message}`);
  }

  if (!res.ok) {
    let snippet = '';
    try {
      snippet = (await res.text()).slice(0, 300);
    } catch {
      /* nothing */
    }
    throw new NetworkError(`Anthropic API ${res.status}`, res.status, snippet);
  }

  let json: any;
  try {
    json = await res.json();
  } catch (e) {
    throw new MalformedResponseError(`response was not JSON: ${(e as Error).message}`);
  }

  // Find the tool_use block. Forced tool_choice should make this present.
  const blocks: any[] = Array.isArray(json?.content) ? json.content : [];
  const toolUse = blocks.find((b) => b && b.type === 'tool_use' && b.name === 'propose_claims');
  if (!toolUse) {
    throw new MalformedResponseError('no propose_claims tool_use block in response');
  }
  if (typeof toolUse.input !== 'object' || toolUse.input === null) {
    throw new MalformedResponseError('tool_use.input was not an object');
  }
  return toolUse.input;
}
