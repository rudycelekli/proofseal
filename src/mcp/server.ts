/**
 * ProofSeal MCP stdio server (ADR-0001 §4.2) — thin wrappers over the
 * library API. Every tool is fail-open: a broken repo returns
 * {ok:false, warn:true, error, hint} instead of killing the agent session.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { seal } from '../manifest/seal.js';
import { verify, toVerifyJson, classifyFileClaim, type ClaimResult } from '../manifest/verify.js';
import { loadHistory } from '../history/jsonl.js';
import { fixTimeline, findRegressionIntroductions } from '../history/queries.js';
import { enrichRegressionsWithGit } from '../history/gitinfo.js';
import { runHarness } from '../harness/run.js';
import { loadConfig } from '../config.js';
import { readFileSync } from 'node:fs';
import type { Witness, HarnessClaim } from '../manifest/schema.js';

type ToolText = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
};

/** Contract §6: structuredContent is primary; JSON mirrored into content[0].text. */
function asText(data: unknown): ToolText {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent: data as Record<string, unknown>,
  };
}

/** Fail-open wrapper (RuView rvagent convention). */
async function failOpen(hint: string, fn: () => Promise<unknown> | unknown): Promise<ToolText> {
  try {
    return asText(await fn());
  } catch (e) {
    return asText({ ok: false, warn: true, error: (e as Error).message, hint });
  }
}

/**
 * Client-disconnect hygiene: when the MCP client goes away mid-write, the
 * stdio transport surfaces `write EPIPE` (and stdin sees EOF). A vanished
 * client is a normal shutdown, not an error — exit 0 quietly. Anything that
 * is NOT an EPIPE still crashes loudly (stack to stderr, exit 1) so real
 * bugs are never swallowed.
 */
function installStdioShutdownHandlers(): void {
  const isEpipe = (err: unknown): boolean =>
    (err as NodeJS.ErrnoException | undefined)?.code === 'EPIPE';

  process.stdout.on('error', (err: NodeJS.ErrnoException) => {
    if (isEpipe(err)) process.exit(0);
    throw err; // escalates to the uncaughtException guard below
  });
  process.stdin.on('error', (err: NodeJS.ErrnoException) => {
    if (isEpipe(err) || err.code === 'EOF') process.exit(0);
    throw err;
  });
  // stdin EOF = client closed the session: drain queued stdout, then exit 0.
  process.stdin.on('end', () => {
    process.stdout.write('', () => process.exit(0));
  });
  // Narrow guard: ONLY EPIPE exits quietly. Every other uncaught error keeps
  // the default fatal semantics (stack trace on stderr, nonzero exit).
  process.on('uncaughtException', (err) => {
    if (isEpipe(err)) process.exit(0);
    console.error(err);
    process.exit(1);
  });
}

export async function startMcpServer(): Promise<void> {
  installStdioShutdownHandlers();
  const server = new McpServer({ name: 'proofseal', version: '0.1.0' });

  server.tool(
    'verify_claims',
    'Verify the sealed ProofSeal manifest against the live tree: integrity-seal triple-check plus per-claim pass/drift/regressed/missing classification. Use when raw Bash (sha256sum, grep) is wrong because it cannot detect manifest tampering or distinguish benign drift from a real regression.',
    { root: z.string().optional(), manifest: z.string().optional() },
    async ({ root, manifest }) =>
      failOpen('run `proofseal init` then `proofseal seal` in the repo', async () => {
        const r = await verify({ root, manifestPath: manifest });
        // verify() never throws on broken repos — surface preconditions in the
        // fail-open shape so agent sessions get {ok:false, warn:true, error, hint}.
        if (r.precondition) {
          return { ok: false, warn: true, error: r.precondition, hint: r.hint ?? '', detail: toVerifyJson(r) };
        }
        return toVerifyJson(r);
      }),
  );

  server.tool(
    'seal_manifest',
    'Refresh all claims against the tree, derive the commit-bound key, seal the manifest, and append a history snapshot. Use when manually editing proofs/manifest.json is wrong because hand-edited manifests always break the seal — resealing is the only legal mutation.',
    { root: z.string().optional() },
    async ({ root }) =>
      failOpen('ensure the repo has proofseal.json (run `proofseal init`) and is a git checkout', async () => {
        const r = await seal({ root });
        return { ok: r.ok, summary: r.summary, manifestPath: r.manifestPath, manifestHash: r.witness.integrity.manifestHash, warnings: r.warnings, filesWritten: r.filesWritten };
      }),
  );

  server.tool(
    'check_drift',
    'Diff the live tree against the latest sealed manifest WITHOUT resealing: reports per-claim pass/drift/regressed/missing only. Use when seal_manifest is wrong because you only want to inspect drift, not mint a new sealed snapshot.',
    { root: z.string().optional(), manifest: z.string().optional() },
    async ({ root, manifest }) =>
      failOpen('seal a manifest first with `proofseal seal`', () => {
        const cfg = loadConfig(root ?? process.cwd());
        const path = manifest ?? cfg.manifestPath;
        const witness = JSON.parse(readFileSync(path, 'utf8')) as Witness;
        const results: ClaimResult[] = witness.manifest.claims
          .filter((c) => c.type !== 'harness')
          .map((c) => classifyFileClaim(cfg.root, c));
        return {
          ok: true,
          summary: {
            pass: results.filter((r) => r.status === 'pass').length,
            drift: results.filter((r) => r.status === 'drift').length,
            regressed: results.filter((r) => r.status === 'regressed').length,
            missing: results.filter((r) => r.status === 'missing').length,
          },
          results,
        };
      }),
  );

  server.tool(
    'claim_history',
    'Status timeline (pass/regressed/absent) for one claim across every sealed snapshot. Use when `git log` is wrong because it shows commits, not whether a specific verified claim held at each seal point.',
    { id: z.string(), root: z.string().optional() },
    async ({ id, root }) =>
      failOpen('no history yet — run `proofseal seal` at least once', () => {
        const cfg = loadConfig(root ?? process.cwd());
        return { ok: true, id, timeline: fixTimeline(loadHistory(cfg.historyPath), id) };
      }),
  );

  server.tool(
    'find_regression',
    'Bisect the JSONL history: for every currently-regressed claim, locate the last-pass snapshot and the snapshot where the regression appeared. Use when `git bisect` is wrong because it needs a runnable predicate per commit; this answers from already-recorded seal snapshots instantly.',
    { root: z.string().optional() },
    async ({ root }) =>
      failOpen('no history yet — run `proofseal seal` at least once', () => {
        const cfg = loadConfig(root ?? process.cwd());
        // Same query code as `proofseal history --bisect`: entries are ordered
        // by issuedAt, and each regression carries reachability/range-width
        // info when git can resolve the recorded SHAs (best-effort).
        return {
          ok: true,
          regressions: enrichRegressionsWithGit(
            cfg.root,
            findRegressionIntroductions(loadHistory(cfg.historyPath)),
          ),
        };
      }),
  );

  server.tool(
    'run_harness',
    'Run a deterministic harness (seeded via PROOFSEAL_SEED), quantize numeric output (round-half-even), hash it, and compare against the committed expectation with an rtol/atol tolerance fallback. Use when plain Bash execution is wrong because raw float output hashes diverge across CPU microarchitectures.',
    { name: z.string(), root: z.string().optional() },
    async ({ name, root }) =>
      failOpen('declare the harness claim in proofseal.json and run `proofseal harness run --update` first', async () => {
        const cfg = loadConfig(root ?? process.cwd());
        const def = cfg.config.claims.find(
          (c): c is HarnessClaim => c.type === 'harness' && (c.harness === name || c.id === name),
        );
        if (!def) throw new Error(`no harness claim named '${name}'`);
        const result = await runHarness({
          name,
          cmd: def.cmd,
          cwd: cfg.root,
          seed: def.seed,
          quantizeDecimals: def.quantizeDecimals,
          exclude: def.exclude,
          expectedSha256: def.expectedSha256,
          referenceVector: def.referenceVector,
          tolerance: def.tolerance,
        });
        const { values: _v, quantized: _q, ...compact } = result;
        return { ok: result.status === 'pass' || result.status === 'drift', result: compact };
      }),
  );

  server.tool(
    'list_claims',
    'List the claims declared in proofseal.json (id, type, target). Use when reading proofseal.json with a file tool is wrong because this validates the schema and resolves defaults.',
    { root: z.string().optional() },
    async ({ root }) =>
      failOpen('run `proofseal init` to create proofseal.json', () => {
        const cfg = loadConfig(root ?? process.cwd());
        return { ok: true, claims: cfg.config.claims };
      }),
  );

  await server.connect(new StdioServerTransport());
}
