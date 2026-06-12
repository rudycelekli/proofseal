// Shared helpers for ProofSeal integration tests.
//
// HARD RULE (ADR-0001 §4.3 / D10, Playbook 2c): tests spawn the REAL CLI
// (`node dist/cli/index.js ...`) and the REAL MCP stdio server. Nothing in
// src/ is ever imported. The only on-disk artifacts tests may read are the
// *contracted* ones: proofseal.json, proofs/manifest.json, proofs/history.jsonl.
import { execFile as execFileCb } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  mkdtemp,
  mkdir,
  rm,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileP = promisify(execFileCb);

export const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
export const CLI = path.join(PROJECT_ROOT, 'dist', 'cli', 'index.js');
export const FIXTURES = path.join(PROJECT_ROOT, 'tests', 'fixtures');

// Skip-with-clear-message contract: the suite must be runnable before the
// build lands, but obviously incomplete.
export const SKIP = existsSync(CLI)
  ? false
  : `SKIPPED — ${CLI} does not exist yet. Run \`npm run build\` first; the integration suite is INCOMPLETE until the CLI is built.`;

// CI must fail LOUD, never skip silently: a missing build in CI means the
// pipeline is broken, and a green run with 0 executed integration tests
// would be a lie. Locally (no CI env var) the skip-with-message contract
// above still applies.
if (SKIP && process.env.CI) {
  throw new Error(`CI=true but the CLI is not built — refusing to skip integration tests. ${SKIP}`);
}

// Distinctive, semantically load-bearing marker (extraction-map §6.11).
export const MARKER = 'PROOFSEAL_WITNESS_FIX_1859_BUBBLES';

// Deterministic environment for every spawned process.
export const baseEnv = {
  ...process.env,
  TZ: 'UTC',
  PROOFSEAL_SEED: '42',
  GIT_AUTHOR_NAME: 'ProofSeal Integration Test',
  GIT_AUTHOR_EMAIL: 'it@proofseal.invalid',
  GIT_COMMITTER_NAME: 'ProofSeal Integration Test',
  GIT_COMMITTER_EMAIL: 'it@proofseal.invalid',
  GIT_CONFIG_NOSYSTEM: '1',
  // Stable, locale-independent output.
  LC_ALL: 'C',
};

/** Run git in a repo dir. Throws on nonzero exit. */
export async function git(cwd, ...args) {
  return execFileP('git', args, { cwd, env: baseEnv });
}

/** Write a map of relPath -> contents under dir, creating parents. */
export async function writeFiles(dir, files) {
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, contents, 'utf8');
  }
}

/** mkdtemp + git init + initial commit of the given files. */
export async function makeTempRepo(files = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'proofseal-it-'));
  await git(dir, 'init', '-q', '-b', 'main');
  await writeFiles(dir, files);
  await git(dir, 'add', '-A');
  await git(dir, 'commit', '-q', '--no-gpg-sign', '-m', 'initial');
  return dir;
}

export async function commitAll(dir, message) {
  await git(dir, 'add', '-A');
  await git(dir, 'commit', '-q', '--no-gpg-sign', '-m', message);
  return headSha(dir);
}

export async function headSha(dir) {
  const { stdout } = await git(dir, 'rev-parse', 'HEAD');
  return stdout.trim();
}

export async function cleanup(dir) {
  if (dir) await rm(dir, { recursive: true, force: true });
}

/**
 * Spawn the real CLI: `node dist/cli/index.js <args...>`.
 * Never uses a shell; never throws on nonzero exit.
 * Returns { code, stdout, stderr }.
 */
export function runCli(args, { cwd, env = {}, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve) => {
    execFileCb(
      process.execPath,
      [CLI, ...args],
      {
        cwd,
        env: { ...baseEnv, ...env },
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        resolve({
          code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
        });
      },
    );
  });
}

/** Extract the JSON document from a --json invocation's stdout. */
export function parseJsonOut(res) {
  const out = res.stdout.trim();
  try {
    return JSON.parse(out);
  } catch {
    const start = out.indexOf('{');
    const end = out.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
      throw new Error(
        `expected JSON on stdout, got (code=${res.code}):\n` +
          `stdout: ${res.stdout}\nstderr: ${res.stderr}`,
      );
    }
    return JSON.parse(out.slice(start, end + 1));
  }
}

/**
 * `proofseal claim add` flag mapping in ONE place so an implementer flag
 * rename is a one-line fix here. Assumed surface (ADR §4.1 does not pin
 * flag names — flagged as a contract ambiguity in the test report):
 *   claim add --id <id> --type <file-hash|marker|harness> --desc <s>
 *             [--file <p>] [--marker <s>]
 *             [--name <s>] [--cmd <s>] [--seed <n>] [--quantize-decimals <n>]
 */
export async function claimAdd(dir, c) {
  const args = ['claim', 'add', '--id', c.id, '--type', c.type];
  args.push('--desc', c.desc ?? c.id);
  if (c.file) args.push('--file', c.file);
  if (c.marker) args.push('--marker', c.marker);
  if (c.name) args.push('--name', c.name);
  if (c.cmd) args.push('--cmd', c.cmd);
  if (c.seed != null) args.push('--seed', String(c.seed));
  if (c.quantizeDecimals != null) {
    args.push('--quantize-decimals', String(c.quantizeDecimals));
  }
  return runCli(args, { cwd: dir });
}

/** Assert-style helper: throw with full CLI output context. */
export function expectExit(res, code, label) {
  if (res.code !== code) {
    throw new Error(
      `${label}: expected exit ${code}, got ${res.code}\n` +
        `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`,
    );
  }
  return res;
}

/**
 * Standard sealed fixture: temp git repo with
 *   - file-hash claim `util-hash`   on src/util.js
 *   - marker claim    `feature-marker` (MARKER) on src/feature.js
 * after init -> claim add x2 -> commit -> seal (exit 0).
 */
export async function sealedFixture({ commitProofs = false } = {}) {
  const dir = await makeTempRepo({
    'src/feature.js':
      'export function feature() { return 42; }\n' + `// fix: ${MARKER}\n`,
    'src/util.js': 'export const util = 1;\n',
  });
  expectExit(await runCli(['init'], { cwd: dir }), 0, 'init');
  expectExit(
    await claimAdd(dir, {
      id: 'util-hash',
      type: 'file-hash',
      file: 'src/util.js',
      desc: 'util file integrity',
    }),
    0,
    'claim add util-hash',
  );
  expectExit(
    await claimAdd(dir, {
      id: 'feature-marker',
      type: 'marker',
      file: 'src/feature.js',
      marker: MARKER,
      desc: 'feature fix marker present',
    }),
    0,
    'claim add feature-marker',
  );
  await commitAll(dir, 'add proofseal claims');
  expectExit(await runCli(['seal'], { cwd: dir }), 0, 'seal');
  if (commitProofs) await commitAll(dir, 'seal manifest');
  return dir;
}

export async function readManifest(dir) {
  return JSON.parse(
    await readFile(path.join(dir, 'proofs', 'manifest.json'), 'utf8'),
  );
}

export async function writeManifest(dir, obj) {
  await writeFile(
    path.join(dir, 'proofs', 'manifest.json'),
    JSON.stringify(obj, null, 2) + '\n',
    'utf8',
  );
}

export async function readHistoryLines(dir) {
  const raw = await readFile(
    path.join(dir, 'proofs', 'history.jsonl'),
    'utf8',
  );
  return raw
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

/** Find a per-claim result by id in a verify --json payload. */
export function resultById(verifyJson, id) {
  const results = verifyJson.results ?? [];
  return results.find((r) => r.id === id);
}

/** Flip one hex nibble at index i of a lowercase hex string. */
export function flipHexNibble(hex, i = 0) {
  const c = hex[i];
  const replacement = c === '0' ? '1' : '0';
  return hex.slice(0, i) + replacement + hex.slice(i + 1);
}
